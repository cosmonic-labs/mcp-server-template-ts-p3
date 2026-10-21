wit_bindgen::generate!({ path: "../../gen/boundary-wit", world: "driver", generate_all });
use serde_json::json;
use wasi::http::types::{ErrorCode, Fields, Method, Request, Response, Scheme};
struct Driver;
export!(Driver);
fn milliseconds() -> u64 {
    let now = wasi::clocks0_3_0::system_clock::now();
    now.seconds as u64 * 1000 + u64::from(now.nanoseconds) / 1_000_000
}
fn request(method: String, url: String, headers: String, body: String) -> Request {
    let url: http::Uri = url.parse().unwrap();
    let headers: Vec<(String, String)> = serde_json::from_str(&headers).unwrap();
    let headers: Vec<_> = headers
        .into_iter()
        .filter(|(key, _)| !matches!(key.as_str(), "host" | "connection" | "content-length"))
        .map(|(key, value)| (key, value.into_bytes()))
        .collect();
    let fields = Fields::from_list(&headers).unwrap();
    let (mut writer, reader) = wit_stream::new::<u8>();
    wit_bindgen::spawn_local(async move {
        let _ = writer.write_all(body.into_bytes()).await;
    });
    let (trailers, trailers_reader) = wit_future::new(|| Ok(None));
    drop(trailers);
    let (request, completion) = Request::new(fields, Some(reader), trailers_reader, None);
    drop(completion);
    let method = match method.as_str() {
        "GET" => Method::Get,
        "HEAD" => Method::Head,
        "POST" => Method::Post,
        "DELETE" => Method::Delete,
        "OPTIONS" => Method::Options,
        "PUT" => Method::Put,
        "PATCH" => Method::Patch,
        _ => Method::Other(method),
    };
    request.set_method(&method).unwrap();
    request
        .set_scheme(Some(&if url.scheme_str() == Some("https") {
            Scheme::Https
        } else {
            Scheme::Http
        }))
        .unwrap();
    request
        .set_authority(Some(url.authority().unwrap().as_str()))
        .unwrap();
    request
        .set_path_with_query(Some(
            url.path_and_query().map(|p| p.as_str()).unwrap_or("/"),
        ))
        .unwrap();
    request
}
async fn exchange(method: String, url: String, headers: String, body: String) -> String {
    let started = milliseconds();
    let response = wasi::http::handler::handle(request(method, url, headers, body))
        .await
        .unwrap();
    let headers_ms = milliseconds() - started;
    let status = response.get_status_code();
    let headers: Vec<_> = response
        .get_headers()
        .copy_all()
        .into_iter()
        .map(|(k, v)| (k, String::from_utf8(v).unwrap()))
        .collect();
    let (complete, complete_reader) = wit_future::new(|| Ok(()));
    drop(complete);
    let (mut body, trailers) = Response::consume_body(response, complete_reader);
    let mut bytes = Vec::new();
    let mut frames = Vec::new();
    loop {
        let (_, chunk) = body.read(Vec::with_capacity(64 * 1024)).await;
        if chunk.is_empty() {
            break;
        }
        frames
            .push(json!({"ms": milliseconds() - started, "text": String::from_utf8_lossy(&chunk)}));
        bytes.extend_from_slice(&chunk);
    }
    trailers.await.unwrap();
    json!({"status":status,"headers":headers,"headersMs":headers_ms,"frames":frames,"body":String::from_utf8(bytes).unwrap()}).to_string()
}
impl Guest for Driver {
    async fn run() -> String {
        let result = exchange("POST".into(), "http://localhost/mcp".into(), r#"[["content-type","application/json"],["accept","application/json, text/event-stream"]]"#.into(),
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"add","arguments":{"a":2,"b":3}}}"#.into()).await;
        assert!(result.contains("sum"), "{result}");
        result
    }
    async fn exchange(method: String, url: String, headers: String, body: String) -> String {
        exchange(method, url, headers, body).await
    }
    async fn probe(method: String, url: String, headers: String, body: String) -> String {
        exchange(method, url, headers, body).await
    }
    async fn cancel(method: String, url: String, headers: String, body: String) -> String {
        let response = wasi::http::handler::handle(request(method, url, headers, body))
            .await
            .unwrap();
        let (complete, complete_reader) = wit_future::new(|| Err(ErrorCode::ConnectionTerminated));
        let (mut body, trailers) = Response::consume_body(response, complete_reader);
        let mut received = Vec::new();
        loop {
            let (_, chunk) = body.read(Vec::with_capacity(64 * 1024)).await;
            if chunk.is_empty() {
                break;
            }
            received.extend_from_slice(&chunk);
            if String::from_utf8_lossy(&received).contains("notifications/progress") {
                break;
            }
        }
        wasi::clocks0_3_0::monotonic_clock::wait_for(5_000_000).await;
        complete
            .write(Err(ErrorCode::ConnectionTerminated))
            .await
            .expect("response completion reader is alive");
        drop(body);
        drop(trailers);
        wasi::clocks0_3_0::monotonic_clock::wait_for(30_000_000).await;
        exchange(
            "GET".into(),
            "http://localhost/health".into(),
            "[]".into(),
            "".into(),
        )
        .await
    }
    async fn backpressure(method: String, url: String, headers: String, body: String) -> String {
        let response = wasi::http::handler::handle(request(method, url, headers, body))
            .await
            .unwrap();
        wasi::clocks0_3_0::monotonic_clock::wait_for(200_000_000).await;
        let (complete, complete_reader) = wit_future::new(|| Ok(()));
        drop(complete);
        let (body, trailers) = Response::consume_body(response, complete_reader);
        let _ = body.collect().await;
        match trailers.await {
            Err(ErrorCode::ConnectionWriteTimeout) => {
                json!({"tag":"err","val":{"tag":"connection-write-timeout"}}).to_string()
            }
            other => panic!("unexpected response completion: {other:?}"),
        }
    }
}

mod otel {
    wasmtime::component::bindgen!({ path: "../../gen/otel-host-wit", world: "host", imports: { default: trappable } });
}
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use std::future::Future;
use wasmtime::component::{Component, Linker, ResourceTable};
use wasmtime::{Config, Engine, Store};
use wasmtime_wasi::{WasiCtx, WasiCtxView, WasiView};
use wasmtime_wasi_http::{
    Error, RequestOptions, WasiBody, WasiHttpCtx, WasiHttpCtxView, WasiHttpHooks, WasiHttpView,
};

type Completion = Box<dyn Future<Output = Result<(), Error>> + Send>;
type Exchange =
    Box<dyn Future<Output = Result<(http::Response<WasiBody>, Completion), Error>> + Send>;
struct StalledRequest;
impl Drop for StalledRequest {
    fn drop(&mut self) {
        eprintln!("{{\"fixture_event\":\"stalled-canceled\"}}");
    }
}
struct StalledBody {
    sent: bool,
}
impl http_body::Body for StalledBody {
    type Data = Bytes;
    type Error = Error;
    fn poll_frame(
        mut self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<http_body::Frame<Bytes>, Error>>> {
        if self.sent {
            std::task::Poll::Pending
        } else {
            self.sent = true;
            std::task::Poll::Ready(Some(Ok(http_body::Frame::data(Bytes::from_static(
                b"partial",
            )))))
        }
    }
}
impl Drop for StalledBody {
    fn drop(&mut self) {
        eprintln!("{{\"fixture_event\":\"body-canceled\"}}");
    }
}
fn decode_query(value: &str) -> String {
    let mut bytes = Vec::new();
    let mut input = value.as_bytes().iter().copied();
    while let Some(byte) = input.next() {
        bytes.push(match byte {
            b'+' => b' ',
            b'%' => {
                let high = char::from(input.next().unwrap()).to_digit(16).unwrap();
                let low = char::from(input.next().unwrap()).to_digit(16).unwrap();
                (high * 16 + low) as u8
            }
            byte => byte,
        });
    }
    String::from_utf8(bytes).unwrap()
}
struct Fixture;
impl WasiHttpHooks for Fixture {
    fn send_request(
        &mut self,
        request: http::Request<WasiBody>,
        _options: Option<RequestOptions>,
        _done: Completion,
    ) -> Exchange {
        Box::new(async move {
            if !matches!(
                request.uri().host(),
                Some("fixture.test" | "other.fixture.test")
            ) {
                return Err(Error::HttpRequestDenied);
            }
            let (parts, body) = request.into_parts();
            let body = body.collect().await?.to_bytes();
            let headers: serde_json::Map<String, serde_json::Value> = parts
                .headers
                .iter()
                .map(|(k, v)| {
                    (
                        k.to_string(),
                        serde_json::Value::String(v.to_str().unwrap().into()),
                    )
                })
                .collect();
            let mut reply = http::Response::builder()
                .header("content-type", "application/json")
                .header("x-fixture", "true");
            if parts.uri.path() == "/stalled" {
                let _request = StalledRequest;
                std::future::pending::<()>().await;
            }
            if parts.uri.path() == "/delayed" {
                tokio::time::sleep(std::time::Duration::from_millis(80)).await;
            }
            let body = match parts.uri.path() {
                "/redirect-to" => {
                    let params: std::collections::HashMap<_, _> = parts.uri.query().unwrap_or_default()
                        .split('&').filter_map(|part| part.split_once('='))
                        .collect();
                    let status = params.get("status").unwrap().parse::<u16>().unwrap();
                    let location = params.get("location").unwrap();
                    let decoded = decode_query(location);
                    reply = reply.status(status).header("location", decoded.as_str());
                    b"redirect response".to_vec()
                },
                "/redirect" => { reply = reply.status(302).header("location", "/echo"); Vec::new() },
                "/cross-origin" => { reply = reply.status(307).header("location", "https://other.fixture.test/echo"); Vec::new() },
                "/redirect-loop" => { reply = reply.status(302).header("location", "/redirect-loop"); Vec::new() },
                "/private-redirect" => { reply = reply.status(302).header("location", "http://127.0.0.1/internal"); Vec::new() },
                "/multibyte" => "é".repeat(3000).into_bytes(),
                "/oversized" => vec![b'x'; 4 * 1024 * 1024 + 1],
                "/missing" => { reply = reply.status(404); b"not found".to_vec() },
                _ => serde_json::to_vec(&serde_json::json!({"method": parts.method.as_str(), "url": parts.uri.to_string(), "headers": headers, "body": String::from_utf8_lossy(&body)})).unwrap(),
            };
            let body: WasiBody = if parts.uri.path() == "/stalled-body" {
                StalledBody { sent: false }.boxed_unsync()
            } else {
                Full::new(Bytes::from(body))
                    .map_err(|never| match never {})
                    .boxed_unsync()
            };
            let response = reply.body(body).unwrap();
            Ok((response, Box::new(async { Ok(()) }) as Completion))
        })
    }
}
struct Context {
    wasi: WasiCtx,
    http: WasiHttpCtx,
    table: ResourceTable,
    fixture: Fixture,
}
impl WasiView for Context {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}
impl WasiHttpView for Context {
    fn http(&mut self) -> WasiHttpCtxView<'_> {
        WasiHttpCtxView {
            ctx: &mut self.http,
            table: &mut self.table,
            hooks: &mut self.fixture,
        }
    }
}
impl otel::wasi::otel::types::Host for Context {}
impl otel::wasi::otel::tracing::Host for Context {
    fn on_start(
        &mut self,
        context: otel::wasi::otel::tracing::SpanContext,
    ) -> wasmtime::Result<()> {
        eprintln!(
            "{}",
            serde_json::json!({"native_otel":"start", "trace_id": context.trace_id, "span_id": context.span_id})
        );
        Ok(())
    }
    fn on_end(&mut self, span: otel::wasi::otel::tracing::SpanData) -> wasmtime::Result<()> {
        eprintln!(
            "{}",
            serde_json::json!({"native_otel":"end", "name": span.name, "trace_id": span.span_context.trace_id, "parent_span_id": span.parent_span_id, "span_id": span.span_context.span_id})
        );
        Ok(())
    }
    fn outer_span_context(&mut self) -> wasmtime::Result<otel::wasi::otel::tracing::SpanContext> {
        Ok(otel::wasi::otel::tracing::SpanContext {
            trace_id: "11111111111111111111111111111111".into(),
            span_id: "2222222222222222".into(),
            trace_flags: otel::wasi::otel::tracing::TraceFlags::SAMPLED,
            is_remote: false,
            trace_state: vec![],
        })
    }
}
#[tokio::main]
async fn main() -> wasmtime::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let mut config = Config::new();
    config.wasm_component_model_async(true);
    let engine = Engine::new(&config)?;
    if args.get(2).map(String::as_str) == Some("--precompile") {
        let component = Component::from_file(&engine, &args[1])?;
        std::fs::write(&args[3], component.serialize()?)?;
        return Ok(());
    }
    let input: serde_json::Value = serde_json::from_reader(std::io::stdin())?;
    // This test-only cache is produced by this executable immediately before the suite.
    let component = unsafe { Component::deserialize_file(&engine, &args[1])? };
    let mut linker = Linker::new(&engine);
    wasmtime_wasi::p2::add_to_linker_async(&mut linker)?;
    wasmtime_wasi::p3::add_to_linker(&mut linker)?;
    wasmtime_wasi_http::p3::add_to_linker(&mut linker)?;
    otel::wasi::otel::tracing::add_to_linker::<_, wasmtime::component::HasSelf<_>>(
        &mut linker,
        |state| state,
    )?;
    let mut store = Store::new(
        &engine,
        Context {
            wasi: WasiCtx::builder()
                .envs(
                    &std::env::vars()
                        .filter(|(key, _)| key.starts_with("MCP_") || key == "RUST_LOG")
                        .collect::<Vec<_>>(),
                )
                .inherit_stderr()
                .build(),
            http: WasiHttpCtx::new(),
            table: ResourceTable::new(),
            fixture: Fixture,
        },
    );
    let instance = linker.instantiate_async(&mut store, &component).await?;
    let function = instance.get_typed_func::<(String, String, String, String), (String,)>(
        &mut store,
        match args.get(2).map(String::as_str) {
            Some("--probe") => "probe",
            Some("--upload") => "upload",
            Some("--cancel") => "cancel",
            Some("--backpressure") => "backpressure",
            _ => "exchange",
        },
    )?;
    if args.get(2).map(String::as_str) == Some("--batch") {
        let [a, b]: [[String; 4]; 2] = serde_json::from_value(input)?;
        let (a, b) = store
            .run_concurrent(async |store| {
                tokio::try_join!(
                    function.call_concurrent(
                        store,
                        (a[0].clone(), a[1].clone(), a[2].clone(), a[3].clone())
                    ),
                    function.call_concurrent(
                        store,
                        (b[0].clone(), b[1].clone(), b[2].clone(), b[3].clone())
                    )
                )
            })
            .await??;
        println!("{}", serde_json::to_string(&[a.0, b.0])?);
    } else {
        let [method, url, headers, body]: [String; 4] = serde_json::from_value(input)?;
        let (response,) = store
            .run_concurrent(async |store| {
                function
                    .call_concurrent(store, (method, url, headers, body))
                    .await
            })
            .await??;
        println!("{}", serde_json::to_string(&response)?);
    }
    Ok(())
}

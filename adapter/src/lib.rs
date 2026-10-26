wit_bindgen::generate!({ path: "../gen/adapter-wit", world: "adapter", generate_all });
use exports::cosmonic::http_exchange::client::{Guest, GuestExchange, Reply};
use futures_channel::oneshot;
use futures_util::future::{Either, select};
use std::sync::{
    Mutex,
    atomic::{AtomicU8, Ordering},
};
use wasi::http::types::{ErrorCode, Request, Response};

#[repr(u8)]
#[derive(Clone, Copy)]
enum Phase {
    Ready,
    Running,
    Finished,
}
struct AtomicPhase(AtomicU8);
impl AtomicPhase {
    fn new() -> Self {
        Self(AtomicU8::new(Phase::Ready as u8))
    }
    fn start(&self) -> bool {
        self.0
            .compare_exchange(
                Phase::Ready as u8,
                Phase::Running as u8,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }
    fn finish(&self) {
        self.0.store(Phase::Finished as u8, Ordering::Release);
    }
}
struct Dispatch<'a>(&'a AtomicPhase);
impl Drop for Dispatch<'_> {
    fn drop(&mut self) {
        self.0.finish();
    }
}
pub struct Exchange {
    phase: AtomicPhase,
    input: Mutex<Option<(Request, oneshot::Receiver<()>)>>,
    cancel: Mutex<Option<oneshot::Sender<()>>>,
}
struct Adapter;
export!(Adapter);
impl Guest for Adapter {
    type Exchange = Exchange;
    async fn consume_request(
        request: Request,
        max_bytes: u32,
        timeout_ms: u32,
    ) -> Result<Vec<u8>, ErrorCode> {
        let timeout =
            wasi::clocks0_3_0::monotonic_clock::wait_for(u64::from(timeout_ms) * 1_000_000);
        match select(
            Box::pin(timeout),
            Box::pin(read_request(request, max_bytes)),
        )
        .await
        {
            Either::Left(((), pending)) => {
                drop(pending);
                Err(ErrorCode::ConnectionReadTimeout)
            }
            Either::Right((result, _)) => result,
        }
    }
}
async fn read_request(request: Request, max_bytes: u32) -> Result<Vec<u8>, ErrorCode> {
    let (complete, complete_reader) = wit_future::new(|| Err(ErrorCode::ConnectionTerminated));
    let (mut stream, trailers) = Request::consume_body(request, complete_reader);
    let result = async {
        let mut body = Vec::new();
        loop {
            let (_, chunk) = stream.read(Vec::with_capacity(64 * 1024)).await;
            if chunk.is_empty() {
                break;
            }
            if body.len() + chunk.len() > max_bytes as usize {
                return Err(ErrorCode::HttpRequestBodySize(Some(u64::from(max_bytes))));
            }
            body.extend_from_slice(&chunk);
        }
        trailers.await?;
        Ok(body)
    }
    .await;
    drop(stream);
    let _ = complete
        .write(result.as_ref().map(|_| ()).map_err(Clone::clone))
        .await;
    result
}
impl GuestExchange for Exchange {
    fn new(request: Request) -> Self {
        let (tx, rx) = oneshot::channel();
        Self {
            phase: AtomicPhase::new(),
            input: Mutex::new(Some((request, rx))),
            cancel: Mutex::new(Some(tx)),
        }
    }
    async fn send(&self, max_bytes: u32) -> Result<Reply, ErrorCode> {
        if !self.phase.start() {
            return Err(ErrorCode::InternalError(Some(
                "exchange already sent".into(),
            )));
        }
        let _dispatch = Dispatch(&self.phase);
        let (request, canceled) = self.input.lock().unwrap().take().unwrap();
        match select(Box::pin(canceled), Box::pin(perform(request, max_bytes))).await {
            Either::Right((response, _)) => response,
            Either::Left((_, pending)) => {
                drop(pending);
                Err(ErrorCode::ConnectionTerminated)
            }
        }
    }
    fn cancel(&self) {
        if let Some(sender) = self.cancel.lock().unwrap().take() {
            let _ = sender.send(());
        }
    }
}

async fn perform(request: Request, max_bytes: u32) -> Result<Reply, ErrorCode> {
    let response = wasi::http::client::send(request).await?;
    let status = response.get_status_code();
    let headers = response.get_headers().copy_all();
    let (done, done_reader) = wit_future::new(|| Ok(()));
    drop(done);
    let (mut stream, trailers) = Response::consume_body(response, done_reader);
    let mut body = Vec::new();
    loop {
        let (_, chunk) = stream.read(Vec::with_capacity(64 * 1024)).await;
        if chunk.is_empty() {
            break;
        }
        if body.len() + chunk.len() > max_bytes as usize {
            return Err(ErrorCode::HttpResponseBodySize(Some(u64::from(max_bytes))));
        }
        body.extend_from_slice(&chunk);
    }
    trailers.await?;
    Ok(Reply {
        status,
        headers,
        body,
    })
}

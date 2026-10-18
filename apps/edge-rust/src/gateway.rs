// SPDX-License-Identifier: Apache-2.0
use crate::{
    host,
    policy::{Access, Failure, GatewayRegion, access, refusal_code},
    runtime::Shared,
};
use futures_util::future::{Either, select};
use pgcf_native_protocol::{constant, wire};
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::{JsFuture, spawn_local};
use web_sys::{
    AbortSignal, ReadableStreamDefaultReader, RequestInit, RequestRedirect, WorkerGlobalScope,
};
use worker::{Env, Fetcher, Request, Response, WebSocket};

/// The longest the Edge waits for the body of a refusal. A gateway sends its error code with the
/// head, so a body that is not there by now is not waited for.
const REFUSAL_WAIT_MS: u64 = 250;

/// Where a request to the gateway is sent. A configured binding never falls back to global fetch.
pub enum Sender {
    Binding(Fetcher),
    Global,
}
/// Only an explicit configured service binding may bypass global fetch.
pub fn resolve(region: &GatewayRegion, env: &Env) -> Result<Sender, Failure> {
    match &region.gateway_binding {
        Some(binding) => env
            .service(binding)
            .map(Sender::Binding)
            .map_err(|_| Failure::gateway()),
        None => Ok(Sender::Global),
    }
}
impl Sender {
    /// One send; a failure says nothing of whether the gateway received the request.
    pub async fn send(&self, request: &web_sys::Request) -> Result<web_sys::Response, ()> {
        match self {
            Sender::Binding(fetcher) => fetcher
                .fetch_request(Request::from(Clone::clone(request)))
                .await
                .map(web_sys::Response::from)
                .map_err(|_| ()),
            Sender::Global => {
                let global: WorkerGlobalScope = js_sys::global().unchecked_into();
                JsFuture::from(global.fetch_with_request(request))
                    .await
                    .map_err(|_| ())?
                    .dyn_into::<web_sys::Response>()
                    .map_err(|_| ())
            }
        }
    }
}

/// Presents the Edge's Access service token to a gateway on the public network. A gateway on a
/// service binding does not go through Access. One secret alone refuses the request before
/// anything is sent; the log names the problem, never a value.
pub fn present_access(
    headers: &web_sys::Headers,
    region: &GatewayRegion,
    env: &Env,
    timings: &Shared,
) -> Result<(), Failure> {
    if region.gateway_binding.is_some() {
        return Ok(());
    }
    let secret = |name: &str| env.secret(name).ok().map(|value| value.to_string());
    let (id, secret) = (secret("ACCESS_CLIENT_ID"), secret("ACCESS_CLIENT_SECRET"));
    match access(id.as_deref(), secret.as_deref()) {
        Access::Absent => Ok(()),
        Access::Incomplete => {
            timings.borrow_mut().config_error = Some(wire("accessSecretsIncomplete"));
            Err(Failure::gateway())
        }
        Access::Send { id, secret } => {
            headers
                .set(wire("accessClientIdHeader"), id)
                .map_err(|_| Failure::gateway())?;
            headers
                .set(wire("accessClientSecretHeader"), secret)
                .map_err(|_| Failure::gateway())
        }
    }
}

/// The error code of a gateway's refusal, from the head of its body: at most `REFUSAL_BYTES` and
/// `REFUSAL_WAIT_MS` of it. The body is not read to its end and its cancel is not awaited, because
/// a gateway that stalls must not hold the refusal the client is waiting for.
pub async fn read_refusal(response: &web_sys::Response) -> Option<String> {
    let reader: ReadableStreamDefaultReader = response.body()?.get_reader().dyn_into().ok()?;
    let limit = constant("REFUSAL_BYTES") as usize;
    let mut head = Vec::new();
    let mut expired = Box::pin(host::sleep(REFUSAL_WAIT_MS));
    while head.len() < limit {
        let read = Box::pin(JsFuture::from(reader.read()));
        let Either::Left((Ok(chunk), _)) = select(read, &mut expired).await else {
            break;
        };
        let field = |name: &str| js_sys::Reflect::get(&chunk, &name.into()).ok();
        let (Some(done), Some(value)) = (field("done"), field("value")) else {
            break;
        };
        if done.as_bool() != Some(false) {
            break;
        }
        let part = js_sys::Uint8Array::new(&value).to_vec();
        head.extend_from_slice(&part[..part.len().min(limit - head.len())]);
    }
    let cancel = reader.cancel();
    spawn_local(async move {
        let _ = JsFuture::from(cancel).await;
    });
    refusal_code(&String::from_utf8_lossy(&head))
}
/// A gateway that answered an upgrade with a refusal: its status and error code are logged, and
/// nothing else of its answer.
async fn refused(response: web_sys::Response, timings: &Shared) -> Failure {
    timings.borrow_mut().gateway_status = Some(response.status());
    let code = read_refusal(&response).await;
    timings.borrow_mut().gateway_error = code;
    Failure::gateway()
}

/// One real Fetcher upgrade.
pub async fn connect(
    region: &GatewayRegion,
    token: &str,
    env: &Env,
    signal: &AbortSignal,
    timings: &Shared,
) -> Result<WebSocket, Failure> {
    let url = region.transport_url()?;
    let headers = web_sys::Headers::new().map_err(|_| Failure::gateway())?;
    headers
        .set("Upgrade", "websocket")
        .map_err(|_| Failure::gateway())?;
    headers
        .set(wire("routeHeader"), token)
        .map_err(|_| Failure::gateway())?;
    present_access(&headers, region, env, timings)?;
    let init = RequestInit::new();
    init.set_headers(&headers);
    init.set_redirect(RequestRedirect::Manual);
    init.set_signal(Some(signal));
    let raw = web_sys::Request::new_with_str_and_init(url.as_str(), &init)
        .map_err(|_| Failure::gateway())?;
    let sender = resolve(region, env)?;
    let response: Response = sender
        .send(&raw)
        .await
        .map_err(|_| Failure::gateway())?
        .into();
    if response.status_code() != 101 {
        return Err(refused(response.into(), timings).await);
    }
    let socket = response.websocket().ok_or_else(Failure::gateway)?;
    if signal.aborted() {
        host::close_late(socket);
        return Err(Failure::interrupted());
    }
    Ok(socket)
}

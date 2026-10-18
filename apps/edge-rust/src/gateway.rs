// SPDX-License-Identifier: Apache-2.0
use crate::{
    host,
    policy::{Failure, GatewayRegion},
};
use pgcf_native_protocol::wire;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;
use web_sys::{AbortSignal, RequestInit, RequestRedirect, WorkerGlobalScope};
use worker::{Env, Fetcher, Request, Response, WebSocket};

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

/// One real Fetcher upgrade.
pub async fn connect(
    region: &GatewayRegion,
    token: &str,
    env: &Env,
    signal: &AbortSignal,
) -> Result<WebSocket, Failure> {
    let url = region.transport_url()?;
    let headers = web_sys::Headers::new().map_err(|_| Failure::gateway())?;
    headers
        .set("Upgrade", "websocket")
        .map_err(|_| Failure::gateway())?;
    headers
        .set(wire("routeHeader"), token)
        .map_err(|_| Failure::gateway())?;
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
        let raw: web_sys::Response = response.into();
        if let Some(body) = raw.body() {
            let _ = JsFuture::from(body.cancel()).await;
        }
        return Err(Failure::gateway());
    }
    let socket = response.websocket().ok_or_else(Failure::gateway)?;
    if signal.aborted() {
        host::close_late(socket);
        return Err(Failure::interrupted());
    }
    Ok(socket)
}

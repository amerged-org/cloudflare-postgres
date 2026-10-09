// SPDX-License-Identifier: Apache-2.0
use crate::{
    host,
    policy::{Failure, GatewayRegion},
};
use pgcf_native_protocol::wire;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;
use web_sys::{AbortSignal, RequestInit, RequestRedirect, WorkerGlobalScope};
use worker::{Env, Request, Response, WebSocket};

/// One real Fetcher upgrade. A configured binding never falls back to global fetch.
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
    let response: Response = if let Some(binding) = &region.gateway_binding {
        env.service(binding)
            .map_err(|_| Failure::gateway())?
            .fetch_request(Request::from(raw))
            .await
            .map_err(|_| Failure::gateway())?
    } else {
        let global: WorkerGlobalScope = js_sys::global().unchecked_into();
        let value = JsFuture::from(global.fetch_with_request(&raw))
            .await
            .map_err(|_| Failure::gateway())?;
        Response::from(
            value
                .dyn_into::<web_sys::Response>()
                .map_err(|_| Failure::gateway())?,
        )
    };
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

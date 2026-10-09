// SPDX-License-Identifier: Apache-2.0
use crate::{
    gateway, host,
    policy::{self, Failure, GatewayRegion, Hints},
};
use futures_channel::oneshot;
use futures_util::future::{Either, select};
use pgcf_native_protocol::{
    constant,
    route::{self, Keyring},
    startup::error_response,
};
use serde_json::{Value, json};
use wasm_bindgen_futures::JsFuture;
use web_sys::{AbortController, AbortSignal};
use worker::{Context, Env, Request, Response, WebSocket, WebSocketPair};

fn refused(failure: &Failure) -> worker::Result<Response> {
    let pair = WebSocketPair::new()?;
    pair.server.accept()?;
    pair.server
        .send_with_bytes(error_response(&failure.sqlstate, &failure.message))?;
    pair.server.close(Some(1000), Some("connection refused"))?;
    Response::from_websocket(pair.client)
}
fn admitted(value: Value) -> Result<GatewayRegion, Failure> {
    let object = value.as_object().ok_or_else(Failure::gateway)?;
    if object.len() != 2 {
        return Err(Failure::gateway());
    }
    match object.get("ok").and_then(Value::as_bool) {
        Some(false) => Err(policy::actor_failure(
            object
                .get("sqlstate")
                .and_then(Value::as_str)
                .ok_or_else(Failure::gateway)?,
        )),
        Some(true) => {
            let value = object.get("region").ok_or_else(Failure::gateway)?;
            let keys = value.as_object().ok_or_else(Failure::gateway)?;
            if keys.len() != 3 || !keys.contains_key("gateway_binding") {
                return Err(Failure::gateway());
            }
            let route: GatewayRegion =
                serde_json::from_value(value.clone()).map_err(|_| Failure::gateway())?;
            if !pgcf_native_protocol::valid_pattern("region",&route.id)||route.gateway_url.encode_utf16().count()>pgcf_native_protocol::CONTRACT["gatewayRegion"]["properties"]["gateway_url"]["maxLength"].as_u64().unwrap()as usize{return Err(Failure::gateway());}
            Ok(route)
        }
        _ => Err(Failure::gateway()),
    }
}
// Serialize as a struct: serde_json::Value maps become JavaScript Map objects,
// whose optional fields the Actor cannot read as RPC options.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WakeOptions<'a> {
    deadline: u64,
    waiter_id: &'a str,
}
async fn admit(
    env: Env,
    hints: Hints,
    network: Option<String>,
    cid: String,
    signal: AbortSignal,
    deadline: u64,
    ctx: Context,
) -> Result<(WebSocket, String), Failure> {
    host::check(&signal)?;
    let network = policy::connection_rate_key(network.as_deref()).ok_or_else(Failure::rate)?;
    let key = serde_json::to_string(&[&hints.database, &hints.user, &network])
        .map_err(|_| Failure::gateway())?;
    let allowed = env
        .rate_limiter("CONNECTION_RATE_LIMITER")
        .map_err(|_| Failure::unavailable())?
        .limit(key)
        .await
        .map_err(|_| Failure::unavailable())?
        .success;
    host::check(&signal)?;
    if !allowed {
        return Err(Failure::rate());
    }
    let actor = host::actor(&env, &hints.database)?;
    let cancel = host::cancel_on_abort(
        &signal,
        actor.clone(),
        hints.database.clone(),
        cid.clone(),
        &ctx,
    )?;
    host::check(&signal)?;
    let options = serde_wasm_bindgen::to_value(&WakeOptions {
        deadline,
        waiter_id: &cid,
    })
    .map_err(|_| Failure::gateway())?;
    let promise = actor
        .ensure_awake(&hints.database, &hints.user, &options)
        .map_err(|_| Failure::gateway())?;
    let result = JsFuture::from(promise)
        .await
        .map_err(|_| Failure::gateway());
    drop(cancel);
    host::check(&signal)?;
    let route = admitted(serde_wasm_bindgen::from_value(result?).map_err(|_| Failure::gateway())?)?;
    let allowed = env
        .rate_limiter("DATABASE_CONNECTION_RATE_LIMITER")
        .map_err(|_| Failure::unavailable())?
        .limit(hints.database.clone())
        .await
        .map_err(|_| Failure::unavailable())?
        .success;
    host::check(&signal)?;
    if !allowed {
        return Err(Failure::new(
            "53300",
            "database connection rate limit exceeded",
        ));
    }
    let ring = Keyring::parse(
        &env.secret("ROUTE_MASTER_KEYS")
            .map_err(|_| Failure::gateway())?
            .to_string(),
    )
    .map_err(|_| Failure::gateway())?;
    let token = route::sign(
        &ring,
        &route.id,
        &hints.database,
        &hints.user,
        &cid,
        host::now(),
        constant("ROUTE_TOKEN_SIGN_TTL_SECONDS"),
    )
    .map_err(|_| Failure::gateway())?;
    host::check(&signal)?;
    let socket = gateway::connect(&route, &token, &env, &signal).await?;
    Ok((socket, route.id))
}
async fn bounded(
    request: &Request,
    env: &Env,
    hints: &Hints,
    cid: &str,
    ctx: &Context,
) -> Result<(WebSocket, String), Failure> {
    let controller = AbortController::new().map_err(|_| Failure::gateway())?;
    let signal = controller.signal();
    let _request = host::propagate(&request.inner().signal(), &controller)?;
    let deadline = host::now().saturating_add(constant("ADMISSION_DEADLINE_MS"));
    let timeout = controller.clone();
    let _timer = host::Timer::new(deadline.saturating_sub(host::now()), move || {
        timeout.abort()
    })?;
    let interrupted = host::Interrupted::new(&signal)?;
    let (sender, receiver) = oneshot::channel();
    let (owned_env, owned_hints, owned_cid, owned_signal, owned_ctx) = (
        env.clone(),
        hints.clone(),
        cid.to_string(),
        signal.clone(),
        host::owned_context(ctx),
    );
    let network = request
        .headers()
        .get("CF-Connecting-IP")
        .map_err(|_| Failure::rate())?;
    // Keep the actual asynchronous admission alive to dispose a late upgrade,
    // rather than dropping its result while the host fetch may still complete.
    ctx.wait_until(async move {
        let result = admit(
            owned_env,
            owned_hints,
            network,
            owned_cid,
            owned_signal,
            deadline,
            owned_ctx,
        )
        .await;
        if let Err(Ok((socket, _))) = sender.send(result) {
            host::close_late(socket);
        }
    });
    futures_util::pin_mut!(interrupted);
    match select(receiver, interrupted).await {
        Either::Left((result, _)) => {
            let value = result.map_err(|_| Failure::gateway())??;
            if signal.aborted() {
                host::close_late(value.0);
                Err(Failure::interrupted())
            } else {
                Ok(value)
            }
        }
        Either::Right((_, mut pending)) => {
            controller.abort();
            if let Ok(Some(Ok((socket, _)))) = pending.try_recv() {
                host::close_late(socket);
            }
            Err(Failure::interrupted())
        }
    }
}
pub async fn fetch(request: Request, env: Env, ctx: Context) -> worker::Result<Response> {
    let url = request.url()?;
    if request.method() == worker::Method::Get && url.path() == "/healthz" {
        return Response::from_json(&json!({"status":"ok"}));
    }
    if url.path() != "/v2" {
        return Ok(Response::ok("Not found")?.with_status(404));
    }
    if request.method() != worker::Method::Get
        || request
            .headers()
            .get("Upgrade")?
            .as_deref()
            .map(str::to_ascii_lowercase)
            .as_deref()
            != Some("websocket")
    {
        return Ok(Response::ok("WebSocket upgrade required")?.with_status(426));
    }
    let started = host::now();
    let cid =
        host::uuid().map_err(|_| worker::Error::RustError("runtime entropy unavailable".into()))?;
    let hints = policy::routing_hints(url.query().unwrap_or(""));
    let mut region = None;
    let mut outcome = "accepted".to_string();
    let result = match &hints {
        Ok(hints) => bounded(&request, &env, hints, &cid, &ctx).await,
        Err(failure) => Err(failure.clone()),
    };
    let response = match result {
        Ok((socket, id)) => {
            region = Some(id);
            Response::from_websocket(socket)
        }
        Err(failure) => {
            outcome = failure.sqlstate.clone();
            if failure.decoy {
                if let Ok(hints) = &hints {
                    crate::decoy_host::response(
                        hints.clone(),
                        &env,
                        &request.inner().signal(),
                        &ctx,
                    )
                } else {
                    refused(&failure)
                }
            } else {
                refused(&failure)
            }
        }
    };
    worker::console_log!(
        "{}",
        json!({"event":"conn_admission","cid":cid,"database_id":hints.as_ref().ok().map(|v|&v.database),"user":hints.as_ref().ok().map(|v|&v.user),"region_id":region,"duration_ms":host::now().saturating_sub(started),"outcome":outcome})
    );
    response
}

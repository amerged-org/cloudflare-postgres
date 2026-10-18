// SPDX-License-Identifier: Apache-2.0
//! HTTP SQL at the Edge (`POST /sql`): admitted as a WebSocket connection is admitted, signed a
//! route and forwarded once to the gateway of the node that serves the database, which runs it on
//! a pooled PostgreSQL session. The Edge never retries a forwarded request.
use crate::{
    gateway, host,
    policy::{self, Failure, GatewayRegion, Hints, Log},
    runtime::{Admit, Late, Shared, bounded},
    sql::{self, Connection, SqlFailure},
};
use pgcf_native_protocol::wire;
use serde::Serialize;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;
use web_sys::{
    AbortSignal, ReadableStreamDefaultReader, RequestInit, RequestRedirect, ResponseInit,
};
use worker::{Context, Env, Method, Request, Response};

/// An admitted request: the gateway to send it to and the route signed for it.
struct Admitted {
    region: GatewayRegion,
    token: String,
}
impl Late for Admitted {
    /// Nothing is open yet: an admission that finished late is only dropped.
    fn dispose(self) {}
}

fn json(status: u16, body: &impl Serialize) -> worker::Result<Response> {
    let mut response = Response::ok(
        serde_json::to_string(body)
            .map_err(|_| worker::Error::RustError("response is not JSON".into()))?,
    )?
    .with_status(status);
    let headers = response.headers_mut();
    headers.set("Content-Type", "application/json")?;
    headers.set("Cache-Control", "no-store")?;
    Ok(response)
}
fn header(request: &Request, name: &str) -> Option<String> {
    request.headers().get(name).ok().flatten()
}

/// The body, read up to the gateway's bound.
async fn read_body(request: &Request) -> Result<String, SqlFailure> {
    let maximum = sql::max_request_bytes();
    if header(request, "Content-Length").is_some_and(|declared| {
        declared
            .trim()
            .parse::<f64>()
            .is_ok_and(|n| n > maximum as f64)
    }) {
        return Err(SqlFailure::too_large());
    }
    let stream = request.inner().body().ok_or_else(SqlFailure::invalid)?;
    let reader: ReadableStreamDefaultReader = stream
        .get_reader()
        .dyn_into()
        .map_err(|_| SqlFailure::gateway())?;
    let mut bytes = Vec::new();
    loop {
        let chunk = JsFuture::from(reader.read())
            .await
            .map_err(|_| SqlFailure::gateway())?;
        let done = js_sys::Reflect::get(&chunk, &"done".into())
            .map_err(|_| SqlFailure::gateway())?
            .as_bool()
            .unwrap_or(true);
        if done {
            break;
        }
        let value =
            js_sys::Reflect::get(&chunk, &"value".into()).map_err(|_| SqlFailure::gateway())?;
        let part = js_sys::Uint8Array::new(&value);
        if bytes.len() + part.length() as usize > maximum {
            let _ = JsFuture::from(reader.cancel()).await;
            return Err(SqlFailure::too_large());
        }
        bytes.extend_from_slice(&part.to_vec());
    }
    sql::body_text(&bytes)
}

/// The gateway's JSON, passed through; its head and the type are the Edge's.
fn headers() -> Result<web_sys::Headers, SqlFailure> {
    let headers = web_sys::Headers::new().map_err(|_| SqlFailure::gateway())?;
    for (name, value) in [
        ("Content-Type", "application/json"),
        ("Cache-Control", "no-store"),
    ] {
        headers
            .set(name, value)
            .map_err(|_| SqlFailure::gateway())?;
    }
    Ok(headers)
}

/// Sends the request to the gateway once and passes its answer through.
async fn forward(
    admitted: &Admitted,
    body: &str,
    env: &Env,
    signal: &AbortSignal,
    timings: &Shared,
) -> Result<Response, SqlFailure> {
    let mut url = admitted
        .region
        .transport_url()
        .map_err(|_| SqlFailure::gateway())?;
    url.set_path("/sql");
    let sender = gateway::resolve(&admitted.region, env).map_err(|_| SqlFailure::gateway())?;
    let sent = web_sys::Headers::new().map_err(|_| SqlFailure::unknown_outcome())?;
    sent.set("Content-Type", "application/json")
        .map_err(|_| SqlFailure::unknown_outcome())?;
    sent.set(wire("routeHeader"), &admitted.token)
        .map_err(|_| SqlFailure::unknown_outcome())?;
    // Nothing was sent yet, so a token that cannot be presented is no unknown outcome.
    gateway::present_access(&sent, &admitted.region, env, timings)
        .map_err(|_| SqlFailure::gateway())?;
    let init = RequestInit::new();
    init.set_method("POST");
    init.set_headers(&sent);
    init.set_body(&body.into());
    init.set_redirect(RequestRedirect::Manual);
    init.set_signal(Some(signal));
    let raw = web_sys::Request::new_with_str_and_init(url.as_str(), &init)
        .map_err(|_| SqlFailure::unknown_outcome())?;
    let started = host::now();
    let response = sender.send(&raw).await;
    timings.borrow_mut().gateway_ms = Some(host::now().saturating_sub(started));
    let response = response.map_err(|_| SqlFailure::unknown_outcome())?;
    timings.borrow_mut().gateway_status = Some(response.status());
    let typed = sql::is_json(
        response
            .headers()
            .get("Content-Type")
            .ok()
            .flatten()
            .as_deref(),
    );
    if response.status() == 200 && typed {
        let answer = headers()?;
        let init = ResponseInit::new();
        init.set_status(200);
        init.set_headers(&answer);
        return web_sys::Response::new_with_opt_readable_stream_and_init(
            response.body().as_ref(),
            &init,
        )
        .map(Response::from)
        .map_err(|_| SqlFailure::gateway());
    }
    if response.status() == 400 && typed {
        let text = JsFuture::from(response.text().map_err(|_| SqlFailure::gateway())?)
            .await
            .map_err(|_| SqlFailure::gateway())?
            .as_string()
            .ok_or_else(SqlFailure::gateway)?;
        if sql::is_gateway_error(&text) {
            return Response::ok(text)
                .map(|response| response.with_status(400))
                .and_then(|mut response| {
                    let headers = response.headers_mut();
                    headers.set("Content-Type", "application/json")?;
                    headers.set("Cache-Control", "no-store")?;
                    Ok(response)
                })
                .map_err(|_| SqlFailure::gateway());
        }
        timings.borrow_mut().gateway_error = policy::refusal_code(&text);
    } else {
        let code = gateway::read_refusal(&response).await;
        timings.borrow_mut().gateway_error = code;
    }
    Err(SqlFailure::unknown_outcome())
}

/// What the request asked, admitted and answered; the log is the caller's.
async fn run(
    request: &Request,
    env: &Env,
    ctx: &Context,
    cid: &str,
    timings: &Shared,
    target: &mut Option<Hints>,
    region: &mut Option<String>,
) -> Result<Response, SqlFailure> {
    if request.method() != Method::Post {
        return Err(SqlFailure::new("08P01", "HTTP SQL requires POST"));
    }
    let Connection {
        database,
        user,
        password,
    } = sql::connection(header(request, "Neon-Connection-String").as_deref())?;
    let hints = target.insert(Hints { database, user }).clone();
    let characteristics = sql::transaction(|name| header(request, name))?;
    let began = host::now();
    let understood = match read_body(request).await {
        Ok(text) => sql::statements(&text),
        Err(failure) => Err(failure),
    };
    timings.borrow_mut().body_ms = Some(host::now().saturating_sub(began));
    let understood = understood?;
    timings.borrow_mut().statements = Some(understood.queries.len());
    if understood.batch && understood.queries.is_empty() {
        return json(200, &serde_json::json!({"results": []})).map_err(|_| SqlFailure::gateway());
    }
    let body = sql::forward_body(&password, &understood, &characteristics)?;
    // HTTP requests count in buckets of their own, so queries never take WebSocket handshakes.
    let source = request
        .headers()
        .get("CF-Connecting-IP")
        .map_err(|_| SqlFailure::from(Failure::rate()))?;
    let (admitting, cid, shared, owned) = (
        env.clone(),
        cid.to_string(),
        timings.clone(),
        host::owned_context(ctx),
    );
    let admitted = bounded(request, ctx, move |signal, deadline| async move {
        let admit = Admit {
            env: admitting,
            hints,
            source,
            cid,
            signal,
            deadline,
            ctx: owned,
            timings: shared,
            scope: &["sql"],
        };
        let (region, token) = admit.route().await?;
        Ok(Admitted { region, token })
    })
    .await?;
    *region = Some(admitted.region.id.clone());
    forward(&admitted, &body, env, &request.inner().signal(), timings).await
}

pub async fn serve(request: Request, env: Env, ctx: Context) -> worker::Result<Response> {
    let started = host::now();
    let isolate_requests = host::next_isolate_request();
    let cid =
        host::uuid().map_err(|_| worker::Error::RustError("runtime entropy unavailable".into()))?;
    let timings = Shared::default();
    let mut target = None;
    let mut region = None;
    let mut outcome = "accepted".to_string();
    let response = match run(
        &request,
        &env,
        &ctx,
        &cid,
        &timings,
        &mut target,
        &mut region,
    )
    .await
    {
        Ok(response) => response,
        Err(failure) => {
            outcome = failure.code.clone();
            json(400, &failure)?
        }
    };
    // From the request's arrival to the response head: the body streams after it.
    let duration = host::now().saturating_sub(started);
    let stages = timings.borrow().clone();
    worker::console_log!(
        "{}",
        Log {
            event: "sql_admission",
            cid: &cid,
            colo: host::colo(&request).as_deref(),
            hints: target.as_ref(),
            region: region.as_deref(),
            duration_ms: duration,
            // All but the client's upload and the gateway.
            edge_ms: policy::edge_share(duration, &[stages.body_ms, stages.gateway_ms]),
            isolate_requests,
            outcome: &outcome,
        }
        .line(&stages)
    );
    Ok(response)
}

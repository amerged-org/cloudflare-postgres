// SPDX-License-Identifier: Apache-2.0
use crate::{
    gateway, host,
    policy::{self, Failure, GatewayRegion, Hints, Log, Signable, Timings},
};
use futures_channel::oneshot;
use futures_util::future::{Either, join, join_all, select};
use pgcf_native_protocol::{
    constant,
    route::{self, Keyring},
    startup::error_response,
    wake,
};
use serde_json::{Value, json};
use std::{cell::RefCell, future::Future, rc::Rc};
use wasm_bindgen_futures::JsFuture;
use web_sys::{AbortController, AbortSignal};
use worker::{Context, Env, Request, Response, WebSocket, WebSocketPair};

/// The timings of one request, shared with the admission that may outlive the handler's answer.
pub type Shared = Rc<RefCell<Timings>>;

fn refused(failure: &Failure) -> worker::Result<Response> {
    let pair = WebSocketPair::new()?;
    pair.server.accept()?;
    pair.server
        .send_with_bytes(error_response(&failure.sqlstate, &failure.message))?;
    pair.server.close(Some(1000), Some("connection refused"))?;
    Response::from_websocket(pair.client)
}
// Serialize as a struct: serde_json::Value maps become JavaScript Map objects,
// whose optional fields the Actor cannot read as RPC options.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WakeOptions<'a> {
    deadline: u64,
    waiter_id: &'a str,
}

/// What an admission needs: the request's own identity and the clock it must keep.
pub struct Admit {
    pub env: Env,
    pub hints: Hints,
    /// `CF-Connecting-IP`; none on a service binding.
    pub source: Option<String>,
    pub cid: String,
    pub signal: AbortSignal,
    pub deadline: u64,
    pub ctx: Context,
    pub timings: Shared,
    /// Prefixes the limiter keys, so that a kind of request (HTTP queries: `["sql"]`) counts in
    /// buckets of its own of the same limiters.
    pub scope: &'static [&'static str],
}
impl Admit {
    /// The limiters, one of the Actor's admission, and the route signed for the gateway of the
    /// node that serves the database. The limiters and the Actor's admission run together: none
    /// of them waits for another, so the per-database bucket also counts connects that
    /// admission refuses.
    pub async fn route(&self) -> Result<(GatewayRegion, String), Failure> {
        host::check(&self.signal)?;
        let network =
            policy::connection_rate_key(self.source.as_deref()).ok_or_else(Failure::rate)?;
        // Shared proxy networks must not couple unrelated database/role routes. These untrusted
        // hints scope admission; PostgreSQL authenticates the user.
        let limits = policy::limits(&network, &self.hints, self.scope);
        let actor = host::actor(&self.env, &self.hints.database)?;
        let cancel = host::cancel_on_abort(
            &self.signal,
            actor.clone(),
            self.hints.database.clone(),
            self.cid.clone(),
            &self.ctx,
        )?;
        host::check(&self.signal)?;
        let options = serde_wasm_bindgen::to_value(&WakeOptions {
            deadline: self.deadline,
            waiter_id: &self.cid,
        })
        .map_err(|_| Failure::gateway())?;
        let started = host::now();
        let admission = async {
            let result = match actor.admit_wake(&self.hints.database, &self.hints.user, &options) {
                Ok(promise) => JsFuture::from(promise)
                    .await
                    .map_err(|_| Failure::gateway()),
                Err(_) => Err(Failure::gateway()),
            };
            self.timings.borrow_mut().admit_ms = Some(host::now().saturating_sub(started));
            result
        };
        let limited = join_all(limits.iter().map(|limit| async {
            let limiter = self.env.rate_limiter(limit.binding).map_err(|_| ())?;
            let outcome = limiter.limit(limit.key.clone()).await;
            let elapsed = host::now().saturating_sub(started);
            let mut timings = self.timings.borrow_mut();
            timings.limiters_ms = Some(timings.limiters_ms.unwrap_or(0).max(elapsed));
            outcome.map(|outcome| outcome.success).map_err(|_| ())
        }));
        let (admission, outcomes) = join(admission, limited).await;
        drop(cancel);
        host::check(&self.signal)?;
        if let Some(failure) = policy::limit_failure(&limits, &outcomes) {
            return Err(failure);
        }
        let admitted = policy::admission(
            &serde_wasm_bindgen::from_value::<Value>(admission?).map_err(|_| Failure::gateway())?,
        )?;
        let ring = Keyring::parse(
            &self
                .env
                .secret("ROUTE_MASTER_KEYS")
                .map_err(|_| Failure::gateway())?
                .to_string(),
        )
        .map_err(|_| Failure::gateway())?;
        let connection = route::Connection {
            region: &admitted.region.id,
            node: &admitted.node,
            database: &self.hints.database,
            user: &self.hints.user,
            cid: &self.cid,
            now_ms: host::now(),
            ttl_seconds: constant("ROUTE_TOKEN_SIGN_TTL_SECONDS"),
        };
        // A wake ticket is signed as route v5: the gateway holds the request until its wake is
        // released. An awake database is signed as route v6, which names the unit the node
        // reported. Both are sealed with the key of the node the database runs on.
        let signing = host::now();
        let token = match &admitted.signable {
            Signable::Awake {
                revision,
                route_revision,
                instance,
            } => {
                self.timings.borrow_mut().route = Some("v6");
                route::sign(
                    &ring,
                    &connection,
                    &route::NodeTarget {
                        revision: *revision,
                        route_revision: *route_revision,
                        instance,
                    },
                )
            }
            Signable::Wake {
                operation,
                generation,
                route_revision,
                role_revision_hash,
            } => {
                self.timings.borrow_mut().route = Some("v5");
                wake::sign_wake(
                    &ring,
                    &connection,
                    &wake::Ticket {
                        operation,
                        generation: *generation,
                        route_revision: *route_revision,
                        role_revision_hash,
                    },
                )
            }
        }
        .map_err(|_| Failure::gateway())?;
        self.timings.borrow_mut().token_ms = Some(host::now().saturating_sub(signing));
        host::check(&self.signal)?;
        Ok((admitted.region, token))
    }
}

/// What an admission that finished after its request was answered leaves behind, to be disposed
/// of rather than dropped while the host may still complete it.
pub trait Late {
    fn dispose(self);
}

/// An admitted connection: the upgraded socket to the gateway and the region it is in.
pub struct Upgraded {
    socket: WebSocket,
    region: String,
}
impl Late for Upgraded {
    fn dispose(self) {
        host::close_late(self.socket);
    }
}
/// Admits the connection and opens its WebSocket to the gateway of the node that serves it.
async fn upgrade(admit: Admit) -> Result<Upgraded, Failure> {
    let (region, token) = admit.route().await?;
    let started = host::now();
    admit.timings.borrow_mut().gateway_started = Some(started);
    let connected =
        gateway::connect(&region, &token, &admit.env, &admit.signal, &admit.timings).await;
    admit.timings.borrow_mut().gateway_connect_ms = Some(host::now().saturating_sub(started));
    Ok(Upgraded {
        socket: connected?,
        region: region.id,
    })
}

/// Runs `admission` until its deadline (60 s) or the client's abort, whichever comes first; either
/// refuses with 08006 and aborts the signal `admission` was given.
pub async fn bounded<T, F, Fut>(
    request: &Request,
    ctx: &Context,
    admission: F,
) -> Result<T, Failure>
where
    T: Late + 'static,
    F: FnOnce(AbortSignal, u64) -> Fut,
    Fut: Future<Output = Result<T, Failure>> + 'static,
{
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
    let task = admission(signal.clone(), deadline);
    // Keep the actual asynchronous admission alive to dispose a late result, rather than
    // dropping it while the host fetch may still complete.
    ctx.wait_until(async move {
        if let Err(Ok(late)) = sender.send(task.await) {
            late.dispose();
        }
    });
    futures_util::pin_mut!(interrupted);
    match select(receiver, interrupted).await {
        Either::Left((result, _)) => {
            let value = result.map_err(|_| Failure::gateway())??;
            if signal.aborted() {
                value.dispose();
                Err(Failure::interrupted())
            } else {
                Ok(value)
            }
        }
        Either::Right((_, mut pending)) => {
            controller.abort();
            if let Ok(Some(Ok(late))) = pending.try_recv() {
                late.dispose();
            }
            Err(Failure::interrupted())
        }
    }
}
/// Admits the connection of `request` within the admission deadline.
async fn connect(
    request: &Request,
    env: &Env,
    ctx: &Context,
    hints: &Hints,
    cid: &str,
    timings: &Shared,
) -> Result<Upgraded, Failure> {
    let source = request
        .headers()
        .get("CF-Connecting-IP")
        .map_err(|_| Failure::rate())?;
    let (env, hints, cid, timings, owned) = (
        env.clone(),
        hints.clone(),
        cid.to_string(),
        timings.clone(),
        host::owned_context(ctx),
    );
    bounded(request, ctx, move |signal, deadline| {
        upgrade(Admit {
            env,
            hints,
            source,
            cid,
            signal,
            deadline,
            ctx: owned,
            timings,
            scope: &[],
        })
    })
    .await
}
pub async fn fetch(request: Request, env: Env, ctx: Context) -> worker::Result<Response> {
    let url = request.url()?;
    if request.method() == worker::Method::Get && url.path() == "/healthz" {
        return Response::from_json(&json!({"status":"ok"}));
    }
    if url.path() == "/sql" {
        return crate::sql_host::serve(request, env, ctx).await;
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
    let isolate_requests = host::next_isolate_request();
    let cid =
        host::uuid().map_err(|_| worker::Error::RustError("runtime entropy unavailable".into()))?;
    let timings = Shared::default();
    let hints = policy::routing_hints(url.query().unwrap_or(""));
    let mut region = None;
    let mut outcome = "accepted".to_string();
    let result = match &hints {
        Ok(hints) => connect(&request, &env, &ctx, hints, &cid, &timings).await,
        Err(failure) => Err(failure.clone()),
    };
    let response = match result {
        Ok(upgraded) => {
            region = Some(upgraded.region);
            Response::from_websocket(upgraded.socket)
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
    let finished = host::now();
    let duration = finished.saturating_sub(started);
    let mut stages = timings.borrow().clone();
    stages.settle_gateway(finished);
    worker::console_log!(
        "{}",
        Log {
            event: "conn_admission",
            cid: &cid,
            colo: host::colo(&request).as_deref(),
            hints: hints.as_ref().ok(),
            region: region.as_deref(),
            duration_ms: duration,
            edge_ms: policy::edge_share(duration, &[stages.gateway_connect_ms]),
            isolate_requests,
            outcome: &outcome,
        }
        .line(&stages)
    );
    response
}

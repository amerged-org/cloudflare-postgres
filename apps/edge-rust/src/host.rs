// SPDX-License-Identifier: Apache-2.0
//! Thin bindings to the real Workers host. Admission policy and all protocol state are Rust.
use crate::policy::Failure;
use futures_channel::oneshot;
use std::{
    cell::{Cell, RefCell},
    future::Future,
    pin::Pin,
    rc::Rc,
    task::{Context as TaskContext, Poll},
};
use wasm_bindgen::{JsCast, prelude::*};
use web_sys::{AbortController, AbortSignal, Event, EventTarget, WorkerGlobalScope};
use worker::{Context, Env};

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(extends=js_sys::Object)]
    #[derive(Clone)]
    pub type ActorRpc;
    #[wasm_bindgen(method,catch,js_name=ensureAwake)]
    pub fn ensure_awake(
        this: &ActorRpc,
        database: &str,
        user: &str,
        options: &JsValue,
    ) -> Result<js_sys::Promise, JsValue>;
    #[wasm_bindgen(method,catch,js_name=cancelWakeWaiter)]
    pub fn cancel_waiter(
        this: &ActorRpc,
        database: &str,
        cid: &str,
    ) -> Result<js_sys::Promise, JsValue>;
    #[wasm_bindgen(extends=js_sys::Object)]
    type LateSocket;
    #[wasm_bindgen(method,catch,js_name=accept)]
    fn accept_late(this: &LateSocket, options: &JsValue) -> Result<(), JsValue>;
}
pub fn now() -> u64 {
    js_sys::Date::now().max(0.0) as u64
}
pub fn random<const N: usize>() -> Result<[u8; N], Failure> {
    let global: WorkerGlobalScope = js_sys::global().unchecked_into();
    let mut bytes = [0; N];
    global
        .crypto()
        .map_err(|_| Failure::gateway())?
        .get_random_values_with_u8_array(&mut bytes)
        .map_err(|_| Failure::gateway())?;
    Ok(bytes)
}
pub fn uuid() -> Result<String, Failure> {
    let mut bytes = random::<16>()?;
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    let s = bytes.iter().map(|v| format!("{v:02x}")).collect::<String>();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &s[..8],
        &s[8..12],
        &s[12..16],
        &s[16..20],
        &s[20..]
    ))
}
pub fn actor(env: &Env, database: &str) -> Result<ActorRpc, Failure> {
    let namespace = env
        .durable_object("DATABASE_ACTOR")
        .map_err(|_| Failure::gateway())?;
    Ok(namespace
        .id_from_name(database)
        .map_err(|_| Failure::gateway())?
        .get_stub()
        .map_err(|_| Failure::gateway())?
        .into_rpc())
}
pub fn owned_context(ctx: &Context) -> Context {
    let value: &JsValue = ctx.as_ref().as_ref();
    Context::new(value.clone().unchecked_into())
}
pub fn check(signal: &AbortSignal) -> Result<(), Failure> {
    if signal.aborted() {
        Err(Failure::interrupted())
    } else {
        Ok(())
    }
}
pub struct Listener {
    target: EventTarget,
    kind: &'static str,
    callback: Closure<dyn FnMut(Event)>,
}
impl Listener {
    pub fn new(
        target: EventTarget,
        kind: &'static str,
        f: impl FnMut(Event) + 'static,
    ) -> Result<Self, Failure> {
        let callback = Closure::wrap_assert_unwind_safe(Box::new(f) as Box<dyn FnMut(Event)>);
        target
            .add_event_listener_with_callback(kind, callback.as_ref().unchecked_ref())
            .map_err(|_| Failure::gateway())?;
        Ok(Self {
            target,
            kind,
            callback,
        })
    }
}
impl Listener {
    pub fn detach(&self) {
        let _ = self
            .target
            .remove_event_listener_with_callback(self.kind, self.callback.as_ref().unchecked_ref());
    }
}
impl Drop for Listener {
    fn drop(&mut self) {
        let _ = self
            .target
            .remove_event_listener_with_callback(self.kind, self.callback.as_ref().unchecked_ref());
    }
}
pub struct Timer {
    id: i32,
    _callback: Closure<dyn FnMut()>,
}
impl Timer {
    pub fn new(milliseconds: u64, f: impl FnMut() + 'static) -> Result<Self, Failure> {
        let callback = Closure::wrap_assert_unwind_safe(Box::new(f) as Box<dyn FnMut()>);
        let global: WorkerGlobalScope = js_sys::global().unchecked_into();
        let id = global
            .set_timeout_with_callback_and_timeout_and_arguments_0(
                callback.as_ref().unchecked_ref(),
                milliseconds.min(i32::MAX as u64) as i32,
            )
            .map_err(|_| Failure::gateway())?;
        Ok(Self {
            id,
            _callback: callback,
        })
    }
}
impl Timer {
    pub fn cancel(&mut self) {
        let global: WorkerGlobalScope = js_sys::global().unchecked_into();
        global.clear_timeout_with_handle(self.id);
    }
}
impl Drop for Timer {
    fn drop(&mut self) {
        let global: WorkerGlobalScope = js_sys::global().unchecked_into();
        global.clear_timeout_with_handle(self.id);
    }
}
pub struct Interrupted {
    receiver: oneshot::Receiver<()>,
    _listener: Listener,
}
impl Interrupted {
    pub fn new(signal: &AbortSignal) -> Result<Self, Failure> {
        let (sender, receiver) = oneshot::channel();
        let sender = Rc::new(RefCell::new(Some(sender)));
        let target: EventTarget = signal.clone().unchecked_into();
        let deliver = sender.clone();
        let listener = Listener::new(target, "abort", move |_| {
            if let Some(sender) = deliver.borrow_mut().take() {
                let _ = sender.send(());
            }
        })?;
        if signal.aborted()
            && let Some(sender) = sender.borrow_mut().take()
        {
            let _ = sender.send(());
        }
        Ok(Self {
            receiver,
            _listener: listener,
        })
    }
}
impl Future for Interrupted {
    type Output = ();
    fn poll(mut self: Pin<&mut Self>, ctx: &mut TaskContext<'_>) -> Poll<()> {
        Pin::new(&mut self.receiver).poll(ctx).map(|_| ())
    }
}
pub fn propagate(signal: &AbortSignal, controller: &AbortController) -> Result<Listener, Failure> {
    let target: EventTarget = signal.clone().unchecked_into();
    let trigger = controller.clone();
    let listener = Listener::new(target, "abort", move |_| trigger.abort())?;
    if signal.aborted() {
        controller.abort();
    }
    Ok(listener)
}
pub fn cancel_on_abort(
    signal: &AbortSignal,
    rpc: ActorRpc,
    database: String,
    cid: String,
    ctx: &Context,
) -> Result<Listener, Failure> {
    let sent = Rc::new(Cell::new(false));
    let ctx = owned_context(ctx);
    let target: EventTarget = signal.clone().unchecked_into();
    Listener::new(target, "abort", move |_| {
        if sent.replace(true) {
            return;
        }
        if let Ok(promise) = rpc.cancel_waiter(&database, &cid) {
            ctx.wait_until(async move {
                let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
            });
        }
    })
}
pub fn close_late(socket: worker::WebSocket) {
    let options = js_sys::Object::new();
    let _ = js_sys::Reflect::set(&options, &"allowHalfOpen".into(), &true.into());
    let raw: LateSocket = socket.as_ref().clone().unchecked_into();
    if raw.accept_late(&options).is_ok() {
        let _ = socket.close(Some(1000), Some("connection admission interrupted"));
    }
}

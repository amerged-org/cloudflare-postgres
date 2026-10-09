// SPDX-License-Identifier: Apache-2.0
//! Bounded WebSocket callbacks. No unbounded SDK event queue or SQL relay is used.
use crate::{
    decoy::{Decoy, Output, derive_salt},
    host::{self, Listener, Timer},
    policy::Hints,
};
use futures_channel::oneshot;
use pgcf_native_protocol::{constant, route::Keyring};
use std::{cell::RefCell, rc::Rc};
use wasm_bindgen::JsCast;
use web_sys::{AbortSignal, BinaryType, EventTarget, MessageEvent};
use worker::{Context, Env, Response, WebSocket, WebSocketPair};
struct State {
    socket: WebSocket,
    protocol: Decoy,
    listeners: Vec<Listener>,
    timer: Option<Timer>,
    done: Option<oneshot::Sender<()>>,
    closed: bool,
}
impl State {
    fn emit(&mut self, out: Output) {
        if self.closed {
            return;
        }
        for frame in out.frames {
            if self.socket.send_with_bytes(frame).is_err() {
                self.shutdown();
                return;
            }
        }
        if out.close {
            self.shutdown();
        }
    }
    fn shutdown(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        for listener in &self.listeners {
            listener.detach();
        }
        if let Some(timer) = self.timer.as_mut() {
            timer.cancel();
        }
        let _ = self.socket.close(Some(1000), Some("connection refused"));
        if let Some(done) = self.done.take() {
            let _ = done.send(());
        }
    }
}
pub fn response(
    hints: Hints,
    env: &Env,
    signal: &AbortSignal,
    ctx: &Context,
) -> worker::Result<Response> {
    let pair = WebSocketPair::new()?;
    pair.server
        .as_ref()
        .set_binary_type(BinaryType::Arraybuffer);
    pair.server.accept()?;
    let salt = env
        .secret("ROUTE_MASTER_KEYS")
        .ok()
        .and_then(|v| Keyring::parse(&v.to_string()).ok())
        .and_then(|keys| derive_salt(&keys, &hints).ok());
    let random = host::random::<18>()
        .map_err(|_| worker::Error::RustError("runtime entropy unavailable".into()))?;
    let (done, receiver) = oneshot::channel();
    let state = Rc::new(RefCell::new(State {
        socket: pair.server.clone(),
        protocol: Decoy::new(hints, salt, random),
        listeners: Vec::new(),
        timer: None,
        done: Some(done),
        closed: false,
    }));
    let target: EventTarget = pair.server.as_ref().clone().unchecked_into();
    let weak = Rc::downgrade(&state);
    let message = Listener::new(target.clone(), "message", move |event| {
        let Some(state) = weak.upgrade() else {
            return;
        };
        let Ok(mut state) = state.try_borrow_mut() else {
            return;
        };
        if state.closed {
            return;
        }
        let event: MessageEvent = event.unchecked_into();
        let data = event.data();
        let out = if !data.is_instance_of::<js_sys::ArrayBuffer>() {
            state.protocol.invalid_frame()
        } else {
            let buffer: js_sys::ArrayBuffer = data.unchecked_into();
            let length = buffer.byte_length() as usize;
            if !state.protocol.accepts_frame_length(length) {
                state.protocol.invalid_frame()
            } else {
                state
                    .protocol
                    .push(&js_sys::Uint8Array::new(&buffer).to_vec())
            }
        };
        state.emit(out);
    })
    .map_err(|_| worker::Error::RustError("decoy listener unavailable".into()))?;
    state.borrow_mut().listeners.push(message);
    for kind in ["close", "error"] {
        let weak = Rc::downgrade(&state);
        let listener = Listener::new(target.clone(), kind, move |_| {
            if let Some(state) = weak.upgrade()
                && let Ok(mut state) = state.try_borrow_mut()
            {
                let out = state.protocol.abort();
                state.emit(out);
            }
        })
        .map_err(|_| worker::Error::RustError("decoy listener unavailable".into()))?;
        state.borrow_mut().listeners.push(listener);
    }
    let weak = Rc::downgrade(&state);
    let aborted = Listener::new(signal.clone().unchecked_into(), "abort", move |_| {
        if let Some(state) = weak.upgrade()
            && let Ok(mut state) = state.try_borrow_mut()
        {
            let out = state.protocol.abort();
            state.emit(out);
        }
    })
    .map_err(|_| worker::Error::RustError("decoy signal unavailable".into()))?;
    state.borrow_mut().listeners.push(aborted);
    let weak = Rc::downgrade(&state);
    let timer = Timer::new(constant("DECOY_DEADLINE_MS"), move || {
        if let Some(state) = weak.upgrade()
            && let Ok(mut state) = state.try_borrow_mut()
        {
            let out = state.protocol.deadline();
            state.emit(out);
        }
    })
    .map_err(|_| worker::Error::RustError("decoy deadline unavailable".into()))?;
    state.borrow_mut().timer = Some(timer);
    let lifetime = state.clone();
    ctx.wait_until(async move {
        let _ = receiver.await;
        drop(lifetime);
    });
    if signal.aborted() {
        let mut state = state.borrow_mut();
        let out = state.protocol.abort();
        state.emit(out);
    }
    Response::from_websocket(pair.client)
}

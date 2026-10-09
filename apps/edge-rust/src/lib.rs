// SPDX-License-Identifier: Apache-2.0
//! Full Rust/Wasm Edge application. Durable admission remains in the existing TypeScript Actor.
pub mod decoy;
pub mod policy;

#[cfg(target_arch = "wasm32")]
mod decoy_host;
#[cfg(target_arch = "wasm32")]
mod gateway;
#[cfg(target_arch = "wasm32")]
mod host;
#[cfg(target_arch = "wasm32")]
mod runtime;
#[cfg(target_arch = "wasm32")]
#[worker::event(fetch)]
pub async fn fetch(
    request: worker::Request,
    env: worker::Env,
    ctx: worker::Context,
) -> worker::Result<worker::Response> {
    runtime::fetch(request, env, ctx).await
}

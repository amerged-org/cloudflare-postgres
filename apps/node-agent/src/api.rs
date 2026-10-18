// SPDX-License-Identifier: Apache-2.0
//! What the node learns from an HTTP answer of the Cloudflare API: its body, bounded, and its
//! refusal.
use crate::Error;
use futures_util::StreamExt;

/// The body of `response`, refused beyond `maximum` bytes.
pub async fn bounded(response: reqwest::Response, maximum: usize) -> Result<Vec<u8>, Error> {
    if response
        .content_length()
        .is_some_and(|v| v > maximum as u64)
    {
        return Err("HTTP response exceeds bound".into());
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(part) = stream.next().await {
        let part = part?;
        if part.len() > maximum - bytes.len() {
            return Err("HTTP response exceeds bound".into());
        }
        bytes.extend_from_slice(&part);
    }
    Ok(bytes)
}
/// A Cloudflare API refusal with its HTTP status and error code.
#[derive(Debug)]
pub struct Refusal {
    pub status: u16,
    pub code: Option<String>,
}
impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Cloudflare API HTTP{}", self.status)
    }
}
impl std::error::Error for Refusal {}

// SPDX-License-Identifier: Apache-2.0
//! Operation-scoped, signed transport to Cloudflare's private cold-snapshot namespace. No R2
//! credential or caller-selected URL crosses this interface. All artifact PUTs are immutable.
use super::Link;
use crate::archive::cold_snapshot::{
    CHUNK_BYTES, MANIFEST_MAX_BYTES, MAX_CHUNKS, Store, Transfer, Transport,
};
use reqwest::Method;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;

struct Operation {
    link: Link,
    operation: String,
}

fn operation_path(operation: &str, tail: &str) -> Result<String, &'static str> {
    if !operation.strip_prefix("op_").is_some_and(|id| {
        id.len() == 20
            && id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    }) {
        return Err("invalid_cold_snapshot_operation");
    }
    let prefix = crate::node_link::constant("NODE_API_PATHS")["coldSnapshots"]
        .as_str()
        .ok_or("cold_snapshot_contract_missing")?;
    Ok(format!("{prefix}{operation}/{tail}"))
}

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

impl Store for Link {
    fn operation(&self, operation: &str) -> Arc<dyn Transport> {
        Arc::new(Operation {
            link: self.clone(),
            operation: operation.to_string(),
        })
    }
}

impl Operation {
    async fn request(
        &self,
        method: Method,
        tail: &str,
        body: Option<Vec<u8>>,
        media_type: &'static str,
        maximum: usize,
    ) -> Result<Vec<u8>, &'static str> {
        let path = operation_path(&self.operation, tail)?;
        self.link
            .inner
            .api
            .raw(method, &path, body, media_type, maximum)
            .await
            .map_err(|_| "cold_snapshot_transfer_failed")
    }
}

impl Transport for Operation {
    fn put_manifest<'a>(&'a self, bytes: &'a [u8], sha256: &'a str) -> Transfer<'a, ()> {
        Box::pin(async move {
            if bytes.is_empty() || bytes.len() > MANIFEST_MAX_BYTES || digest(bytes) != sha256 {
                return Err("cold_snapshot_manifest_invalid");
            }
            let bytes = self
                .request(
                    Method::PUT,
                    "manifest",
                    Some(bytes.to_vec()),
                    "application/json",
                    64 * 1024,
                )
                .await?;
            let answer: Value =
                serde_json::from_slice(&bytes).map_err(|_| "cold_snapshot_transfer_invalid")?;
            if answer["declared"] != true
                || answer["manifest_sha256"] != sha256
                || answer["total_chunks"]
                    .as_u64()
                    .is_none_or(|n| n == 0 || n > MAX_CHUNKS as u64)
            {
                return Err("cold_snapshot_transfer_invalid");
            }
            Ok(())
        })
    }
    fn get_manifest(&self) -> Transfer<'_, Vec<u8>> {
        Box::pin(self.request(
            Method::GET,
            "manifest",
            None,
            "application/json",
            MANIFEST_MAX_BYTES,
        ))
    }
    fn put_chunk<'a>(&'a self, index: u32, bytes: &'a [u8], sha256: &'a str) -> Transfer<'a, ()> {
        Box::pin(async move {
            if index as usize >= MAX_CHUNKS
                || bytes.is_empty()
                || bytes.len() > CHUNK_BYTES
                || digest(bytes) != sha256
            {
                return Err("cold_snapshot_chunk_invalid");
            }
            let result = self
                .request(
                    Method::PUT,
                    &format!("chunks/{index}"),
                    Some(bytes.to_vec()),
                    "application/octet-stream",
                    64 * 1024,
                )
                .await?;
            let answer: Value =
                serde_json::from_slice(&result).map_err(|_| "cold_snapshot_transfer_invalid")?;
            if answer["index"].as_u64() != Some(u64::from(index))
                || answer["size_bytes"].as_u64() != Some(bytes.len() as u64)
                || answer["sha256"] != sha256
            {
                return Err("cold_snapshot_transfer_invalid");
            }
            Ok(())
        })
    }
    fn get_chunk(&self, index: u32) -> Transfer<'_, Vec<u8>> {
        Box::pin(async move {
            if index as usize >= MAX_CHUNKS {
                return Err("cold_snapshot_chunk_invalid");
            }
            self.request(
                Method::GET,
                &format!("chunks/{index}"),
                None,
                "application/octet-stream",
                CHUNK_BYTES,
            )
            .await
        })
    }
    fn seal<'a>(&'a self, manifest_sha256: &'a str) -> Transfer<'a, ()> {
        Box::pin(async move {
            if manifest_sha256.len() != 64
                || !manifest_sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err("cold_snapshot_manifest_invalid");
            }
            let body = serde_json::to_vec(&json!({"manifest_sha256": manifest_sha256}))
                .map_err(|_| "cold_snapshot_manifest_invalid")?;
            let mut previous = 0;
            let mut expected_total = None;
            // Each successful pending response must advance the finite manifest's checked prefix.
            // Transport failures are reconciled by the operation, never by replaying application SQL.
            for _ in 0..=MAX_CHUNKS {
                let bytes = self
                    .request(
                        Method::POST,
                        "seal",
                        Some(body.clone()),
                        "application/json",
                        64 * 1024,
                    )
                    .await?;
                let answer: Value =
                    serde_json::from_slice(&bytes).map_err(|_| "cold_snapshot_transfer_invalid")?;
                let total = answer["total_chunks"]
                    .as_u64()
                    .filter(|n| *n > 0 && *n <= MAX_CHUNKS as u64)
                    .ok_or("cold_snapshot_transfer_invalid")?;
                let checked = answer["checked_chunks"]
                    .as_u64()
                    .filter(|n| *n <= total)
                    .ok_or("cold_snapshot_transfer_invalid")?;
                if answer["manifest_sha256"] != manifest_sha256
                    || expected_total.is_some_and(|n| n != total)
                {
                    return Err("cold_snapshot_transfer_invalid");
                }
                if answer["sealed"] == true {
                    return if checked == total {
                        Ok(())
                    } else {
                        Err("cold_snapshot_transfer_invalid")
                    };
                }
                if answer["sealed"] != false || checked <= previous {
                    return Err("cold_snapshot_seal_stalled");
                }
                previous = checked;
                expected_total = Some(total);
            }
            Err("cold_snapshot_seal_stalled")
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshot_urls_are_operation_scoped_and_reject_path_injection() {
        assert_eq!(
            operation_path("op_abcdefghijklmnopqrst", "manifest").unwrap(),
            "/node/v1/cold-snapshots/op_abcdefghijklmnopqrst/manifest"
        );
        assert!(operation_path("op_abcdefghijklmnopqrs/../other", "manifest").is_err());
        assert!(operation_path("https://other.example", "manifest").is_err());
    }
}

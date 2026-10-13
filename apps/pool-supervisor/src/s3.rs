// SPDX-License-Identifier: Apache-2.0
//! Fetch one exact Barman catalog object with the archiver's own existing S3 credentials.
use crate::{Error, protocol::text};
use futures_util::StreamExt;
use hmac::{Hmac, KeyInit, Mac};
use serde_json::Value;
use sha2::Sha256;

fn hash(bytes: &[u8]) -> String {
    crate::sha256(bytes)
}
fn unavailable(error: reqwest::Error) -> Error {
    use std::error::Error as _;
    let mut cause = error.source();
    while let Some(current) = cause {
        let text = current.to_string();
        if ["certificate", "Certificate", "UnknownIssuer"]
            .iter()
            .any(|word| text.contains(word))
        {
            return Error("pool_archive_tls_refused");
        }
        cause = current.source();
    }
    if error.is_builder() {
        Error("pool_archive_client_invalid")
    } else if error.is_connect() {
        Error("pool_archive_connection_unavailable")
    } else {
        Error("pool_archive_unavailable")
    }
}
fn hmac(key: &[u8], text: &str) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key size");
    mac.update(text.as_bytes());
    mac.finalize().into_bytes().to_vec()
}
fn escaped(text: &str) -> String {
    text.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~/".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
pub async fn catalog(config: &Value, id: &str) -> Result<Vec<u8>, Error> {
    if id.len() != 15
        || !id.bytes().enumerate().all(|(i, b)| {
            if i == 8 {
                b == b'T'
            } else {
                b.is_ascii_digit()
            }
        })
    {
        return Err(Error("pool_backup_catalog_identity"));
    }
    let location = text(config, "destination_path")?
        .strip_prefix("s3://")
        .ok_or(Error("pool_archive_invalid"))?;
    let (bucket, prefix) = location.split_once('/').unwrap_or((location, ""));
    if bucket.is_empty()
        || !bucket
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
    {
        return Err(Error("pool_archive_invalid"));
    }
    let mut endpoint = reqwest::Url::parse(text(config, "endpoint_url")?)
        .map_err(|_| Error("pool_archive_invalid"))?;
    if endpoint.scheme() != "https"
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
    {
        return Err(Error("pool_archive_invalid"));
    }
    let path = format!(
        "/{}/{}/database/base/{}/backup.info",
        bucket,
        prefix.trim_matches('/'),
        id
    )
    .replace("//", "/");
    endpoint.set_path(&escaped(&path));
    let host = endpoint.host_str().ok_or(Error("pool_archive_invalid"))?;
    let host = endpoint
        .port()
        .map_or_else(|| host.to_owned(), |port| format!("{host}:{port}"));
    let key = std::env::var("AWS_ACCESS_KEY_ID")
        .map_err(|_| Error("pool_archive_credentials_missing"))?;
    let secret = std::env::var("AWS_SECRET_ACCESS_KEY")
        .map_err(|_| Error("pool_archive_credentials_missing"))?;
    let token = std::env::var("AWS_SESSION_TOKEN").ok();
    if key.is_empty()
        || secret.is_empty()
        || key.contains(['\r', '\n'])
        || token.as_ref().is_some_and(|v| v.contains(['\r', '\n']))
    {
        return Err(Error("pool_archive_credentials_invalid"));
    }
    let time = time::OffsetDateTime::now_utc();
    let date = format!(
        "{:04}{:02}{:02}",
        time.year(),
        u8::from(time.month()),
        time.day()
    );
    let at = format!(
        "{}T{:02}{:02}{:02}Z",
        date,
        time.hour(),
        time.minute(),
        time.second()
    );
    let empty = hash(b"");
    let mut headers = format!("host:{host}\nx-amz-content-sha256:{empty}\nx-amz-date:{at}\n");
    let mut signed = "host;x-amz-content-sha256;x-amz-date".to_string();
    if let Some(token) = &token {
        headers.push_str(&format!("x-amz-security-token:{token}\n"));
        signed.push_str(";x-amz-security-token");
    }
    let canonical = format!(
        "GET\n{}\n\n{}\n{}\n{}",
        endpoint.path(),
        headers,
        signed,
        empty
    );
    let scope = format!("{date}/auto/s3/aws4_request");
    let sign = hmac(
        &hmac(
            &hmac(&hmac(format!("AWS4{secret}").as_bytes(), &date), "auto"),
            "s3",
        ),
        "aws4_request",
    );
    let signature = hmac(
        &sign,
        &format!(
            "AWS4-HMAC-SHA256\n{at}\n{scope}\n{}",
            hash(canonical.as_bytes())
        ),
    )
    .iter()
    .map(|b| format!("{b:02x}"))
    .collect::<String>();
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(60));
    if let Ok(path) = std::env::var("AWS_CA_BUNDLE") {
        let bytes = std::fs::read(path).map_err(|_| Error("pool_archive_ca_unavailable"))?;
        for cert in reqwest::Certificate::from_pem_bundle(&bytes)
            .map_err(|_| Error("pool_archive_ca_invalid"))?
        {
            builder = builder.add_root_certificate(cert);
        }
    }
    let mut request=builder.build().map_err(unavailable)?.get(endpoint)
        .header("x-amz-date",at).header("x-amz-content-sha256",empty)
        .header("authorization",format!("AWS4-HMAC-SHA256 Credential={key}/{scope}, SignedHeaders={signed}, Signature={signature}"));
    if let Some(token) = token {
        request = request.header("x-amz-security-token", token);
    }
    let response = request.send().await.map_err(unavailable)?;
    if !response.status().is_success() {
        return Err(Error("pool_backup_catalog_unavailable"));
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| Error("pool_backup_catalog_unavailable"))?;
        if bytes.len() + chunk.len() > 1024 * 1024 {
            return Err(Error("pool_backup_catalog_oversized"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

// SPDX-License-Identifier: Apache-2.0
//! Requests to the node API: TLS to Cloudflare only, every answer bounded, every request after the
//! enrollment signed with the node's key (`NodeRequestClaims`).
use super::{events::Events, identity::Identity};
use crate::{
    Error,
    api::{Refusal, bounded},
    node_link::schema_valid,
};
use reqwest::{Client, Method, Url, header::CONTENT_TYPE};
use rustls::RootCertStore;
use serde_json::Value;
use std::{
    net::{IpAddr, Ipv4Addr},
    path::Path,
    sync::Arc,
    time::Duration,
};

/// The largest request body: a volume report of 10,000 volumes is about 2.3 MB.
const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;
/// The largest answer: the desired page the contract allows, 200 databases of 100 roles with every
/// attribute (78 KB each) and 1,000 open orders, which is 15.8 MB. Origins and the release add
/// less than 1 MB. A page the contract accepts is never refused for its size.
const MAX_RESPONSE_BYTES: usize = 20 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// A pinned file (a binary, a package) may take its time on a node's connection.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Package archives answer a request with a redirect to the file; no more hops than that.
const DOWNLOAD_REDIRECTS: usize = 5;

/// Cloudflare refused the node's key with 403 `node_fenced`: the node was declared lost (plan
/// 9.4). Its key signs only the desired page and the observations.
#[derive(Debug)]
pub struct Fenced;
impl std::fmt::Display for Fenced {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "node fenced")
    }
}
impl std::error::Error for Fenced {}

/// How the node reaches Cloudflare: HTTPS and TLS WebSockets, trusting `roots` alone.
#[derive(Clone)]
pub struct Transport {
    pub(super) client: Client,
    /// The client of the enrollment. The Worker accepts the enrollment only from the instance's
    /// own public IPv4 (plan 8), so it connects over IPv4 alone: a node with an IPv6 route would
    /// otherwise reach a dual-stack Cloudflare address over IPv6, be refused for good, and never
    /// enroll.
    pub(super) enrollment: Client,
    /// The client of the files a release pins: HTTPS only, with a few redirects and no credential.
    download: Client,
    pub(super) tls: Arc<rustls::ClientConfig>,
}
impl Transport {
    pub fn new(roots: RootCertStore) -> Result<Self, Error> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let config = || {
            rustls::ClientConfig::builder()
                .with_root_certificates(roots.clone())
                .with_no_client_auth()
        };
        let client = |local_address: Option<IpAddr>| {
            Client::builder()
                .use_preconfigured_tls(config())
                .https_only(true)
                .no_proxy()
                .retry(reqwest::retry::never())
                .redirect(reqwest::redirect::Policy::none())
                .timeout(REQUEST_TIMEOUT)
                .local_address(local_address)
                .build()
        };
        Ok(Self {
            client: client(None)?,
            enrollment: client(Some(Ipv4Addr::UNSPECIFIED.into()))?,
            download: Client::builder()
                .use_preconfigured_tls(config())
                .https_only(true)
                .no_proxy()
                .retry(reqwest::retry::never())
                .redirect(reqwest::redirect::Policy::limited(DOWNLOAD_REDIRECTS))
                .timeout(DOWNLOAD_TIMEOUT)
                .build()?,
            tls: Arc::new(config()),
        })
    }
    /// The public web PKI.
    pub fn production() -> Result<Self, Error> {
        Self::new(RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
        })
    }

    /// Brings the file at `url` to `destination` (mode 0600) if, and only if, it has exactly
    /// `size` bytes and the digest `sha256`. The size bounds the download, so a server cannot
    /// fill the disk, and a file that fails any check is removed.
    pub async fn fetch(
        &self,
        url: &str,
        size: u64,
        sha256: &str,
        destination: &Path,
    ) -> Result<(), Error> {
        let result = self.download_to(url, size, sha256, destination).await;
        if result.is_err() {
            let _ = std::fs::remove_file(destination);
        }
        result
    }
    async fn download_to(
        &self,
        url: &str,
        size: u64,
        sha256: &str,
        destination: &Path,
    ) -> Result<(), Error> {
        use sha2::{Digest, Sha256};
        use tokio::io::AsyncWriteExt;
        let mut response = self.download.get(url).send().await?;
        if !response.status().is_success() {
            return Err("download refused".into());
        }
        if response
            .content_length()
            .is_some_and(|length| length != size)
        {
            return Err("download has another size than its pin".into());
        }
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(destination)
            .await?;
        let (mut digest, mut seen) = (Sha256::new(), 0u64);
        while let Some(chunk) = response.chunk().await? {
            seen += chunk.len() as u64;
            if seen > size {
                return Err("download is larger than its pin".into());
            }
            digest.update(&chunk);
            file.write_all(&chunk).await?;
        }
        file.sync_all().await?;
        let digest: String = digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        if seen != size || digest != sha256 {
            return Err("download does not match its pin".into());
        }
        Ok(())
    }
}

/// The body of a success, or the reason of a refusal: `Fenced` for 403 `node_fenced`, otherwise
/// the status and error code of Cloudflare's answer.
pub(super) async fn finish(response: reqwest::Response, maximum: usize) -> Result<Vec<u8>, Error> {
    let status = response.status();
    if status.is_success() {
        return bounded(response, maximum).await;
    }
    let body = bounded(response, 64 * 1024)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    if status.as_u16() == 403
        && body
            .as_ref()
            .is_some_and(|b| schema_valid("NodeFencedResponse", b))
    {
        return Err(Box::new(Fenced));
    }
    Err(Box::new(Refusal {
        status: status.as_u16(),
        code: body.and_then(|body| body["error"]["code"].as_str().map(str::to_string)),
    }))
}

/// Signed requests of one enrolled node.
pub(super) struct Api {
    transport: Transport,
    identity: Arc<Identity>,
    events: Arc<Events>,
}
impl Api {
    pub fn new(transport: Transport, identity: Arc<Identity>, events: Arc<Events>) -> Self {
        Self {
            transport,
            identity,
            events,
        }
    }
    pub fn identity(&self) -> &Arc<Identity> {
        &self.identity
    }
    pub fn transport(&self) -> &Transport {
        &self.transport
    }
    /// GET `target` (a path with its query), answered with JSON.
    pub async fn get(&self, target: &str) -> Result<Value, Error> {
        Ok(serde_json::from_slice(
            &self.send(Method::GET, target, None).await?,
        )?)
    }
    /// POST `body` to `path`; any success is the acknowledgement.
    pub async fn post(&self, path: &str, body: &Value) -> Result<(), Error> {
        let encoded = serde_json::to_vec(body)?;
        if encoded.len() > MAX_REQUEST_BYTES {
            return Err("node request exceeds bound".into());
        }
        self.send(Method::POST, path, Some(encoded)).await?;
        Ok(())
    }
    /// The URL of `target` (a path with its query) and the bearer token of a request for it. The
    /// token binds the path and the query exactly as the URL spells them.
    pub fn signed(&self, method: &str, target: &str, body: &[u8]) -> Result<(Url, String), Error> {
        let url = self.identity.node_url(target)?;
        let bound = match url.query() {
            Some(query) => format!("{}?{query}", url.path()),
            None => url.path().to_string(),
        };
        Ok((url, self.identity.bearer(method, &bound, body)?))
    }
    async fn send(
        &self,
        method: Method,
        target: &str,
        body: Option<Vec<u8>>,
    ) -> Result<Vec<u8>, Error> {
        let (url, bearer) = self.signed(method.as_str(), target, body.as_deref().unwrap_or(&[]))?;
        let mut request = self
            .transport
            .client
            .request(method, url)
            .bearer_auth(bearer);
        if let Some(body) = body {
            request = request.header(CONTENT_TYPE, "application/json").body(body);
        }
        let answer = finish(request.send().await?, MAX_RESPONSE_BYTES).await;
        if answer.as_ref().is_err_and(|error| error.is::<Fenced>()) {
            self.events.fence();
        }
        answer
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use crate::link::test_server::{Cloud, Failure, tempdir};

    /// An enrolled node of `cloud`: the pieces a test needs to make requests as the node. Its
    /// files are removed on return: the identity and the key live in the returned `Api`.
    pub(crate) async fn enrolled(cloud: &Cloud) -> (Api, Arc<Events>) {
        let base = tempdir();
        cloud.seed(&base);
        let transport = Transport::new(cloud.roots()).unwrap();
        let identity = super::super::identity::establish(
            &super::super::identity::Paths::new(&base),
            &transport,
            "25",
            &super::super::Timing::default(),
        )
        .await
        .unwrap();
        let events = Arc::new(Events::default());
        (
            Api::new(transport, Arc::new(identity), events.clone()),
            events,
        )
    }

    #[tokio::test]
    async fn requests_are_signed_for_their_method_path_query_and_body() {
        let cloud = Cloud::start().await;
        let (api, _) = enrolled(&cloud).await;
        api.get("/node/v1/desired?limit=2&after=a0000000000000000009")
            .await
            .unwrap();
        let body = serde_json::json!({"observed_at":"2026-10-17T12:00:00.000Z","databases":[],"orders":[]});
        api.post("/node/v1/observations", &body).await.unwrap();
        let seen = cloud.requests();
        // The enrollment is unsigned; the others verified as the Worker verifies them.
        assert_eq!(seen[0].signed, None);
        assert_eq!(seen.len(), 3);
        assert!(seen[1..].iter().all(|s| s.signed == Some(Ok(()))));
        assert_eq!(seen[2].body, body);
        // The double does refuse a request that the key did not sign.
        cloud.with(|inner| inner.public_key = Some(vec![1; 32]));
        let error = api.get("/node/v1/desired").await.unwrap_err();
        assert_eq!(error.downcast_ref::<Refusal>().unwrap().status, 401);
        assert_eq!(
            cloud.requests().last().unwrap().signed,
            Some(Err("signature"))
        );
    }

    #[tokio::test]
    async fn a_pinned_file_is_kept_only_when_it_has_the_pinned_size_and_digest() {
        use sha2::{Digest, Sha256};
        let cloud = Cloud::start().await;
        let url = cloud.serve_file("/files/a", b"hello world".to_vec());
        let digest: String = Sha256::digest(b"hello world")
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let transport = Transport::new(cloud.roots()).unwrap();
        let directory = tempdir();
        let fetch = |url: &str, size: u64, digest: &str, name: &str| {
            let (transport, path) = (transport.clone(), directory.join(name));
            let (url, digest) = (url.to_string(), digest.to_string());
            async move { transport.fetch(&url, size, &digest, &path).await }
        };
        fetch(&url, 11, &digest, "good").await.unwrap();
        assert_eq!(
            std::fs::read(directory.join("good")).unwrap(),
            b"hello world"
        );
        // Another digest, a smaller or a larger size than the pin, a file that is not there and a
        // URL that is not HTTPS: refused, and nothing is left behind.
        let other = "0".repeat(64);
        let refused = [
            fetch(&url, 11, &other, "digest").await,
            fetch(&url, 10, &digest, "smaller").await,
            fetch(&url, 12, &digest, "larger").await,
            fetch(&cloud.url("/files/missing"), 11, &digest, "missing").await,
            fetch(&url.replace("https:", "http:"), 11, &digest, "plain").await,
        ];
        assert!(refused.iter().all(Result::is_err), "{refused:?}");
        for name in ["digest", "smaller", "larger", "missing", "plain"] {
            assert!(!directory.join(name).exists(), "{name}");
        }
    }

    #[tokio::test]
    async fn a_request_only_goes_to_the_node_api_of_the_node_origin() {
        let cloud = Cloud::start().await;
        let (api, _) = enrolled(&cloud).await;
        for target in [
            "//evil.example/node/v1/desired",
            "https://evil.example/node/v1/desired",
            "/node/v2/desired",
            "/other",
        ] {
            assert!(api.signed("GET", target, &[]).is_err(), "{target}");
        }
        assert!(api.signed("GET", "/node/v1/desired?limit=2", &[]).is_ok());
    }

    #[tokio::test]
    async fn a_node_fenced_answer_is_a_fence_and_any_other_refusal_is_not() {
        let cloud = Cloud::start().await;
        let (api, events) = enrolled(&cloud).await;
        cloud.fail_next([Failure::Status(503)]);
        let error = api
            .post("/node/v1/volumes", &serde_json::json!({}))
            .await
            .unwrap_err();
        let refusal = error.downcast_ref::<Refusal>().unwrap();
        assert_eq!(
            (refusal.status, refusal.code.as_deref()),
            (503, Some("unavailable"))
        );
        assert!(!events.fenced());
        // A fenced node still pulls its page; everything else it signs is answered node_fenced.
        cloud.with(|inner| inner.fenced = true);
        api.get("/node/v1/desired").await.unwrap();
        assert!(!events.fenced());
        let error = api.get("/node/v1/credentials").await.unwrap_err();
        assert!(error.downcast_ref::<Fenced>().is_some());
        assert!(events.fenced());
        assert!(schema_valid(
            "NodeFencedResponse",
            &serde_json::json!({"error":"node_fenced"})
        ));
    }
}

// SPDX-License-Identifier: Apache-2.0
use crate::{Error, contracts::text};
use futures_util::StreamExt;
use reqwest::{Client, Method, StatusCode, Url};
use rustls_pki_types::{CertificateDer, pem::PemObject};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fmt, path::PathBuf, time::Duration};
use std::{
    net::{IpAddr, SocketAddr},
    sync::Arc,
};
#[derive(Debug)]
struct KubeletVerifier {
    inner: Arc<rustls::client::WebPkiServerVerifier>,
    leaf: Vec<u8>,
    name: String,
}
impl rustls::client::danger::ServerCertVerifier for KubeletVerifier {
    fn verify_server_cert(
        &self,
        end: &rustls::pki_types::CertificateDer<'_>,
        chain: &[rustls::pki_types::CertificateDer<'_>],
        name: &rustls::pki_types::ServerName<'_>,
        ocsp: &[u8],
        now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        if end.as_ref() != self.leaf {
            return Err(rustls::Error::General("kubelet leaf pin changed".into()));
        }
        let (_, cert) = x509_parser::parse_x509_certificate(end.as_ref())
            .map_err(|_| rustls::Error::General("kubelet certificate invalid".into()))?;
        let exact=cert.subject_alternative_name().map_err(|_|rustls::Error::General("kubelet SAN invalid".into()))?.is_some_and(|san|san.value.general_names.iter().any(|n|matches!(n,x509_parser::extensions::GeneralName::DNSName(n) if *n==self.name)));
        if !exact {
            return Err(rustls::Error::General("kubelet identity mismatch".into()));
        }
        self.inner.verify_server_cert(end, chain, name, ocsp, now)
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        signature: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, signature)
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        signature: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, signature)
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

#[derive(Debug)]
pub struct KubernetesError {
    pub status: u16,
}
impl fmt::Display for KubernetesError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Kubernetes HTTP{}", self.status)
    }
}
impl std::error::Error for KubernetesError {}
#[derive(Clone)]
pub struct Kubernetes {
    client: Client,
    origin: Url,
    token: PathBuf,
}
fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 253
        && value.split('.').all(|part| {
            !part.is_empty()
                && part
                    .as_bytes()
                    .first()
                    .is_some_and(u8::is_ascii_alphanumeric)
                && part
                    .as_bytes()
                    .last()
                    .is_some_and(u8::is_ascii_alphanumeric)
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}
fn collection(kind: &str, namespace: Option<&str>) -> Result<String, Error> {
    let (prefix, plural, cluster) = match kind {
        "Namespace" => ("/api/v1", "namespaces", true),
        "Node" => ("/api/v1", "nodes", true),
        "PersistentVolume" => ("/api/v1", "persistentvolumes", true),
        "Pod" => ("/api/v1", "pods", false),
        "Secret" => ("/api/v1", "secrets", false),
        "ConfigMap" => ("/api/v1", "configmaps", false),
        "ResourceQuota" => ("/api/v1", "resourcequotas", false),
        "LimitRange" => ("/api/v1", "limitranges", false),
        "PersistentVolumeClaim" => ("/api/v1", "persistentvolumeclaims", false),
        "Cluster" => ("/apis/postgresql.cnpg.io/v1", "clusters", false),
        "ScheduledBackup" => ("/apis/postgresql.cnpg.io/v1", "scheduledbackups", false),
        "Backup" => ("/apis/postgresql.cnpg.io/v1", "backups", false),
        "ObjectStore" => ("/apis/barmancloud.cnpg.io/v1", "objectstores", false),
        "LVMVolume" => ("/apis/local.openebs.io/v1alpha1", "lvmvolumes", false),
        "NetworkPolicy" => ("/apis/networking.k8s.io/v1", "networkpolicies", false),
        "CiliumNetworkPolicy" => ("/apis/cilium.io/v2", "ciliumnetworkpolicies", false),
        "DaemonSet" => ("/apis/apps/v1", "daemonsets", false),
        "HelmRelease" => ("/apis/helm.toolkit.fluxcd.io/v2", "helmreleases", false),
        "OCIRepository" => (
            "/apis/source.toolkit.fluxcd.io/v1",
            "ocirepositories",
            false,
        ),
        "HelmChart" => ("/apis/source.toolkit.fluxcd.io/v1", "helmcharts", false),
        "GitRepository" => (
            "/apis/source.toolkit.fluxcd.io/v1",
            "gitrepositories",
            false,
        ),
        "Kustomization" => (
            "/apis/kustomize.toolkit.fluxcd.io/v1",
            "kustomizations",
            false,
        ),
        "Job" => ("/apis/batch/v1", "jobs", false),
        _ => return Err("unsupported Kubernetes resource".into()),
    };
    if cluster && namespace.is_some() {
        return Err("invalid Kubernetes namespace scope".into());
    }
    if let Some(ns) = namespace {
        if !identifier(ns) {
            return Err("invalid Kubernetes namespace".into());
        }
        Ok(format!("{prefix}/namespaces/{ns}/{plural}"))
    } else {
        Ok(format!("{prefix}/{plural}"))
    }
}
fn named(kind: &str, namespace: Option<&str>, name: &str) -> Result<String, Error> {
    if !identifier(name) {
        return Err("invalid Kubernetes resource name".into());
    }
    if namespace.is_none() && !["Namespace", "Node", "PersistentVolume"].contains(&kind) {
        return Err("namespaced Kubernetes read requires namespace".into());
    }
    Ok(format!("{}/{name}", collection(kind, namespace)?))
}
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
impl Kubernetes {
    pub async fn version(&self) -> Result<Value, Error> {
        self.request(Method::GET, "/version", None)
            .await?
            .ok_or_else(|| "Kubernetes version unavailable".into())
    }
    pub async fn stats_summary(&self, node: &str) -> Result<Value, Error> {
        if !identifier(node) {
            return Err("invalid kubelet node name".into());
        }
        let subject = self
            .read("Node", None, node)
            .await?
            .ok_or("kubelet node missing")?;
        let uid = text(&subject["metadata"], "uid");
        if uid.is_empty() || !subject["metadata"]["deletionTimestamp"].is_null() {
            return Err("kubelet node identity missing".into());
        }
        let cluster = self
            .read("Namespace", None, "kube-system")
            .await?
            .ok_or("cluster identity missing")?;
        let trust = self
            .read("ConfigMap", Some("pgcf-system"), &format!("kubelet-{uid}"))
            .await?
            .ok_or("pinned kubelet trust is missing")?;
        if trust["metadata"]["labels"]["pgcf.io/kubelet-node-uid"] != uid
            || trust["data"]["node_uid"] != uid
            || trust["data"]["node_name"] != node
            || trust["data"]["cluster_uid"] != cluster["metadata"]["uid"]
            || !trust["metadata"]["deletionTimestamp"].is_null()
            || text(&trust["metadata"], "resourceVersion").is_empty()
        {
            return Err("pinned kubelet association changed".into());
        }
        let pem = text(&trust["data"], "certificate_pem");
        let digest = Sha256::digest(pem.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        if pem.is_empty()
            || pem.len() > 16 * 1024
            || pem.contains("PRIVATE KEY")
            || text(&trust["data"], "certificate_sha256") != digest
        {
            return Err("pinned kubelet certificate changed".into());
        }
        let certs =
            CertificateDer::pem_slice_iter(pem.as_bytes()).collect::<Result<Vec<_>, _>>()?;
        if certs.is_empty() || certs.len() > 8 {
            return Err("kubelet certificate chain invalid".into());
        }
        let mut roots = rustls::RootCertStore::empty();
        for cert in &certs {
            let (_, parsed) = x509_parser::parse_x509_certificate(cert.as_ref())
                .map_err(|_| "kubelet certificate invalid")?;
            if !parsed.validity().is_valid() {
                return Err("kubelet certificate expired or future".into());
            }
            roots.add(cert.clone())?;
        }
        let verifier = rustls::client::WebPkiServerVerifier::builder(Arc::new(roots)).build()?;
        let tls = rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(KubeletVerifier {
                inner: verifier,
                leaf: certs[0].as_ref().to_vec(),
                name: node.to_string(),
            }))
            .with_no_client_auth();
        let addresses = subject["status"]["addresses"]
            .as_array()
            .ok_or("node addresses unavailable")?;
        let ips = addresses
            .iter()
            .filter(|a| text(a, "type") == "InternalIP")
            .map(|a| text(a, "address").parse::<IpAddr>())
            .collect::<Result<Vec<_>, _>>()?;
        if ips.is_empty()
            || ips.len() > 2
            || (ips.len() == 2 && ips[0].is_ipv4() == ips[1].is_ipv4())
        {
            return Err("kubelet internal address ambiguous".into());
        }
        let client = Client::builder()
            .use_preconfigured_tls(tls)
            .resolve(node, SocketAddr::new(ips[0], 10250))
            .no_proxy()
            .retry(reqwest::retry::never())
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()?;
        let token = tokio::fs::read_to_string(&self.token).await?;
        let response = client
            .get(format!("https://{node}:10250/stats/summary"))
            .bearer_auth(token.trim())
            .send()
            .await?;
        if !response.status().is_success() {
            return Err("kubelet stats unavailable".into());
        }
        let bytes = bounded(response, 2 * 1024 * 1024).await?;
        let after = self
            .read("Namespace", None, "kube-system")
            .await?
            .ok_or("cluster identity disappeared")?;
        if after["metadata"]["uid"] != cluster["metadata"]["uid"] {
            return Err("cluster identity changed during kubelet proof".into());
        }
        Ok(serde_json::from_slice(&bytes)?)
    }
    pub async fn watch_database_ids(
        &self,
        kind: &str,
        events: tokio::sync::mpsc::Sender<String>,
    ) -> Result<(), Error> {
        if !["Pod", "Cluster", "PersistentVolumeClaim"].contains(&kind) {
            return Err("unsupported controller watch".into());
        }
        let path = collection(kind, None)?;
        let mut url = self.origin.join(&path)?;
        url.query_pairs_mut()
            .append_pair("limit", "1")
            .append_pair("labelSelector", "pgcf.io/database-id");
        let initial = self
            .request(
                Method::GET,
                &format!("{}?{}", url.path(), url.query().unwrap_or("")),
                None,
            )
            .await?
            .ok_or("watch baseline missing")?;
        let mut version = text(&initial["metadata"], "resourceVersion").to_string();
        if version.is_empty() {
            return Err("watch baseline has no resource version".into());
        }
        loop {
            let mut url = self.origin.join(&path)?;
            url.query_pairs_mut()
                .append_pair("watch", "true")
                .append_pair("allowWatchBookmarks", "true")
                .append_pair("timeoutSeconds", "60")
                .append_pair("resourceVersion", &version)
                .append_pair("labelSelector", "pgcf.io/database-id");
            let token = tokio::fs::read_to_string(&self.token).await?;
            let response = tokio::time::timeout(
                Duration::from_secs(10),
                self.client
                    .get(url)
                    .bearer_auth(token.trim())
                    .timeout(Duration::from_secs(65))
                    .send(),
            )
            .await??;
            if !response.status().is_success() {
                return Err(Box::new(KubernetesError {
                    status: response.status().as_u16(),
                }));
            }
            let mut stream = response.bytes_stream();
            let mut pending = Vec::new();
            while let Some(bytes) = stream.next().await {
                let bytes = bytes?;
                if bytes.len() > 1024 * 1024 - pending.len() {
                    return Err("Kubernetes watch frame exceeds bound".into());
                }
                pending.extend_from_slice(&bytes);
                while let Some(end) = pending.iter().position(|b| *b == b'\n') {
                    let line: Vec<_> = pending.drain(..=end).collect();
                    if line.iter().all(u8::is_ascii_whitespace) {
                        continue;
                    }
                    let event: Value = serde_json::from_slice(&line)?;
                    let event_type = text(&event, "type");
                    if event_type == "ERROR" {
                        return Err("Kubernetes watch history gap".into());
                    }
                    if !["ADDED", "MODIFIED", "DELETED", "BOOKMARK"].contains(&event_type) {
                        return Err("Kubernetes watch event invalid".into());
                    }
                    let rv = text(&event["object"]["metadata"], "resourceVersion");
                    if rv.is_empty() {
                        return Err("Kubernetes watch revision missing".into());
                    }
                    version = rv.to_string();
                    if event_type != "BOOKMARK" {
                        let id = text(
                            &event["object"]["metadata"]["labels"],
                            "pgcf.io/database-id",
                        );
                        if pgcf_native_protocol::valid_pattern("database", id) {
                            events
                                .try_send(id.to_string())
                                .map_err(|_| "controller hint queue exhausted")?;
                        }
                    }
                }
            }
            if !pending.is_empty() {
                return Err("Kubernetes watch frame was interrupted".into());
            }
        }
    }
    pub async fn in_cluster() -> Result<Self, Error> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let host = std::env::var("KUBERNETES_SERVICE_HOST")?;
        let port: u16 = std::env::var("KUBERNETES_SERVICE_PORT_HTTPS")
            .unwrap_or_else(|_| "443".into())
            .parse()?;
        let host = if host.contains(':') {
            format!("[{host}]")
        } else {
            host
        };
        let origin = Url::parse(&format!("https://{host}:{port}"))?;
        let folder = PathBuf::from("/var/run/secrets/kubernetes.io/serviceaccount");
        let ca = tokio::fs::read(folder.join("ca.crt")).await?;
        Self::with_ca(origin, &ca, folder.join("token"))
    }
    pub fn with_ca(origin: Url, ca: &[u8], token: PathBuf) -> Result<Self, Error> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        if origin.scheme() != "https"
            || !origin.username().is_empty()
            || origin.password().is_some()
            || origin.path() != "/"
            || origin.query().is_some()
            || origin.fragment().is_some()
        {
            return Err("invalid Kubernetes endpoint".into());
        }
        let client = Client::builder()
            .tls_certs_only([reqwest::Certificate::from_pem(ca)?])
            .no_proxy()
            .retry(reqwest::retry::never())
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10))
            .build()?;
        Ok(Self {
            client,
            origin,
            token,
        })
    }
    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Option<Value>, Error> {
        let token = tokio::fs::read_to_string(&self.token).await?;
        if token.trim().is_empty() {
            return Err("Kubernetes bearer missing".into());
        }
        let mut request = self
            .client
            .request(method.clone(), self.origin.join(path)?)
            .bearer_auth(token.trim());
        if let Some(body) = body {
            let bytes = serde_json::to_vec(body)?;
            if bytes.len() > 2 * 1024 * 1024 {
                return Err("Kubernetes mutation exceeds bound".into());
            }
            request = request
                .header(
                    "Content-Type",
                    if method == Method::PATCH {
                        "application/merge-patch+json"
                    } else {
                        "application/json"
                    },
                )
                .body(bytes);
        }
        let response = request.send().await?;
        let status = response.status();
        if status == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !status.is_success() {
            return Err(Box::new(KubernetesError {
                status: status.as_u16(),
            }));
        }
        let bytes = bounded(response, 2 * 1024 * 1024).await?;
        if bytes.is_empty() {
            return Ok(None);
        }
        Ok(Some(serde_json::from_slice(&bytes)?))
    }
    pub async fn read(
        &self,
        kind: &str,
        namespace: Option<&str>,
        name: &str,
    ) -> Result<Option<Value>, Error> {
        let value = self
            .request(Method::GET, &named(kind, namespace, name)?, None)
            .await?;
        if value.as_ref().is_some_and(|v| {
            text(v, "kind") != kind
                || text(&v["metadata"], "name") != name
                || namespace.is_some_and(|ns| text(&v["metadata"], "namespace") != ns)
        }) {
            return Err("Kubernetes read identity changed".into());
        }
        Ok(value)
    }
    pub async fn list(
        &self,
        kind: &str,
        namespace: Option<&str>,
        selector: Option<&str>,
    ) -> Result<Vec<Value>, Error> {
        let path = collection(kind, namespace)?;
        let mut result = vec![];
        let mut cursor = String::new();
        let mut version = None;
        for _ in 0..50 {
            let mut url = self.origin.join(&path)?;
            {
                let mut query = url.query_pairs_mut();
                query.append_pair("limit", "200");
                if let Some(selector) = selector {
                    if selector.len() > 1024 {
                        return Err("Kubernetes selector exceeds bound".into());
                    }
                    query.append_pair("labelSelector", selector);
                }
                if !cursor.is_empty() {
                    query.append_pair("continue", &cursor);
                }
            }
            let target = format!("{}?{}", url.path(), url.query().unwrap_or(""));
            let value = self
                .request(Method::GET, &target, None)
                .await?
                .ok_or("Kubernetes collection missing")?;
            let current = text(&value["metadata"], "resourceVersion");
            if current.is_empty() || version.as_ref().is_some_and(|old| old != current) {
                return Err("Kubernetes paginated inventory changed".into());
            }
            version = Some(current.to_string());
            let items = value["items"]
                .as_array()
                .ok_or("Kubernetes collection invalid")?;
            if items.iter().any(|v| {
                text(v, "kind") != kind
                    || namespace.is_some_and(|ns| text(&v["metadata"], "namespace") != ns)
            }) {
                return Err("Kubernetes inventory identity changed".into());
            }
            result.extend(items.iter().cloned());
            if result.len() > 10000 {
                return Err("Kubernetes inventory exceeds bound".into());
            }
            cursor = text(&value["metadata"], "continue").to_string();
            if cursor.is_empty() {
                return Ok(result);
            }
        }
        Err("Kubernetes pagination exceeds bound".into())
    }
    pub async fn create(&self, manifest: &Value) -> Result<Value, Error> {
        let kind = text(manifest, "kind");
        let ns = manifest["metadata"]["namespace"].as_str();
        let name = text(&manifest["metadata"], "name");
        named(kind, ns, name)?;
        if !manifest["metadata"]["uid"].is_null()
            || !manifest["metadata"]["resourceVersion"].is_null()
        {
            return Err("new Kubernetes resource has an existing identity".into());
        }
        let response = self
            .request(Method::POST, &collection(kind, ns)?, Some(manifest))
            .await?
            .ok_or("Kubernetes create result unknown")?;
        let uid = text(&response["metadata"], "uid");
        let actual = self
            .read(kind, ns, name)
            .await?
            .ok_or("Kubernetes created resource disappeared")?;
        if uid.is_empty()
            || text(&actual["metadata"], "uid") != uid
            || text(&actual["metadata"], "resourceVersion").is_empty()
        {
            return Err("Kubernetes created identity changed".into());
        }
        Ok(actual)
    }
    pub async fn patch(&self, current: &Value, patch: &Value) -> Result<Value, Error> {
        let uid = text(&current["metadata"], "uid");
        let rv = text(&current["metadata"], "resourceVersion");
        if uid.is_empty() || rv.is_empty() || !current["metadata"]["deletionTimestamp"].is_null() {
            return Err("Kubernetes mutation identity unavailable".into());
        }
        let mut body = patch.clone();
        if !body.is_object() {
            return Err("Kubernetes patch must be object".into());
        }
        if !body["metadata"].is_object() {
            body["metadata"] = json!({});
        }
        body["metadata"]["uid"] = uid.into();
        body["metadata"]["resourceVersion"] = rv.into();
        let result = self
            .request(
                Method::PATCH,
                &named(
                    text(current, "kind"),
                    current["metadata"]["namespace"].as_str(),
                    text(&current["metadata"], "name"),
                )?,
                Some(&body),
            )
            .await?
            .ok_or("Kubernetes patch target disappeared")?;
        if text(&result["metadata"], "uid") != uid {
            return Err("Kubernetes patched identity changed".into());
        }
        let actual = self
            .read(
                text(current, "kind"),
                current["metadata"]["namespace"].as_str(),
                text(&current["metadata"], "name"),
            )
            .await?
            .ok_or("Kubernetes patched resource disappeared")?;
        if text(&actual["metadata"], "uid") != uid
            || text(&actual["metadata"], "resourceVersion").is_empty()
        {
            return Err("Kubernetes patch readback identity changed".into());
        }
        Ok(actual)
    }
    pub async fn delete(&self, current: &Value, propagation: &str) -> Result<(), Error> {
        let uid = text(&current["metadata"], "uid");
        let rv = text(&current["metadata"], "resourceVersion");
        if uid.is_empty()
            || rv.is_empty()
            || !["Foreground", "Background", "Orphan"].contains(&propagation)
        {
            return Err("Kubernetes deletion identity unavailable".into());
        }
        let body = json!({"apiVersion":"v1","kind":"DeleteOptions","preconditions":{"uid":uid,"resourceVersion":rv},"propagationPolicy":propagation});
        self.request(
            Method::DELETE,
            &named(
                text(current, "kind"),
                current["metadata"]["namespace"].as_str(),
                text(&current["metadata"], "name"),
            )?,
            Some(&body),
        )
        .await?;
        Ok(())
    }
    pub async fn assert_cluster(&self, uid: &str) -> Result<(), Error> {
        let cluster = self
            .read("Namespace", None, "kube-system")
            .await?
            .ok_or("cluster identity missing")?;
        if uid.is_empty() || text(&cluster["metadata"], "uid") != uid {
            return Err("cluster identity changed".into());
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn kubelet_certificate_requires_exact_leaf_and_exact_node_san() {
        use rustls::client::danger::ServerCertVerifier;
        let _ = rustls::crypto::ring::default_provider().install_default();
        let key = rcgen::KeyPair::generate().unwrap();
        let cert = rcgen::CertificateParams::new(vec!["customer-node".into()])
            .unwrap()
            .self_signed(&key)
            .unwrap();
        let der = rustls::pki_types::CertificateDer::from(cert.der().to_vec());
        let mut roots = rustls::RootCertStore::empty();
        roots.add(der.clone()).unwrap();
        let inner = rustls::client::WebPkiServerVerifier::builder(Arc::new(roots))
            .build()
            .unwrap();
        let verifier = KubeletVerifier {
            inner,
            leaf: der.as_ref().to_vec(),
            name: "customer-node".into(),
        };
        let name = rustls::pki_types::ServerName::try_from("customer-node").unwrap();
        assert!(
            verifier
                .verify_server_cert(&der, &[], &name, &[], rustls::pki_types::UnixTime::now())
                .is_ok()
        );
        let other = rcgen::CertificateParams::new(vec!["customer-node".into()])
            .unwrap()
            .self_signed(&rcgen::KeyPair::generate().unwrap())
            .unwrap();
        assert!(
            verifier
                .verify_server_cert(
                    other.der(),
                    &[],
                    &name,
                    &[],
                    rustls::pki_types::UnixTime::now()
                )
                .is_err()
        );
        let wrong = rustls::pki_types::ServerName::try_from("another-node").unwrap();
        assert!(
            verifier
                .verify_server_cert(&der, &[], &wrong, &[], rustls::pki_types::UnixTime::now())
                .is_err()
        );
    }
    #[test]
    fn resource_paths_are_fixed_and_names_cannot_escape() {
        assert_eq!(
            named("Cluster", Some("pgcf-db-test"), "database").unwrap(),
            "/apis/postgresql.cnpg.io/v1/namespaces/pgcf-db-test/clusters/database"
        );
        assert!(named("Secret", Some("a/../b"), "credentials").is_err());
        assert!(named("Secret", Some(".."), "credentials").is_err());
        assert!(named("Secret", Some("pgcf-system"), "..").is_err());
        assert!(named("Cluster", None, "database").is_err());
        assert!(collection("Deployment", Some("kube-system")).is_err());
    }
}
#[cfg(test)]
mod transport_tests {
    use super::*;
    use std::sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    };
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };
    use tokio_rustls::TlsAcceptor;
    #[tokio::test]
    async fn uncertain_patch_is_not_retried_and_next_read_uses_rotated_token() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let identity = rcgen::generate_simple_self_signed(vec!["127.0.0.1".into()]).unwrap();
        let tls = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(
                vec![identity.cert.der().clone()],
                rustls::pki_types::PrivateKeyDer::Pkcs8(
                    rustls::pki_types::PrivatePkcs8KeyDer::from(
                        identity.signing_key.serialize_der(),
                    ),
                ),
            )
            .unwrap();
        let acceptor = TlsAcceptor::from(Arc::new(tls));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let token = std::env::temp_dir().join(format!(
            "pgcf-kube-client-{}-{}.token",
            std::process::id(),
            address.port()
        ));
        tokio::fs::write(&token, "before").await.unwrap();
        let k8s = Kubernetes::with_ca(
            Url::parse(&format!("https://{address}/")).unwrap(),
            identity.cert.pem().as_bytes(),
            token.clone(),
        )
        .unwrap();
        let current = json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"owned","namespace":"pgcf-system","uid":"same","resourceVersion":"1"},"data":{"value":"old"}});
        let state = Arc::new(Mutex::new(current.clone()));
        let attempts = Arc::new(AtomicUsize::new(0));
        let (saved, count) = (state.clone(), attempts.clone());
        let task = tokio::spawn(async move {
            for _ in 0..2 {
                let (tcp, _) = listener.accept().await.unwrap();
                let mut tls = acceptor.accept(tcp).await.unwrap();
                let mut header = vec![];
                let mut byte = [0];
                while !header.ends_with(b"\r\n\r\n") {
                    tls.read_exact(&mut byte).await.unwrap();
                    header.push(byte[0]);
                    assert!(header.len() < 64 * 1024);
                }
                let header = String::from_utf8(header).unwrap();
                assert!(
                    header
                        .lines()
                        .next()
                        .unwrap()
                        .ends_with("/api/v1/namespaces/pgcf-system/configmaps/owned HTTP/1.1")
                );
                if header.starts_with("PATCH ") {
                    assert!(
                        header
                            .to_lowercase()
                            .contains("authorization: bearer before")
                    );
                    let length = header
                        .lines()
                        .find_map(|line| {
                            line.split_once(':')
                                .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                                .map(|(_, v)| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap();
                    let mut body = vec![0; length];
                    tls.read_exact(&mut body).await.unwrap();
                    let patch: Value = serde_json::from_slice(&body).unwrap();
                    assert_eq!(patch["metadata"]["uid"], "same");
                    assert_eq!(patch["metadata"]["resourceVersion"], "1");
                    count.fetch_add(1, Ordering::SeqCst);
                    saved.lock().unwrap()["data"]["value"] = patch["data"]["value"].clone();
                    saved.lock().unwrap()["metadata"]["resourceVersion"] = "2".into();
                    // The mutation happened; the connection closes before any response.
                } else {
                    assert!(header.starts_with("GET "));
                    assert!(
                        header
                            .to_lowercase()
                            .contains("authorization: bearer after")
                    );
                    let body = serde_json::to_vec(&*saved.lock().unwrap()).unwrap();
                    tls.write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
                    tls.write_all(&body).await.unwrap();
                }
            }
        });
        assert!(
            k8s.patch(&current, &json!({"data":{"value":"committed"}}))
                .await
                .is_err()
        );
        tokio::fs::write(&token, "after").await.unwrap();
        let actual = k8s
            .read("ConfigMap", Some("pgcf-system"), "owned")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(actual["data"]["value"], "committed");
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        task.await.unwrap();
        tokio::fs::remove_file(token).await.unwrap();
    }
}

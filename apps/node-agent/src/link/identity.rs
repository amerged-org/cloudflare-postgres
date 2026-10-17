// SPDX-License-Identifier: Apache-2.0
//! Who the node is: the one-time enrollment with the seed the installer wrote (plan 8, "Secrets
//! on the node"), and the key and identity it leaves.
use super::{
    Timing,
    backoff::Backoff,
    file,
    request::{Transport, finish},
};
use crate::{
    Error,
    api::Refusal,
    node_link::{RequestClaims, constant, public_key, schema_valid, sign_request},
};
use reqwest::Url;
use ring::{rand::SystemRandom, signature::Ed25519KeyPair};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{io::ErrorKind, path::PathBuf, time::Instant};

/// Where the agent keeps its state; `/var/lib/pgcf` on a node.
#[derive(Clone, Debug)]
pub struct Paths {
    base: PathBuf,
}
impl Paths {
    pub fn new(base: impl Into<PathBuf>) -> Self {
        Self { base: base.into() }
    }
    /// The installer's seed, deleted after the enrollment.
    pub fn seed(&self) -> PathBuf {
        self.base.join("enrollment/seed.json")
    }
    pub fn credentials(&self) -> PathBuf {
        self.base.join("credentials")
    }
    /// The node's private key, PKCS#8, readable by the agent only.
    pub fn key(&self) -> PathBuf {
        self.credentials().join("node-key.pk8")
    }
    pub fn identity(&self) -> PathBuf {
        self.credentials().join("node.json")
    }
    pub fn link(&self) -> PathBuf {
        self.base.join("link")
    }
}
impl Default for Paths {
    fn default() -> Self {
        Self::new("/var/lib/pgcf")
    }
}

/// The node record of one install (`NodeIdentity`); a reinstall is a new node with a new key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodeIdentity {
    pub id: String,
    pub uid: String,
    pub hostname: String,
    pub region_id: String,
}

/// An enrolled node: its identity, the API it belongs to and its key.
pub struct Identity {
    pub node: NodeIdentity,
    pub origin: Url,
    key: Ed25519KeyPair,
}
impl Identity {
    /// The bearer token of a request: it binds the method, the path with its query and the body.
    pub fn bearer(&self, method: &str, target: &str, body: &[u8]) -> Result<String, Error> {
        let claims = RequestClaims::new(
            &self.node.id,
            &self.node.uid,
            method,
            target,
            body,
            now_ms(),
        );
        // A request the Worker would refuse for its claims or its length is never sent.
        let token = sign_request(&self.key, &claims);
        if !schema_valid("NodeRequestClaims", &serde_json::to_value(&claims)?)
            || token.len() as u64 > constant("NODE_REQUEST_MAX_LENGTH").as_u64().unwrap_or(0)
        {
            return Err("node request exceeds the signed bounds".into());
        }
        Ok(token)
    }
    /// The URL of a path (with its query) of the node API; never one of another host.
    pub fn node_url(&self, target: &str) -> Result<Url, Error> {
        let url = self.origin.join(target)?;
        if url.origin() != self.origin.origin() {
            return Err("request leaves the Cloudflare API origin".into());
        }
        Ok(url)
    }
}

fn now_ms() -> u64 {
    u64::try_from(time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000).unwrap_or(0)
}

/// The API origin of a seed or an identity: `https` and nothing but the host and port.
fn origin(url: &str) -> Result<Url, Error> {
    let url = Url::parse(url)?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("invalid Cloudflare API origin".into());
    }
    Ok(url)
}

/// `Seed` is the installer's `NodeEnrollmentSeed`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Seed {
    node_id: String,
    region: String,
    api_url: String,
    enrollment_token: String,
}
fn read_seed(paths: &Paths) -> Result<(Seed, Url), Error> {
    let value: Value = serde_json::from_slice(&std::fs::read(paths.seed())?)?;
    if !schema_valid("NodeEnrollmentSeed", &value) {
        return Err("enrollment seed invalid".into());
    }
    let seed: Seed = serde_json::from_value(value)?;
    let origin = origin(&seed.api_url)?;
    Ok((seed, origin))
}

/// What the node keeps of its enrollment, beside the key.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Stored {
    api_url: String,
    node: NodeIdentity,
}
fn node_valid(node: &NodeIdentity) -> bool {
    serde_json::to_value(node).is_ok_and(|node| schema_valid("NodeEnrollmentResponse", &node))
}

/// The node's key, created and stored before it is sent anywhere: an enrollment whose answer was
/// lost is repeated with the same key.
fn new_key(paths: &Paths) -> Result<Ed25519KeyPair, Error> {
    match std::fs::read(paths.key()) {
        Ok(pkcs8) => return pair(&pkcs8),
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    file::create_private_directory(&paths.credentials())?;
    let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
        .map_err(|_| "node key generation failed")?;
    file::write_private(&paths.key(), pkcs8.as_ref())?;
    pair(pkcs8.as_ref())
}
fn pair(pkcs8: &[u8]) -> Result<Ed25519KeyPair, Error> {
    Ed25519KeyPair::from_pkcs8(pkcs8).map_err(|_| "node key invalid".into())
}

/// The identity of an enrolled node.
fn load(paths: &Paths) -> Result<Option<Identity>, Error> {
    let stored = match std::fs::read(paths.identity()) {
        Ok(bytes) => serde_json::from_slice::<Stored>(&bytes)?,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !node_valid(&stored.node) {
        return Err("stored node identity invalid".into());
    }
    Ok(Some(Identity {
        node: stored.node,
        origin: origin(&stored.api_url)?,
        // An enrolled node without its key is broken: a new key is one Cloudflare does not know.
        key: pair(&std::fs::read(paths.key())?)?,
    }))
}

/// The seed is deleted once the node is enrolled.
fn remove_seed(paths: &Paths) -> Result<(), Error> {
    match std::fs::remove_file(paths.seed()) {
        Ok(()) => file::sync_directory(paths.seed().parent().ok_or("seed has no directory")?)?,
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

/// The identity of an enrolled node, or the enrollment of a new one.
pub async fn establish(
    paths: &Paths,
    transport: &Transport,
    image_version: &str,
    timing: &Timing,
) -> Result<Identity, Error> {
    if let Some(identity) = load(paths)? {
        remove_seed(paths)?;
        return Ok(identity);
    }
    let (seed, origin) = read_seed(paths)?;
    let key = new_key(paths)?;
    let request = json!({
        "node_id": seed.node_id,
        "enrollment_token": seed.enrollment_token,
        "public_key": public_key(&key),
        "image_version": image_version,
    });
    if !schema_valid("NodeEnrollmentRequest", &request) {
        return Err("enrollment request invalid".into());
    }
    let url = origin.join(
        constant("NODE_API_PATHS")["enroll"]
            .as_str()
            .ok_or("enroll path")?,
    )?;
    let deadline = Instant::now() + timing.enrollment_window;
    let mut backoff = Backoff::new(timing.backoff_minimum, timing.backoff_maximum);
    let node = loop {
        match enrollment(transport, &url, &request).await {
            Ok(node) => break node,
            Err(error) if transient(&error) && Instant::now() < deadline => {
                tokio::time::sleep(backoff.wait()).await;
            }
            Err(error) => return Err(error),
        }
    };
    if node.id != seed.node_id || node.region_id != seed.region {
        return Err("enrollment answer is for another node".into());
    }
    let stored = Stored {
        api_url: origin.to_string(),
        node: node.clone(),
    };
    file::write_private(&paths.identity(), &serde_json::to_vec(&stored)?)?;
    remove_seed(paths)?;
    Ok(Identity { node, origin, key })
}

/// One enrollment request. The answer of a node that already enrolled with this token and key
/// is the same identity.
async fn enrollment(
    transport: &Transport,
    url: &Url,
    request: &Value,
) -> Result<NodeIdentity, Error> {
    let response = transport
        .client
        .post(url.clone())
        .json(request)
        .send()
        .await?;
    let node: Value = serde_json::from_slice(&finish(response, 64 * 1024).await?)?;
    if !schema_valid("NodeEnrollmentResponse", &node) {
        return Err("enrollment answer invalid".into());
    }
    Ok(serde_json::from_value(node)?)
}

/// Whether asking again can help: the network, or an API that is unavailable or limiting.
fn transient(error: &Error) -> bool {
    error.is::<reqwest::Error>()
        || error
            .downcast_ref::<Refusal>()
            .is_some_and(|refusal| refusal.status >= 500 || matches!(refusal.status, 408 | 429))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        api::Refusal,
        link::test_server::{Cloud, Failure, NODE_ID, NODE_UID, tempdir},
    };
    use ring::signature::KeyPair;
    use std::{os::unix::fs::PermissionsExt, path::Path, time::Duration};

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }
    fn quick() -> Timing {
        Timing {
            backoff_minimum: Duration::from_millis(5),
            backoff_maximum: Duration::from_millis(10),
            enrollment_window: Duration::from_secs(5),
            ..Timing::default()
        }
    }
    fn expected() -> NodeIdentity {
        NodeIdentity {
            id: NODE_ID.into(),
            uid: NODE_UID.into(),
            hostname: "eu1".into(),
            region_id: "eu-dev".into(),
        }
    }

    #[tokio::test]
    async fn a_first_boot_enrolls_with_a_new_key_and_a_restart_needs_no_enrollment() {
        let cloud = Cloud::start().await;
        let base = tempdir();
        cloud.seed(&base);
        let (paths, transport) = (Paths::new(&base), Transport::new(cloud.roots()).unwrap());
        let identity = establish(&paths, &transport, "25", &quick()).await.unwrap();
        assert_eq!(identity.node, expected());
        assert_eq!(identity.origin.as_str(), format!("{}/", cloud.origin));
        // Cloudflare bound the key the node stored, and the key never left it.
        let stored = Ed25519KeyPair::from_pkcs8(&std::fs::read(paths.key()).unwrap()).unwrap();
        assert_eq!(
            cloud.with(|i| i.public_key.clone()).unwrap(),
            stored.public_key().as_ref()
        );
        assert_eq!(
            cloud.with(|i| i.image_version.clone()).as_deref(),
            Some("25")
        );
        assert_eq!(
            (mode(&paths.key()), mode(&paths.identity())),
            (0o600, 0o600)
        );
        assert_eq!(mode(&paths.credentials()), 0o700);
        assert!(
            !paths.seed().exists(),
            "the seed is deleted after the enrollment"
        );
        // A restart reads the identity and asks nobody.
        let again = establish(&paths, &transport, "25", &quick()).await.unwrap();
        assert_eq!(again.node, expected());
        assert_eq!(cloud.requests().len(), 1);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[tokio::test]
    async fn a_node_without_its_key_is_broken_and_never_gets_a_new_one() {
        let cloud = Cloud::start().await;
        let base = tempdir();
        cloud.seed(&base);
        let (paths, transport) = (Paths::new(&base), Transport::new(cloud.roots()).unwrap());
        establish(&paths, &transport, "25", &quick()).await.unwrap();
        std::fs::remove_file(paths.key()).unwrap();
        assert!(establish(&paths, &transport, "25", &quick()).await.is_err());
        assert!(
            !paths.key().exists(),
            "a key Cloudflare does not know would only be refused"
        );
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn the_default_paths_are_those_of_the_installer() {
        assert_eq!(
            Paths::default().seed().to_str(),
            constant("NODE_ENROLLMENT_SEED_PATH").as_str()
        );
    }

    #[tokio::test]
    async fn an_enrollment_with_a_lost_answer_repeats_with_the_key_it_stored_first() {
        let cloud = Cloud::start().await;
        let base = tempdir();
        cloud.seed(&base);
        let (paths, transport) = (Paths::new(&base), Transport::new(cloud.roots()).unwrap());
        // The API enrolls the node and the answer is lost; the node asks again.
        cloud.fail_next([Failure::Drop, Failure::Status(503)]);
        let identity = establish(&paths, &transport, "25", &quick()).await.unwrap();
        assert_eq!(identity.node, expected());
        let keys: Vec<_> = cloud
            .posted("/node/v1/enroll")
            .iter()
            .map(|b| b["public_key"].clone())
            .collect();
        assert_eq!(keys.len(), 3);
        assert!(keys.iter().all(|key| *key == keys[0]));
        // A crash after the first request but before the identity was stored repeats it the same.
        std::fs::remove_file(paths.identity()).unwrap();
        cloud.seed(&base);
        establish(&paths, &transport, "25", &quick()).await.unwrap();
        let last = cloud.posted("/node/v1/enroll").pop().unwrap();
        assert_eq!(last["public_key"], keys[0]);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[tokio::test]
    async fn a_refused_enrollment_is_final_and_an_unavailable_api_is_retried_only_while_the_token_lives()
     {
        let cloud = Cloud::start().await;
        let base = tempdir();
        cloud.seed(&base);
        let (paths, transport) = (Paths::new(&base), Transport::new(cloud.roots()).unwrap());
        // Another node's key holds the token.
        cloud.with(|inner| inner.public_key = Some(vec![7; 32]));
        let error = establish(&paths, &transport, "25", &quick())
            .await
            .err()
            .unwrap();
        assert_eq!(error.downcast_ref::<Refusal>().unwrap().status, 403);
        assert_eq!(cloud.requests().len(), 1);
        assert!(!paths.identity().exists());
        // An API that stays unavailable is asked until the token would have expired.
        cloud.with(|inner| inner.public_key = None);
        cloud.fail_next(std::iter::repeat_n(Failure::Status(503), 1000));
        let window = Timing {
            enrollment_window: Duration::from_millis(100),
            ..quick()
        };
        let error = establish(&paths, &transport, "25", &window)
            .await
            .err()
            .unwrap();
        assert_eq!(error.downcast_ref::<Refusal>().unwrap().status, 503);
        assert!(cloud.requests().len() > 3);
        assert!(!paths.identity().exists());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[tokio::test]
    async fn a_seed_or_an_answer_that_breaks_the_contract_enrolls_nobody() {
        let cloud = Cloud::start().await;
        let base = tempdir();
        let (paths, transport) = (Paths::new(&base), Transport::new(cloud.roots()).unwrap());
        // No seed and no identity: nothing to enroll with.
        assert!(establish(&paths, &transport, "25", &quick()).await.is_err());
        // A seed that names a plain-HTTP API, or one with another field.
        for seed in [
            r#"{"node_id":"nod_nnnnnnnnnnnnnnnnnnnn","region":"eu-dev","api_url":"http://api.example","enrollment_token":"pgcf_et_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}"#,
            r#"{"node_id":"nod_nnnnnnnnnnnnnnnnnnnn","region":"eu-dev","api_url":"https://api.example/path?x=1","enrollment_token":"pgcf_et_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}"#,
            r#"{"node_id":"nod_nnnnnnnnnnnnnnnnnnnn","region":"eu-dev","api_url":"https://api.example","enrollment_token":"pgcf_et_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","extra":1}"#,
        ] {
            std::fs::create_dir_all(paths.seed().parent().unwrap()).unwrap();
            std::fs::write(paths.seed(), seed).unwrap();
            assert!(
                establish(&paths, &transport, "25", &quick()).await.is_err(),
                "{seed}"
            );
        }
        assert!(cloud.requests().is_empty());
        // The API answers for another node than the seed names.
        let seed = std::fs::read_to_string(paths.seed()).unwrap();
        let _ = seed;
        cloud.seed(&base);
        let mut seed: serde_json::Value =
            serde_json::from_slice(&std::fs::read(paths.seed()).unwrap()).unwrap();
        seed["node_id"] = "nod_zzzzzzzzzzzzzzzzzzzz".into();
        std::fs::write(paths.seed(), seed.to_string()).unwrap();
        assert!(establish(&paths, &transport, "25", &quick()).await.is_err());
        assert!(!paths.identity().exists());
        std::fs::remove_dir_all(base).unwrap();
    }
}

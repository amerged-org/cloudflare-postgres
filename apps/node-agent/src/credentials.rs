// SPDX-License-Identifier: Apache-2.0
//! The R2 temporary credentials a barman job runs with (ULTRA plan 7.3): signed locally from the
//! parent key as an HS256 JWT, Cloudflare's local-signing method, because only that method takes
//! an explicit action list. The list has no delete action, the scope is one archive prefix and the
//! lifetime is 7 days (the Stage 1 lab: R2 accepts it, refuses `DeleteObject` and needs no
//! `HeadBucket`). A credential is renewed once a third of its lifetime has passed.
use base64::{Engine, engine::general_purpose};
use ring::{digest, hmac};
use serde_json::json;
use std::{collections::HashMap, fmt, sync::RwLock};

/// The lifetime of a signed credential: 7 days (plan 7.3).
pub const LIFETIME_SECONDS: u64 = 7 * 24 * 3600;
/// R2 ignores the region; barman's S3 client needs one.
pub const REGION: &str = "auto";
/// Reading and writing one archive prefix: WAL, base backups (multipart above one chunk) and the
/// listings barman makes. The Stage 1 lab minted exactly this list; there is no delete action.
pub const READ_WRITE_ACTIONS: [&str; 10] = [
    "GetObject",
    "HeadObject",
    "PutObject",
    "ListObjectsV2",
    "CreateMultipartUpload",
    "UploadPart",
    "CompleteMultipartUpload",
    "AbortMultipartUpload",
    "ListMultipartUploads",
    "ListParts",
];
/// Reading the archive a restore comes from.
pub const READ_ONLY_ACTIONS: [&str; 3] = ["GetObject", "HeadObject", "ListObjectsV2"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Access {
    ReadWrite,
    ReadOnly,
}
impl Access {
    fn actions(self) -> &'static [&'static str] {
        match self {
            Self::ReadWrite => &READ_WRITE_ACTIONS,
            Self::ReadOnly => &READ_ONLY_ACTIONS,
        }
    }
}

/// What one credential may reach: the objects under `prefix`, which ends in `/` so that
/// `g1-op_a/` never covers `g1-op_ab/`.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Scope {
    pub prefix: String,
    pub access: Access,
}
impl Scope {
    /// The scope of an archive path `s3://<bucket>/<region>/<database>/g<generation>-<operation>`.
    pub fn for_archive(path: &str, access: Access) -> Option<Self> {
        let parts = crate::node_link::archive_path(path)?;
        Some(Self {
            prefix: format!(
                "{}/{}/g{}-{}/",
                parts.region, parts.database, parts.generation, parts.operation
            ),
            access,
        })
    }
}

/// The parent R2 key and where it signs for. Whoever holds it can mint any scope, delete
/// included: only a process that must mint credentials holds one.
pub struct Parent {
    account_id: String,
    access_key_id: String,
    secret_access_key: String,
    endpoint_url: String,
    bucket: String,
}
impl Parent {
    pub fn new(
        account_id: &str,
        access_key_id: &str,
        secret_access_key: &str,
        endpoint_url: &str,
        bucket: &str,
    ) -> Option<Self> {
        let endpoint = reqwest::Url::parse(endpoint_url).ok()?;
        let valid = [account_id, access_key_id, secret_access_key, bucket]
            .iter()
            .all(|value| !value.is_empty())
            && endpoint.scheme() == "https"
            && endpoint.host_str().is_some();
        valid.then(|| Self {
            account_id: account_id.into(),
            access_key_id: access_key_id.into(),
            secret_access_key: secret_access_key.into(),
            endpoint_url: endpoint_url.trim_end_matches('/').into(),
            bucket: bucket.into(),
        })
    }
    pub fn endpoint_url(&self) -> &str {
        &self.endpoint_url
    }
}
impl fmt::Debug for Parent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Parent")
            .field("bucket", &self.bucket)
            .field("secret_access_key", &"<redacted>")
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Valid,
    /// A third of the lifetime has passed: a fresh credential is due, this one still works.
    RenewDue,
    Expired,
}

/// The access key, secret and session token of one scope, as the S3 client takes them.
#[derive(Clone, PartialEq, Eq)]
pub struct Credential {
    access_key_id: String,
    secret_access_key: String,
    session_token: String,
    issued_at: u64,
    expires_at: u64,
}
impl Credential {
    /// A credential Cloudflare delivered (`ArchiveCredential` of the node contract), valid from
    /// `issued_at` to `expires_at` (Unix seconds). `None` if a value could not travel in an
    /// environment file.
    pub fn delivered(
        access_key_id: &str,
        secret_access_key: &str,
        session_token: &str,
        issued_at: u64,
        expires_at: u64,
    ) -> Option<Self> {
        let plain = |value: &str| {
            !value.is_empty()
                && value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"/+=._~-".contains(&b))
        };
        (plain(access_key_id)
            && plain(secret_access_key)
            && plain(session_token)
            && issued_at < expires_at)
            .then(|| Self {
                access_key_id: access_key_id.into(),
                secret_access_key: secret_access_key.into(),
                session_token: session_token.into(),
                issued_at,
                expires_at,
            })
    }
    pub fn status(&self, now: u64) -> Status {
        if now >= self.expires_at {
            Status::Expired
        } else if now >= self.issued_at + (self.expires_at - self.issued_at) / 3 {
            Status::RenewDue
        } else {
            Status::Valid
        }
    }
    pub fn expires_at(&self) -> u64 {
        self.expires_at
    }
    /// The environment of the S3 client.
    pub fn environment(&self) -> [(&'static str, &str); 4] {
        [
            ("AWS_ACCESS_KEY_ID", &self.access_key_id),
            ("AWS_SECRET_ACCESS_KEY", &self.secret_access_key),
            ("AWS_SESSION_TOKEN", &self.session_token),
            ("AWS_DEFAULT_REGION", REGION),
        ]
    }
    /// `text` without any secret of this credential, for a log line.
    pub fn scrub(&self, text: &str) -> String {
        [&self.secret_access_key, &self.session_token]
            .iter()
            .fold(text.to_string(), |text, secret| {
                text.replace(secret.as_str(), "<redacted>")
            })
    }
}
impl fmt::Debug for Credential {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Credential")
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}

fn base64url(bytes: &[u8]) -> String {
    general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}
/// Signs a credential for `scope` that is valid from `now`: the JWT of Cloudflare's local
/// signing, the parent's key id as access key, the SHA-256 of the JWT as secret and the JWT,
/// prefixed `jwt/`, as session token.
pub fn sign(parent: &Parent, scope: &Scope, now: u64) -> Credential {
    let expires_at = now + LIFETIME_SECONDS;
    let host = reqwest::Url::parse(&parent.endpoint_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_default();
    // The claims in the order of the Stage 1 lab's signer, byte for byte: R2 accepted that token.
    let claims = format!(
        r#"{{"bucket":{},"actions":{},"paths":{{"prefixPaths":[{}],"objectPaths":[]}},"sub":{},"iss":{},"aud":{},"iat":{now},"exp":{expires_at}}}"#,
        json!(parent.bucket),
        json!(scope.access.actions()),
        json!(scope.prefix),
        json!(parent.account_id),
        json!(parent.access_key_id),
        json!(host),
    );
    let signing_input = format!(
        "{}.{}",
        base64url(br#"{"alg":"HS256","typ":"JWT"}"#),
        base64url(claims.as_bytes())
    );
    let key = hmac::Key::new(hmac::HMAC_SHA256, parent.secret_access_key.as_bytes());
    let token = format!(
        "{signing_input}.{}",
        base64url(hmac::sign(&key, signing_input.as_bytes()).as_ref())
    );
    Credential {
        access_key_id: parent.access_key_id.clone(),
        secret_access_key: digest::digest(&digest::SHA256, token.as_bytes())
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
        session_token: general_purpose::STANDARD.encode(format!("jwt/{token}")),
        issued_at: now,
        expires_at,
    }
}

/// The credentials a node holds, by scope.
#[derive(Default)]
pub struct Credentials {
    parent: Option<Parent>,
    held: RwLock<HashMap<Scope, Credential>>,
}
impl Credentials {
    /// A store that signs its own credentials from `parent`.
    pub fn signing(parent: Parent) -> Self {
        Self {
            parent: Some(parent),
            held: RwLock::default(),
        }
    }
    /// A store that holds what Cloudflare delivers.
    pub fn delivered() -> Self {
        Self::default()
    }
    /// Keeps a delivered credential for `scope`, replacing the earlier one.
    pub fn hold(&self, scope: Scope, credential: Credential) {
        self.held
            .write()
            .expect("credentials lock")
            .insert(scope, credential);
    }
    /// The credential to run a job with at `now`: signed afresh when none is held or the held
    /// one is due for renewal; a delivered one is used until it expires. `credential_expired`
    /// when there is none to use.
    pub fn get(&self, scope: &Scope, now: u64) -> Result<Credential, &'static str> {
        let held = self
            .held
            .read()
            .expect("credentials lock")
            .get(scope)
            .cloned();
        if let Some(credential) = &held
            && credential.status(now) == Status::Valid
        {
            return Ok(credential.clone());
        }
        if let Some(parent) = &self.parent {
            let fresh = sign(parent, scope, now);
            self.hold(scope.clone(), fresh.clone());
            return Ok(fresh);
        }
        held.filter(|credential| credential.status(now) != Status::Expired)
            .ok_or("credential_expired")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// SHA-256 of the lab signer's session token for the same inputs (the token itself is a JWT
    /// and stays out of the repository's secret scan).
    const LAB_SESSION_TOKEN_SHA256: &str =
        "16a8a2454c7bd1f84846317cbac88136828ad1ba1139c57825b1c7d9d9dd74bf";

    fn parent() -> Parent {
        Parent::new(
            "0123456789abcdef0123456789abcdef",
            "parentkeyid0123456789",
            "parent-secret-0123456789abcdef",
            "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/",
            "pgcf-eu",
        )
        .unwrap()
    }
    fn scope(access: Access) -> Scope {
        Scope {
            prefix: "eu-dev/abcdefghijklmnopqrst/g1-op_abcdefghijklmnopqrst/".into(),
            access,
        }
    }
    fn jwt(credential: &Credential) -> (Vec<String>, Value) {
        let token = general_purpose::STANDARD
            .decode(&credential.session_token)
            .unwrap();
        let token = String::from_utf8(token).unwrap();
        let parts: Vec<String> = token
            .strip_prefix("jwt/")
            .unwrap()
            .split('.')
            .map(Into::into)
            .collect();
        assert_eq!(parts.len(), 3);
        let claims = general_purpose::URL_SAFE_NO_PAD.decode(&parts[1]).unwrap();
        (parts, serde_json::from_slice(&claims).unwrap())
    }

    #[test]
    fn a_signed_credential_is_the_parents_jwt_for_one_prefix_without_delete() {
        let credential = sign(&parent(), &scope(Access::ReadWrite), 1_800_000_000);
        let (parts, claims) = jwt(&credential);
        // The parent key signed header and claims with HS256.
        let key = hmac::Key::new(hmac::HMAC_SHA256, b"parent-secret-0123456789abcdef");
        let signature = general_purpose::URL_SAFE_NO_PAD.decode(&parts[2]).unwrap();
        hmac::verify(
            &key,
            format!("{}.{}", parts[0], parts[1]).as_bytes(),
            &signature,
        )
        .unwrap();
        let header = general_purpose::URL_SAFE_NO_PAD.decode(&parts[0]).unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&header).unwrap(),
            json!({"alg": "HS256", "typ": "JWT"})
        );
        assert_eq!(
            claims,
            json!({
                "bucket": "pgcf-eu",
                "actions": READ_WRITE_ACTIONS,
                "paths": {
                    "prefixPaths": ["eu-dev/abcdefghijklmnopqrst/g1-op_abcdefghijklmnopqrst/"],
                    "objectPaths": []
                },
                "sub": "0123456789abcdef0123456789abcdef",
                "iss": "parentkeyid0123456789",
                "aud": "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
                "iat": 1_800_000_000u64,
                "exp": 1_800_000_000u64 + 7 * 24 * 3600
            })
        );
        // The S3 client's triple: the parent's key id, the digest of the JWT, the JWT itself.
        let token = String::from_utf8(
            general_purpose::STANDARD
                .decode(&credential.session_token)
                .unwrap(),
        )
        .unwrap();
        let digest = digest::digest(
            &digest::SHA256,
            token.strip_prefix("jwt/").unwrap().as_bytes(),
        );
        let hex: String = digest.as_ref().iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(credential.secret_access_key, hex);
        assert_eq!(credential.access_key_id, "parentkeyid0123456789");
        assert_eq!(credential.expires_at(), 1_800_000_000 + LIFETIME_SECONDS);
        // No action can delete or reach beyond objects.
        for action in READ_WRITE_ACTIONS.iter().chain(&READ_ONLY_ACTIONS) {
            assert!(
                !action.contains("Delete") && !action.contains('*'),
                "{action}"
            );
        }
    }

    /// The Stage 1 lab's Python signer (`r2mint.py`) on the same inputs: R2 accepted its tokens,
    /// so this one must be the same bytes.
    #[test]
    fn the_token_is_byte_for_byte_the_one_the_lab_signer_made_and_r2_accepted() {
        let scope = Scope {
            prefix: "eu-dev/abcdefghijklmnopqrst/g1-op_abcdefghijklmnopqrst/".into(),
            access: Access::ReadWrite,
        };
        let credential = sign(&parent(), &scope, 1_800_000_000);
        assert_eq!(
            credential.secret_access_key,
            "26118600e0aec4e68f434bbc230f86afa93967aca4b2df550ee71c79e68ad374"
        );
        let token = digest::digest(&digest::SHA256, credential.session_token.as_bytes());
        let token: String = token.as_ref().iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(token, LAB_SESSION_TOKEN_SHA256);
    }

    #[test]
    fn a_restore_source_credential_can_only_read() {
        let credential = sign(&parent(), &scope(Access::ReadOnly), 10);
        assert_eq!(jwt(&credential).1["actions"], json!(READ_ONLY_ACTIONS));
    }

    #[test]
    fn the_scope_of_an_archive_path_ends_in_a_slash() {
        let path = format!(
            "s3://pgcf-eu/eu-dev/{}/g12-op_{}",
            "a".repeat(20),
            "b".repeat(20)
        );
        let scope = Scope::for_archive(&path, Access::ReadWrite).unwrap();
        assert_eq!(
            scope.prefix,
            format!("eu-dev/{}/g12-op_{}/", "a".repeat(20), "b".repeat(20))
        );
        assert!(Scope::for_archive("s3://pgcf-eu/eu-dev/a", Access::ReadWrite).is_none());
    }

    #[test]
    fn a_credential_is_due_after_a_third_of_its_lifetime_and_expires_at_its_end() {
        let credential = sign(&parent(), &scope(Access::ReadWrite), 1_000);
        let third = LIFETIME_SECONDS / 3;
        assert_eq!(credential.status(1_000), Status::Valid);
        assert_eq!(credential.status(1_000 + third - 1), Status::Valid);
        assert_eq!(credential.status(1_000 + third), Status::RenewDue);
        assert_eq!(
            credential.status(1_000 + LIFETIME_SECONDS - 1),
            Status::RenewDue
        );
        assert_eq!(credential.status(1_000 + LIFETIME_SECONDS), Status::Expired);
    }

    #[test]
    fn a_signing_store_renews_before_expiry_and_keeps_scopes_apart() {
        let store = Credentials::signing(parent());
        let write = scope(Access::ReadWrite);
        let first = store.get(&write, 1_000).unwrap();
        assert_eq!(store.get(&write, 1_500).unwrap(), first);
        let other = Scope {
            prefix: "eu-dev/abcdefghijklmnopqrst/g2-op_abcdefghijklmnopqrst/".into(),
            access: Access::ReadWrite,
        };
        assert_ne!(store.get(&other, 1_000).unwrap(), first);
        let renewed = store.get(&write, 1_000 + LIFETIME_SECONDS / 3).unwrap();
        assert_ne!(renewed, first);
        assert_eq!(renewed.status(1_000 + LIFETIME_SECONDS / 3), Status::Valid);
        // A credential that expired while the database slept is replaced, not refused.
        let late = store.get(&write, 1_000 + 3 * LIFETIME_SECONDS).unwrap();
        assert_eq!(late.status(1_000 + 3 * LIFETIME_SECONDS), Status::Valid);
    }

    #[test]
    fn a_delivered_credential_is_used_until_it_expires_and_never_invented() {
        let store = Credentials::delivered();
        let write = scope(Access::ReadWrite);
        assert_eq!(store.get(&write, 5), Err("credential_expired"));
        let delivered =
            Credential::delivered("keyid", "secret-value", "token+/=", 100, 400).unwrap();
        store.hold(write.clone(), delivered.clone());
        assert_eq!(store.get(&write, 120).unwrap(), delivered);
        // Due for renewal, but nothing here can renew it: it still works.
        assert_eq!(store.get(&write, 300).unwrap(), delivered);
        assert_eq!(store.get(&write, 400), Err("credential_expired"));
        assert_eq!(
            store.get(&scope(Access::ReadOnly), 120),
            Err("credential_expired")
        );
        // What cannot travel in an environment file is refused.
        assert!(Credential::delivered("key id", "secret", "token", 1, 2).is_none());
        assert!(Credential::delivered("key", "se\ncret", "token", 1, 2).is_none());
        assert!(Credential::delivered("key", "secret", "token", 2, 2).is_none());
    }

    #[test]
    fn no_secret_reaches_a_debug_print_or_a_scrubbed_log_line() {
        let credential = sign(&parent(), &scope(Access::ReadWrite), 1_000);
        let printed = format!("{credential:?} {:?}", parent());
        assert!(!printed.contains(&credential.secret_access_key));
        assert!(!printed.contains(&credential.session_token));
        assert!(!printed.contains("parent-secret"));
        let line = format!(
            "denied {} for {}",
            credential.session_token, credential.secret_access_key
        );
        let scrubbed = credential.scrub(&line);
        assert_eq!(scrubbed, "denied <redacted> for <redacted>");
    }
}

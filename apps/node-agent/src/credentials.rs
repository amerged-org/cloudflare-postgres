// SPDX-License-Identifier: Apache-2.0
//! The R2 temporary credentials a barman job runs with (ULTRA plan 7.3). The API Worker holds the
//! parent R2 key and signs them (an explicit action list without delete, one archive prefix, 7
//! days); Cloudflare delivers each to the node (`ArchiveCredential` of the node contract) and
//! renews it after a third of its lifetime. The node holds what it was delivered and never the
//! parent key, which could mint any scope, delete included.
use std::{collections::HashMap, fmt, sync::RwLock};

/// R2 ignores the region; barman's S3 client needs one.
pub const REGION: &str = "auto";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Access {
    ReadWrite,
    ReadOnly,
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

/// The access key, secret and session token of one scope, as the S3 client takes them.
#[derive(Clone, PartialEq, Eq)]
pub struct Credential {
    access_key_id: String,
    secret_access_key: String,
    session_token: String,
    expires_at: u64,
}
impl Credential {
    /// A credential Cloudflare delivered (`ArchiveCredential` of the node contract), valid until
    /// `expires_at` (Unix seconds). `None` if a value could not travel in an environment file.
    pub fn delivered(
        access_key_id: &str,
        secret_access_key: &str,
        session_token: &str,
        expires_at: u64,
    ) -> Option<Self> {
        let plain = |value: &str| {
            !value.is_empty()
                && value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"/+=._~-".contains(&b))
        };
        (plain(access_key_id) && plain(secret_access_key) && plain(session_token)).then(|| Self {
            access_key_id: access_key_id.into(),
            secret_access_key: secret_access_key.into(),
            session_token: session_token.into(),
            expires_at,
        })
    }
    pub fn expired(&self, now: u64) -> bool {
        now >= self.expires_at
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

/// The credentials a node holds, by scope.
#[derive(Default)]
pub struct Credentials {
    held: RwLock<HashMap<Scope, Credential>>,
}
impl Credentials {
    /// Keeps a delivered credential for `scope`, replacing the earlier one.
    pub fn hold(&self, scope: Scope, credential: Credential) {
        self.held
            .write()
            .expect("credentials lock")
            .insert(scope, credential);
    }
    /// The credential to run a job with at `now`: the delivered one until it expires, which only
    /// Cloudflare renews. `credential_expired` when there is none to use.
    pub fn get(&self, scope: &Scope, now: u64) -> Result<Credential, &'static str> {
        self.held
            .read()
            .expect("credentials lock")
            .get(scope)
            .filter(|credential| !credential.expired(now))
            .cloned()
            .ok_or("credential_expired")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(access: Access) -> Scope {
        Scope {
            prefix: "eu-dev/abcdefghijklmnopqrst/g1-op_abcdefghijklmnopqrst/".into(),
            access,
        }
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
    fn a_delivered_credential_is_used_until_it_expires_and_never_invented() {
        let store = Credentials::default();
        let write = scope(Access::ReadWrite);
        assert_eq!(store.get(&write, 5), Err("credential_expired"));
        let delivered = Credential::delivered("keyid", "secret-value", "token+/=", 400).unwrap();
        store.hold(write.clone(), delivered.clone());
        assert_eq!(delivered.expires_at(), 400);
        assert_eq!(store.get(&write, 120).unwrap(), delivered);
        // Close to its end, but nothing here renews it: it still works until it expires.
        assert_eq!(store.get(&write, 399).unwrap(), delivered);
        assert_eq!(store.get(&write, 400), Err("credential_expired"));
        // A scope is its prefix and its access: a read-write credential is no read-only one.
        assert_eq!(
            store.get(&scope(Access::ReadOnly), 120),
            Err("credential_expired")
        );
        // A renewal replaces it.
        let renewed = Credential::delivered("keyid", "secret-value", "token-2", 900).unwrap();
        store.hold(write.clone(), renewed.clone());
        assert_eq!(store.get(&write, 500).unwrap(), renewed);
        // What cannot travel in an environment file is refused.
        assert!(Credential::delivered("key id", "secret", "token", 2).is_none());
        assert!(Credential::delivered("key", "se\ncret", "token", 2).is_none());
        assert!(Credential::delivered("key", "secret", "", 2).is_none());
    }

    #[test]
    fn no_secret_reaches_a_debug_print_or_a_scrubbed_log_line() {
        let credential =
            Credential::delivered("keyid", "secret/value+1=", "token.part-2_~", 1_000).unwrap();
        let printed = format!("{credential:?}");
        assert!(!printed.contains("secret/value+1="));
        assert!(!printed.contains("token.part-2_~"));
        let line = "denied token.part-2_~ for secret/value+1=";
        assert_eq!(credential.scrub(line), "denied <redacted> for <redacted>");
    }
}

// SPDX-License-Identifier: Apache-2.0
use crate::{
    Error,
    authority::{Verified, binding_fingerprint, fingerprint, limit, text, unsigned},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::Path,
};
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub operation: String,
    pub revision: u64,
    pub generation: u64,
    pub revoked: bool,
    pub spent: u64,
    pub budget: u64,
    pub fingerprint: String,
    pub identity_fingerprint: String,
    pub issued_at: u64,
    pub expires_at: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct State {
    version: u64,
    pub node_uid: String,
    pub boot_id: String,
    pub clock: u64,
    pub entries: BTreeMap<String, Entry>,
}
impl State {
    pub fn new(node: &str, boot: &str) -> Self {
        Self {
            version: 1,
            node_uid: node.into(),
            boot_id: boot.into(),
            clock: 0,
            entries: BTreeMap::new(),
        }
    }
    pub fn load(path: &Path, node: &str, boot: &str) -> Result<Self, Error> {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path);
        match file {
            Ok(file) => {
                use std::os::unix::fs::MetadataExt;
                let meta = file.metadata()?;
                if meta.uid() != 65532 || meta.mode() & 0o022 != 0 || !meta.is_file() {
                    return Err("untrusted reclaim state owner".into());
                }
                use std::io::Read;
                let mut bytes = vec![];
                file.take(2 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
                if bytes.len() > 2 * 1024 * 1024 {
                    return Err("reclaim state exceeds bound".into());
                }
                let state: Self = serde_json::from_slice(&bytes)?;
                if state.version != 1
                    || state.node_uid != node
                    || state.entries.len() > limit("max_tasks") as usize
                {
                    return Err("reclaim state identity invalid".into());
                }
                if state.boot_id != boot {
                    return Ok(Self::new(node, boot));
                }
                Ok(state)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::new(node, boot)),
            Err(e) => Err(e.into()),
        }
    }
    pub fn accept(&mut self, authority: &Verified, now: u64) -> Result<(), Error> {
        let claims = authority.claims();
        if now < self.clock
            || claims["node_uid"] != self.node_uid
            || claims["boot_id"] != self.boot_id
        {
            return Err("reclaim clock or node identity changed".into());
        }
        self.clock = now;
        let id = text(claims, "database_id");
        let operation = text(claims, "operation_id");
        let revision = unsigned(claims, "intent_revision")?;
        let budget = unsigned(claims, "budget_bytes")?;
        let digest = fingerprint(claims)?;
        let identity = binding_fingerprint(claims)?;
        let issued_at = unsigned(claims, "issued_at")?;
        let revoked = claims["mode"] == "revoked";
        let mut spent = 0;
        if let Some(prior) = self.entries.get(id) {
            if revision < prior.revision
                || revision == prior.revision && digest != prior.fingerprint
            {
                return Err("stale or conflicting reclaim authority".into());
            }
            if prior.operation == operation {
                if identity != prior.identity_fingerprint
                    || issued_at < prior.issued_at
                    || (issued_at == prior.issued_at
                        && unsigned(claims, "expires_at")? != prior.expires_at)
                {
                    return Err("reclaim renewal scope or issuance changed".into());
                }
                if prior.revoked && !revoked {
                    return Err("revoked reclaim operation cannot reopen".into());
                }
                if !revoked && budget != prior.budget {
                    return Err("reclaim renewal cannot replenish a budget".into());
                }
                spent = prior.spent;
            } else if revision <= prior.revision {
                return Err("new reclaim operation requires newer authority".into());
            }
        }
        self.entries.retain(|_, entry| {
            !entry.revoked
                || entry
                    .expires_at
                    .saturating_add(limit("lease_ms") + limit("clock_skew_ms"))
                    >= now
        });
        if !self.entries.contains_key(id) && self.entries.len() >= limit("max_tasks") as usize {
            return Err("reclaim state count bound reached".into());
        }
        self.entries.insert(
            id.into(),
            Entry {
                operation: operation.into(),
                revision,
                generation: unsigned(claims, "generation")?,
                revoked,
                spent,
                budget,
                fingerprint: digest,
                identity_fingerprint: identity,
                issued_at,
                expires_at: unsigned(claims, "expires_at")?,
            },
        );
        Ok(())
    }
    pub fn reserve(&mut self, claims: &Value, now: u64) -> Result<u64, Error> {
        if now < self.clock {
            return Err("reclaim clock moved backwards".into());
        }
        self.clock = now;
        let entry = self
            .entries
            .get_mut(text(claims, "database_id"))
            .ok_or("reclaim authority not accepted")?;
        if entry.revoked
            || entry.revision != unsigned(claims, "intent_revision")?
            || entry.operation != text(claims, "operation_id")
            || entry.expires_at <= now
        {
            return Err("reclaim authority expired or revoked".into());
        }
        let amount = unsigned(claims, "step_bytes")?.min(entry.budget.saturating_sub(entry.spent));
        if amount == 0 {
            return Err("reclaim budget exhausted".into());
        }
        entry.spent = entry
            .spent
            .checked_add(amount)
            .ok_or("reclaim budget overflow")?;
        Ok(amount)
    }
    pub fn save(&self, path: &Path) -> Result<(), Error> {
        atomic(path, &serde_json::to_vec(self)?, 0o600)
    }
}
pub fn atomic(path: &Path, bytes: &[u8], mode: u32) -> Result<(), Error> {
    let parent = path.parent().ok_or("reclaim file parent missing")?;
    let temporary = parent.join(format!(".pgcf-reclaim-{}.new", std::process::id()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(mode)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&temporary)?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        fs::File::open(parent)?.sync_all()?;
        Ok::<(), Error>(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::authority::Trust;
    fn source() -> (Value, Trust) {
        let v: Value = serde_json::from_str(include_str!(
            "../../../packages/contracts/native/reclaim-vectors.generated.json"
        ))
        .unwrap();
        let trust = Trust::new(&v["keyset"].to_string(), text(&v, "pin")).unwrap();
        (v, trust)
    }
    #[test]
    fn a_current_trusted_key_can_revoke_an_episode_issued_by_the_retained_key() {
        let (v, trust) = source();
        let active = trust.verify(text(&v, "token"), 1000).unwrap();
        let mut state = State::new(
            text(active.claims(), "node_uid"),
            text(active.claims(), "boot_id"),
        );
        state.accept(&active, 1000).unwrap();
        let rotated = Trust::new(&v["rotatedKeyset"].to_string(), text(&v, "rotatedPin")).unwrap();
        let revoked = rotated
            .verify(text(&v, "rotatedRevokedToken"), 1001)
            .unwrap();
        state.accept(&revoked, 1001).unwrap();
        assert!(state.entries[text(active.claims(), "database_id")].revoked);
    }
    #[test]
    fn spent_budget_survives_restart_and_revocation_cannot_reopen() {
        let (v, trust) = source();
        let auth = trust.verify(text(&v, "token"), 1000).unwrap();
        let mut state = State::new(
            text(auth.claims(), "node_uid"),
            text(auth.claims(), "boot_id"),
        );
        state.accept(&auth, 1000).unwrap();
        assert_eq!(state.reserve(auth.claims(), 1000).unwrap(), 1048576);
        let raw = serde_json::to_vec(&state).unwrap();
        let mut resumed: State = serde_json::from_slice(&raw).unwrap();
        resumed.accept(&auth, 1001).unwrap();
        assert_eq!(
            resumed.entries[text(auth.claims(), "database_id")].spent,
            1048576
        );
        let revoke = trust.verify(text(&v, "revokedToken"), 1001).unwrap();
        resumed.accept(&revoke, 1001).unwrap();
        assert!(resumed.accept(&auth, 1001).is_err());
        assert!(resumed.reserve(auth.claims(), 1001).is_err());
    }
    #[test]
    fn lease_budget_is_spent_before_an_uncertain_kernel_result() {
        let (v, trust) = source();
        let auth = trust.verify(text(&v, "token"), 1000).unwrap();
        let mut state = State::new(
            text(auth.claims(), "node_uid"),
            text(auth.claims(), "boot_id"),
        );
        state.accept(&auth, 1000).unwrap();
        for _ in 0..16 {
            state.reserve(auth.claims(), 1000).unwrap();
        }
        assert!(state.reserve(auth.claims(), 1000).is_err());
        assert!(state.accept(&auth, 999).is_err());
    }
}

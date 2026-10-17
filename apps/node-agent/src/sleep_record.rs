// SPDX-License-Identifier: Apache-2.0
//! The record of a clean sleep: what the next wake compares the volume's `pg_control` with.
use crate::{
    Error, contracts::configuration_fingerprint, pg_control::Control, sleep::SystemIdentity,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Whether `image` names an immutable digest.
fn pinned_image(image: &str) -> bool {
    image.rsplit_once("@sha256:").is_some_and(|(repo, digest)| {
        !repo.is_empty()
            && digest.len() == 64
            && digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
/// What a clean sleep left on the volume: the data directory's identity, and the configuration
/// and image it slept under.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SleepRecord {
    pub v: u8,
    pub system_identifier: String,
    pub timeline: u32,
    pub configuration_sha256: String,
    pub image: String,
    pub written_at_ms: u64,
}
impl SleepRecord {
    pub fn parse(text: &str) -> Option<Self> {
        if text.len() > 4096 {
            return None;
        }
        let record: Self = serde_json::from_str(text).ok()?;
        record.valid().then_some(record)
    }
    fn valid(&self) -> bool {
        self.v == 1
            && (1..=20).contains(&self.system_identifier.len())
            && self.system_identifier.bytes().all(|b| b.is_ascii_digit())
            && self.timeline >= 1
            && self.configuration_sha256.len() == 64
            && self
                .configuration_sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            && pinned_image(&self.image)
            && self.written_at_ms <= 9_007_199_254_740_991
    }
    /// The record of a sleep whose proof found PostgreSQL running on `system`, under the
    /// configuration and image of `db`. The attach of the next wake reads the volume's
    /// `pg_control` itself: a data directory that did not shut down cleanly is never served.
    pub fn proved(db: &Value, image: &str, system: &SystemIdentity, now_ms: u64) -> Option<Self> {
        Some(Self {
            v: 1,
            system_identifier: system.identifier.clone(),
            timeline: u32::try_from(system.timeline).ok()?,
            configuration_sha256: sleep_fingerprint(db, image).ok()?,
            image: db["postgres"]["image"].as_str().unwrap_or(image).into(),
            written_at_ms: now_ms,
        })
    }
    pub fn encode(&self) -> String {
        serde_json::to_string(self).expect("sleep record serializes")
    }
    /// Whether `control` is the data directory the record was written from.
    pub fn matches(&self, control: &Control) -> bool {
        control.system_identifier == self.system_identifier && control.timeline == self.timeline
    }
}
/// The configuration a sleep is recorded under: the configuration fingerprint without the
/// request fields that depend on whether the desired row runs.
pub fn sleep_fingerprint(db: &Value, fallback_image: &str) -> Result<String, Error> {
    let mut view = db.clone();
    if let Some(size) = view["size"].as_object_mut() {
        size.remove("memory_request_mib");
        size.remove("cpu_request_millicores");
    }
    configuration_fingerprint(&view, fallback_image)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    const IMAGE: &str = "registry.test/postgres@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    fn record() -> SleepRecord {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../packages/contracts/native/controller-vectors.generated.json"
        ))
        .unwrap();
        SleepRecord {
            v: 1,
            system_identifier: "7430000000000000001".into(),
            timeline: 1,
            configuration_sha256: sleep_fingerprint(&vectors[0]["db"], IMAGE).unwrap(),
            image: IMAGE.into(),
            written_at_ms: 1,
        }
    }
    #[test]
    fn the_sleep_record_roundtrips_and_refuses_unknown_fields() {
        let record = record();
        let text = record.encode();
        assert_eq!(SleepRecord::parse(&text), Some(record.clone()));
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["timeline"], 1);
        let mut extra = value.clone();
        extra["slot"] = "x".into();
        assert_eq!(SleepRecord::parse(&extra.to_string()), None);
        for (key, bad) in [
            ("v", json!(2)),
            ("system_identifier", json!("12a")),
            ("timeline", json!(0)),
            ("configuration_sha256", json!("A".repeat(64))),
            ("image", json!("registry.test/postgres:18")),
        ] {
            let mut wrong = value.clone();
            wrong[key] = bad;
            assert_eq!(SleepRecord::parse(&wrong.to_string()), None, "{key}");
        }
        assert_eq!(SleepRecord::parse("{"), None);
        // The record says whether a pg_control is the one it was written from.
        let control = Control {
            state: 1,
            system_identifier: "7430000000000000001".into(),
            timeline: 1,
        };
        assert!(record.matches(&control));
        assert!(!record.matches(&Control {
            timeline: 2,
            ..control.clone()
        }));
        assert!(!record.matches(&Control {
            system_identifier: "7430000000000000002".into(),
            ..control
        }));
    }
}

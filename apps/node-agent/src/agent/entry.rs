// SPDX-License-Identifier: Apache-2.0
//! The parts of the desired page the agent acts on (`NodeDesiredDatabase`, `NodePolicy`), read
//! from a page that passed its schema and the rules of the node (`node_link::desired_page_valid`).
use crate::{
    admission,
    archive::{job::Limits as JobLimits, restore::End},
    roles::{self, Wanted},
    storage,
};
use pgcf_native_protocol::wake;
use serde_json::Value;

/// `desired_state`: `running` wakes on connect and sleeps when idle; `suspended` stays asleep
/// until resume; `deleted` goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Desired {
    Running,
    Suspended,
    Deleted,
}

/// The archive a restore or a move reads: another database's, or this database's earlier storage
/// generation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Source {
    pub database_id: String,
    pub path: String,
    pub backup_id: String,
    pub target_time: Option<String>,
    /// The credential that reads it (`ArchiveCredential` by this identifier).
    pub credential_id: String,
}

/// How the node builds the storage generation (`DatabaseOrigin`). It is absent once the
/// generation was ready.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Origin {
    Create,
    Restore(Source),
    /// This database's previous storage generation, to the end of its WAL: `end` is the record
    /// that proved the source's sleep.
    Move(Source, End),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub id: String,
    pub generation: u64,
    pub operation: String,
    pub desired: Desired,
    pub route_revision: u64,
    pub storage_generation: u64,
    pub memory_mib: u64,
    pub cpu_millicores: u32,
    pub storage_gib: u64,
    pub max_connections: u32,
    pub archive_timeout_seconds: u32,
    /// The effective idle time; `None` is always warm.
    pub sleep_after_seconds: Option<u64>,
    pub roles: Vec<Wanted>,
    pub archive_path: String,
    pub credential_id: String,
    pub origin: Option<Origin>,
}

fn string(value: &Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(String::from)
}
fn number(value: &Value, key: &str) -> Option<u64> {
    value.get(key)?.as_u64()
}

fn source(value: &Value) -> Option<Source> {
    Some(Source {
        database_id: string(value, "database_id")?,
        path: string(value, "path")?,
        backup_id: string(value, "backup_id")?,
        target_time: value
            .get("target_time")
            .and_then(Value::as_str)
            .map(String::from),
        credential_id: string(&value["credential"], "id")?,
    })
}

impl Entry {
    /// `None` for an entry that is not what the contract states.
    pub fn parse(db: &Value) -> Option<Self> {
        let origin = match db.get("origin") {
            None => None,
            Some(origin) => Some(match origin["kind"].as_str()? {
                "create" => Origin::Create,
                "restore" => Origin::Restore(source(&origin["source"])?),
                "move" => {
                    let end = &origin["source"]["end"];
                    Origin::Move(
                        source(&origin["source"])?,
                        End {
                            system_identifier: string(end, "system_identifier")?,
                            timeline: u32::try_from(number(end, "timeline")?).ok()?,
                            last_segment: string(end, "last_archived_segment")?,
                        },
                    )
                }
                _ => return None,
            }),
        };
        Some(Self {
            id: string(db, "id")?,
            generation: number(db, "generation")?,
            operation: string(db, "operation")?,
            desired: match db["desired_state"].as_str()? {
                "running" => Desired::Running,
                "suspended" => Desired::Suspended,
                "deleted" => Desired::Deleted,
                _ => return None,
            },
            route_revision: number(db, "route_revision")?,
            storage_generation: number(db, "storage_generation")?,
            memory_mib: number(&db["resources"], "memory_mib")?,
            cpu_millicores: u32::try_from(number(&db["resources"], "cpu_millicores")?).ok()?,
            storage_gib: number(&db["resources"], "storage_gib")?,
            max_connections: u32::try_from(number(&db["settings"], "max_connections")?).ok()?,
            archive_timeout_seconds: u32::try_from(number(
                &db["settings"],
                "archive_timeout_seconds",
            )?)
            .ok()?,
            sleep_after_seconds: match &db["sleep_after_seconds"] {
                Value::Null => None,
                seconds => Some(seconds.as_u64()?),
            },
            roles: roles::parse(db["roles"].as_array()?)?,
            archive_path: string(&db["archive"], "path")?,
            credential_id: string(&db["archive"]["credential"], "id")?,
            origin,
        })
    }
    /// The nominal size of the volume.
    pub fn volume_bytes(&self) -> u64 {
        self.storage_gib << 30
    }
    /// `role_revision_hash` of the roles the database holds (plan 5.3): what a wake ticket carries.
    pub fn role_hash(&self) -> String {
        wake::role_revision_hash(self.roles.iter().filter_map(|role| match role {
            Wanted::Present(role) => Some((role.name.as_str(), role.revision)),
            Wanted::Absent(_) => None,
        }))
    }
    /// The revision of every present role.
    pub fn role_revisions(&self) -> std::collections::BTreeMap<String, u64> {
        self.roles
            .iter()
            .filter_map(|role| match role {
                Wanted::Present(role) => Some((role.name.clone(), role.revision)),
                Wanted::Absent(_) => None,
            })
            .collect()
    }
}

/// The rules Cloudflare sets for the decisions of the node (`NodePolicy`).
#[derive(Clone, Debug)]
pub struct Policy {
    pub admission: admission::Policy,
    pub storage: storage::Policy,
    pub backup: JobLimits,
    /// The write limits of a 256 MiB database: bytes per second and operations per second.
    pub write_bytes_per_second: u64,
    pub write_iops: u64,
}
impl Policy {
    /// `None` for a policy that is not what the contract states.
    pub fn parse(policy: &Value) -> Option<Self> {
        Some(Self {
            admission: serde_json::from_value(policy.clone()).ok()?,
            storage: storage::Policy::from_json(&policy["storage"])?,
            backup: JobLimits::from_policy(&policy["backup"])?,
            write_bytes_per_second: number(&policy["io"], "write_bytes_per_second")?,
            write_iops: number(&policy["io"], "write_iops")?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::link::test_server::{database, vector};
    use serde_json::json;

    #[test]
    fn the_example_entry_of_the_contract_is_read() {
        let entry = Entry::parse(&database("dbbbbbbbbbbbbbbbbbbb")).unwrap();
        assert_eq!(entry.generation, 4);
        assert_eq!(entry.operation, "op_cccccccccccccccccccc");
        assert_eq!(entry.desired, Desired::Running);
        assert_eq!(
            (entry.memory_mib, entry.cpu_millicores, entry.storage_gib),
            (256, 250, 1)
        );
        assert_eq!(entry.volume_bytes(), 1 << 30);
        assert_eq!(
            (entry.max_connections, entry.archive_timeout_seconds),
            (25, 60)
        );
        assert_eq!(entry.sleep_after_seconds, Some(300));
        assert_eq!(entry.storage_generation, 1);
        assert_eq!(entry.credential_id, "crd_kkkkkkkkkkkkkkkkkkkk");
        assert_eq!(entry.origin, None);
        assert_eq!(entry.roles.len(), 3);
        assert_eq!(
            entry.role_revisions(),
            [("app".to_string(), 1), ("reader".to_string(), 2)].into()
        );
        // The hash a wake ticket carries is the one of the roles that are present.
        assert_eq!(
            entry.role_hash(),
            wake::role_revision_hash([("app", 1), ("reader", 2)])
        );
    }

    #[test]
    fn the_origins_of_a_build_and_an_always_warm_database_are_read() {
        let mut db = database("dbbbbbbbbbbbbbbbbbbb");
        db["sleep_after_seconds"] = Value::Null;
        db["origin"] = json!({"kind":"create"});
        let entry = Entry::parse(&db).unwrap();
        assert_eq!(
            (entry.sleep_after_seconds, entry.origin),
            (None, Some(Origin::Create))
        );
        db["origin"] = json!({"kind":"restore","source":{
            "database_id":"eeeeeeeeeeeeeeeeeeee",
            "path":"s3://pgcf-eu/eu-dev/eeeeeeeeeeeeeeeeeeee/g1-op_aaaaaaaaaaaaaaaaaaaa",
            "backup_id":"20261017T225342","target_time":"2026-10-17T22:53:45.664Z",
            "credential":{"id":"crd_rrrrrrrrrrrrrrrrrrrr","expires_at":"2026-10-24T12:00:00.000Z"}}});
        let Some(Origin::Restore(restore)) = Entry::parse(&db).unwrap().origin else {
            panic!("a restore");
        };
        assert_eq!(restore.database_id, "eeeeeeeeeeeeeeeeeeee");
        assert_eq!(
            restore.target_time.as_deref(),
            Some("2026-10-17T22:53:45.664Z")
        );
        assert_eq!(restore.credential_id, "crd_rrrrrrrrrrrrrrrrrrrr");
        db["origin"] = json!({"kind":"move","source":{
            "database_id":"dbbbbbbbbbbbbbbbbbbb",
            "path":"s3://pgcf-eu/eu-dev/dbbbbbbbbbbbbbbbbbbb/g1-op_aaaaaaaaaaaaaaaaaaaa",
            "backup_id":"20261017T225342",
            "credential":{"id":"crd_rrrrrrrrrrrrrrrrrrrr","expires_at":"2026-10-24T12:00:00.000Z"},
            "end":{"system_identifier":"7431215993172011234","timeline":1,"checkpoint_lsn":"0/3000028",
                   "last_archived_segment":"000000010000000000000002","proven_at":"2026-10-17T22:53:45.664Z"}}});
        db["storage_generation"] = json!(2);
        db["archive"]["path"] =
            json!("s3://pgcf-eu/eu-dev/dbbbbbbbbbbbbbbbbbbb/g2-op_cccccccccccccccccccc");
        let Some(Origin::Move(source, end)) = Entry::parse(&db).unwrap().origin else {
            panic!("a move");
        };
        assert_eq!(source.target_time, None);
        assert_eq!(end.last_segment, "000000010000000000000002");
        assert_eq!(
            (end.timeline, end.system_identifier.as_str()),
            (1, "7431215993172011234")
        );
    }

    #[test]
    fn an_entry_that_breaks_the_contract_is_none() {
        for (key, value) in [
            ("desired_state", json!("paused")),
            ("generation", json!(-1)),
            (
                "roles",
                json!([{"name":"A b","owner":true,"password":"x","revision":1}]),
            ),
            ("origin", json!({"kind":"clone"})),
        ] {
            let mut db = database("dbbbbbbbbbbbbbbbbbbb");
            db[key] = value;
            assert_eq!(Entry::parse(&db), None, "{key}");
        }
        let mut db = database("dbbbbbbbbbbbbbbbbbbb");
        db["resources"]
            .as_object_mut()
            .unwrap()
            .remove("storage_gib");
        assert_eq!(Entry::parse(&db), None);
    }

    #[test]
    fn the_policy_of_the_page_gives_the_rules_of_the_node() {
        let page = vector("NodeDesiredPage", "full-page");
        let policy = Policy::parse(&page["policy"]).unwrap();
        assert_eq!(policy.admission.admission.start_concurrency, 4);
        assert_eq!(policy.admission.admission.cpu_boost_ms, 5000);
        assert!(policy.admission.early_sleep.enabled);
        assert_eq!(policy.storage.reserve_bytes, 6 << 30);
        assert_eq!(policy.backup.wal_jobs, 2);
        assert_eq!(
            (policy.write_bytes_per_second, policy.write_iops),
            (16_000_000, 1000)
        );
        assert!(Policy::parse(&json!({"admission": {}})).is_none());
    }
}

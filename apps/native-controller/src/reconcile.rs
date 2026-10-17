// SPDX-License-Identifier: Apache-2.0
use crate::{
    Error,
    api::DesiredSnapshot,
    contracts::{
        applied_role_revisions, constant, database_valid, generation, namespace, number,
        optional_number, present_roles, text,
    },
    health::{self, ArchiveSample, Health},
    kubernetes::{Kubernetes, bounded},
    manifests, postgres,
    power::{PowerCoordinator, PrepareRunning, desired_power, fenced},
    timing,
};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use hmac::{Hmac, KeyInit, Mac};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    net::IpAddr,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

mod removal;

const SYSTEM: &str = "pgcf-system";
const LABEL: &str = "pgcf.io/database-id";
const GENERATION: &str = "pgcf.io/generation";
const ACCEPTED: &str = "pgcf.io/accepted-generation";
const VOLUME: &str = "pgcf.io/volume-identity";
const RUNTIME: &str = "pgcf.io/compute-runtime";
const SWITCH: &str = "pgcf.io/runtime-switch";
const PRESTARTED: &str = "pgcf-prestarted";
const PROFILE: &str = "pgcf.io/compute-profile";
const ADMISSION: &str = "pgcf-cnpg-prestarted";
/// Longest the controller waits for its own watch to deliver a write of its own before it reads
/// the runtime proof back.
const WATCH_LAG: Duration = Duration::from_millis(500);
/// What an archive probe found: the archive's health and whether it alarms.
struct Probed {
    archive: Value,
    alarm: bool,
}
struct RuntimeResources<'a> {
    namespace: &'a Value,
    cluster: &'a Value,
    pod: &'a Value,
    ca: &'a Value,
    node: &'a Value,
}
/// What a runtime attestation is formed from: the resources it names, the `postgres`
/// container's spec, the TLS authority and the storage receipt and volume of the database.
struct Attesting<'a> {
    resources: RuntimeResources<'a>,
    container: &'a Value,
    ca: &'a [u8],
    storage: &'a Value,
    volume: &'a Value,
    tls_server_name: String,
    continuity: Option<(String, u64)>,
}
pub struct Reconciler {
    pub k8s: Kubernetes,
    pub power: PowerCoordinator,
    /// The pool of free PostgreSQL instances (pool design 2026-10-16).
    pub pool: crate::pool::Pool,
    pub health: Health,
    pub cluster_uid: String,
    postgres_image: String,
    pub(crate) http: reqwest::Client,
}
fn uid(v: &Value) -> Result<&str, Error> {
    let value = text(&v["metadata"], "uid");
    if value.is_empty() {
        Err("resource UID missing".into())
    } else {
        Ok(value)
    }
}
fn owned(v: &Value, db: &Value, name: &str, ns: Option<&str>) -> Result<(), Error> {
    if text(&v["metadata"], "name") != name
        || v["metadata"]["namespace"].as_str() != ns
        || text(&v["metadata"]["labels"], LABEL) != text(db, "id")
        || text(&v["metadata"], "resourceVersion").is_empty()
        || !v["metadata"]["deletionTimestamp"].is_null()
    {
        return Err("database resource ownership changed".into());
    }
    uid(v)?;
    for key in [GENERATION, ACCEPTED] {
        if let Some(value) = v["metadata"]["annotations"][key].as_str() {
            if value.starts_with('0')
                || value
                    .parse::<u64>()
                    .ok()
                    .is_none_or(|v| v == 0 || v > 9_007_199_254_740_991)
            {
                return Err("resource generation annotation invalid".into());
            }
        } else if !v["metadata"]["annotations"][key].is_null() {
            return Err("resource generation annotation invalid".into());
        }
    }
    Ok(())
}
/// The `postgres` container's status of a Pod.
fn postgres_status(pod: &Value) -> Option<&Value> {
    pod["status"]["containerStatuses"]
        .as_array()
        .and_then(|all| all.iter().find(|c| text(c, "name") == "postgres"))
}
fn condition<'a>(v: &'a Value, name: &str) -> Option<&'a str> {
    v["status"]["conditions"]
        .as_array()?
        .iter()
        .find(|c| text(c, "type") == name)?["status"]
        .as_str()
}
/// Whether CNPG holds the Cluster hibernated. Its condition is typed `cnpg.io/hibernation` and
/// reports `Hibernated` as its reason; the annotation alone also asks for hibernation.
fn hibernated(cluster: &Value) -> bool {
    cluster["metadata"]["annotations"]["cnpg.io/hibernation"] == "on"
        || cluster["status"]["conditions"]
            .as_array()
            .is_some_and(|all| {
                all.iter().any(|c| {
                    c["type"] == "cnpg.io/hibernation"
                        && c["status"] == "True"
                        && c["reason"] == "Hibernated"
                })
            })
}
/// Whether applying `db` to its Cluster starts PostgreSQL on the volume, which a thin volume
/// admits only while its node's thin pool has room: resuming a hibernated or fenced Cluster, a
/// Cluster without a primary, and a change of image, resources or parameters that rolls the
/// primary.
fn starts_postgres(cluster: Option<&Value>, db: &Value, default_image: &str) -> bool {
    let size = &db["size"];
    let expected = json!({"requests":{"cpu":format!("{}m",optional_number(size,"cpu_request_millicores",number(size,"cpu_millicores"))),"memory":format!("{}Mi",optional_number(size,"memory_request_mib",number(size,"memory_mib")))},"limits":{"cpu":format!("{}m",number(size,"cpu_millicores")),"memory":format!("{}Mi",number(size,"memory_mib"))}});
    cluster.is_none_or(|cluster| {
        hibernated(cluster)
            || fenced(cluster)
            || text(&cluster["status"], "currentPrimary").is_empty()
            || text(&cluster["spec"], "imageName")
                != db["postgres"]["image"].as_str().unwrap_or(default_image)
            || !contains(&cluster["spec"]["resources"], &expected, "resources")
            || !contains(
                &cluster["spec"]["postgresql"]["parameters"],
                &manifests::parameters(db),
                "",
            )
    })
}
fn credential_acknowledged(db: &Value, cluster: &Value, secret: &Value) -> bool {
    let name = text(&secret["metadata"], "name");
    // A role awaiting removal has no Secret to acknowledge.
    let role = present_roles(db).find(|role| manifests::role_secret(text(role, "name")) == name);
    let role = role.or_else(|| {
        (name == "maintenance-credentials" && !db["maintenance"].is_null())
            .then_some(&db["maintenance"])
    });
    let Some(role) = role else { return true };
    let role_name = role["name"]
        .as_str()
        .or_else(|| role["role"].as_str())
        .unwrap_or("");
    let accepted = secret["metadata"]["annotations"][ACCEPTED]
        .as_str()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    if owned(secret, db, name, Some(&namespace(db))).is_err()
        || secret["apiVersion"] != "v1"
        || secret["kind"] != "Secret"
        || secret["type"] != "kubernetes.io/basic-auth"
        || secret["metadata"]["labels"]["cnpg.io/reload"] != "true"
        || generation(secret) == 0
        || generation(secret) > number(db, "generation")
        || accepted > number(db, "generation")
        || secret["data"]
            .as_object()
            .is_none_or(|data| data.len() != 2)
        || secret["data"]["username"] != STANDARD.encode(role_name)
        || secret["data"]["password"] != STANDARD.encode(text(role, "password"))
    {
        return false;
    }
    if role["owner"] == true {
        cluster["status"]["secretsResourceVersion"]["applicationSecretVersion"]
            == secret["metadata"]["resourceVersion"]
    } else {
        let status = &cluster["status"]["managedRolesStatus"];
        status["byStatus"]["reconciled"]
            .as_array()
            .is_some_and(|roles| roles.iter().any(|role| role == role_name))
            && status["passwordStatus"][role_name]["resourceVersion"]
                == secret["metadata"]["resourceVersion"]
    }
}
/// Pool Pods run under the pre-started RuntimeClass; standard Pods name no RuntimeClass.
fn runtime_class(context: &Value) -> &'static str {
    if context["computePool"].is_null() {
        ""
    } else {
        PRESTARTED
    }
}
fn dns_label(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 63
        && !value.starts_with('-')
        && !value.ends_with('-')
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
/// A ready primary is current only on its assigned node and the selected runtime.
fn primary_current(pod: &Value, cluster: &Value, db: &Value, context: &Value) -> bool {
    cluster_owned(pod, cluster)
        && condition(pod, "Ready") == Some("True")
        && pod["spec"]["nodeName"] == db["node"]
        && pod["metadata"]["deletionTimestamp"].is_null()
        && text(&pod["spec"], "runtimeClassName") == runtime_class(context)
}
/// The desired record of a sleeping database as its wake will receive it: the API states the
/// power of a sleeping database as a sleep and leaves out the regional scheduling request.
pub(crate) fn awake(db: &Value, scheduling: &Value) -> Value {
    let mut awake = db.clone();
    awake["desired_state"] = "running".into();
    if awake["power"].is_object() {
        awake["power"]["mode"] = "running".into();
        awake["power"]["reason"] = Value::Null;
    }
    if let Some(request) = scheduling["postgres_memory_request_mib"].as_u64() {
        awake["size"]["memory_request_mib"] = request.into();
    }
    awake
}
pub(crate) fn cluster_owned(v: &Value, cluster: &Value) -> bool {
    v["metadata"]["ownerReferences"]
        .as_array()
        .is_some_and(|owners| {
            owners.iter().any(|owner| {
                owner["uid"] == cluster["metadata"]["uid"]
                    && text(owner, "kind") == "Cluster"
                    && text(owner, "name") == "database"
                    && owner["apiVersion"] == cluster["apiVersion"]
            })
        })
}
pub fn quantity(v: &Value) -> Option<f64> {
    if let Some(n) = v.as_f64() {
        return n.is_finite().then_some(n);
    }
    let s = v.as_str()?;
    if s.trim() != s || s.is_empty() {
        return None;
    }
    let suffixes = [
        ("Ei", 2_f64.powi(60)),
        ("Pi", 2_f64.powi(50)),
        ("Ti", 2_f64.powi(40)),
        ("Gi", 2_f64.powi(30)),
        ("Mi", 2_f64.powi(20)),
        ("Ki", 1024.0),
        ("E", 1e18),
        ("P", 1e15),
        ("T", 1e12),
        ("G", 1e9),
        ("M", 1e6),
        ("k", 1000.0),
        ("m", 0.001),
        ("u", 0.000001),
        ("n", 0.000000001),
    ];
    let (value, factor) = suffixes
        .iter()
        .find_map(|(suffix, factor)| s.strip_suffix(suffix).map(|s| (s, *factor)))
        .unwrap_or((s, 1.0));
    let n = value.parse::<f64>().ok()? * factor;
    n.is_finite().then_some(n)
}
pub(crate) fn contains(actual: &Value, desired: &Value, path: &str) -> bool {
    if [
        "resources.requests.cpu",
        "resources.requests.memory",
        "resources.limits.cpu",
        "resources.limits.memory",
        "storage.size",
        "hard.requests.cpu",
        "hard.limits.cpu",
        "hard.requests.memory",
        "hard.limits.memory",
        "hard.requests.storage",
    ]
    .contains(&path)
    {
        return quantity(actual)
            .zip(quantity(desired))
            .is_some_and(|(a, b)| (a - b).abs() <= b.abs().max(1.0) * 1e-12);
    }
    match desired {
        Value::Object(values) => actual.as_object().is_some_and(|_| {
            values.iter().all(|(k, v)| {
                contains(
                    &actual[k],
                    v,
                    &if path.is_empty() {
                        k.clone()
                    } else {
                        format!("{path}.{k}")
                    },
                )
            })
        }),
        Value::Array(values) => actual.as_array().is_some_and(|a| {
            a.len() == values.len() && a.iter().zip(values).all(|(a, b)| contains(a, b, ""))
        }),
        _ => actual == desired,
    }
}
/// The node storage row stands for the database's own node, volume group and thin pool.
fn storage_guard(db: &Value, node: &Value, row: &Value) -> Result<(), Error> {
    let storage = &db["storage"];
    if row["node_uid"] != node["metadata"]["uid"]
        || row["node_uid"] != storage["node_uid"]
        || row["volume_group_uuid"] != storage["volume_group_uuid"]
        || row["pool_uuid"] != storage["pool_uuid"]
    {
        return Err("thin node storage identity changed".into());
    }
    Ok(())
}
fn now() -> i128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i128)
        .unwrap_or(-1)
}
fn observation(db: &Value, state: &str, message: Option<&str>) -> Value {
    let mut value = json!({"id":db["id"],"generation":db["generation"],"state":state,"archive":{"continuous":false,"ready_wal_files":null,"health":"unknown"}});
    if let Some(message) = message {
        value["message"] = message.into();
    }
    value
}
fn state(map: &Value) -> Result<Value, Error> {
    let raw = text(&map["data"], "state");
    if raw.len() > 16384 {
        return Err("storage receipt exceeds bound".into());
    }
    let state: Value = serde_json::from_str(raw)?;
    if !state.is_object()
        || text(&state, "node").is_empty()
        || text(&state, "archivePath").is_empty()
        || !(state["namespaceUid"].is_null() || state["namespaceUid"].is_string())
        || !(state["clusterUid"].is_null() || state["clusterUid"].is_string())
    {
        return Err("storage receipt invalid".into());
    }
    Ok(state)
}
fn pending_creation(db: &Value) -> bool {
    let expected = format!(
        "g{}-{}",
        optional_number(db, "storage_generation", 1),
        if !db["recovery"].is_null() {
            text(&db["recovery"], "operation_id")
        } else {
            text(&db["creation"], "operation_id")
        }
    );
    let origin = if !db["recovery"].is_null() {
        &db["recovery"]
    } else {
        &db["creation"]
    };
    origin["ever_ready"] == false
        && matches!(text(origin, "status"), "pending" | "running")
        && text(&db["archive"], "destination_path").ends_with(&expected)
}
fn native_lvm_owned(db: &Value, receipt: &Value, lvm: &Value) -> bool {
    lvm["metadata"]["name"] == receipt["volume_handle"]
        && uid(lvm).is_ok()
        && lvm["metadata"]["deletionTimestamp"].is_null()
        && lvm["spec"]["ownerNodeID"] == db["node"]
        && lvm["status"]["state"] == "Ready"
}
/// The TLS authority a Cluster's server CA Secret holds.
fn ca_bytes(secret: &Value, cluster: &Value) -> Result<Vec<u8>, Error> {
    if !cluster_owned(secret, cluster)
        || text(&secret["metadata"], "uid").is_empty()
        || text(&secret["metadata"], "resourceVersion").is_empty()
        || !secret["metadata"]["deletionTimestamp"].is_null()
    {
        return Err("CNPG CA secret is deleting".into());
    }
    let encoded = text(&secret["data"], "ca.crt");
    if encoded.len() > 128 * 1024 {
        return Err("CNPG CA exceeds bound".into());
    }
    let ca = STANDARD.decode(encoded)?;
    postgres::validate_ca(&ca)?;
    Ok(ca)
}
impl Reconciler {
    /// Native has already bound this thin volume. Pin that physical custody before Ready.
    async fn bind_native_volume(
        &self,
        db: &Value,
        authority: &Value,
        scope: (&Value, &Value, &Value),
    ) -> Result<Option<Value>, Error> {
        let (namespace_value, cluster, storage) = scope;
        if db["storage"].is_null() || !storage["metadata"]["annotations"][VOLUME].is_null() {
            return Ok(None);
        }
        let receipts = authority["volumes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|receipt| {
                receipt["database_id"] == db["id"]
                    && receipt["generation"] == db["generation"]
                    && receipt["storage_generation"].as_u64()
                        == Some(optional_number(db, "storage_generation", 1))
            })
            .collect::<Vec<_>>();
        if receipts.is_empty() {
            return Ok(None);
        }
        if receipts.len() != 1 {
            return Err("physical storage custody ambiguous".into());
        }
        let receipt = receipts[0];
        let ns = namespace(db);
        let claims = self
            .k8s
            .list("PersistentVolumeClaim", Some(&ns), None)
            .await?;
        let matching = claims
            .iter()
            .filter(|claim| claim["metadata"]["uid"] == receipt["pvc_uid"])
            .collect::<Vec<_>>();
        if matching.len() != 1 {
            return Err("physical storage claim missing or replaced".into());
        }
        let claim = matching[0];
        let Some(pv) = self
            .k8s
            .read("PersistentVolume", None, text(&claim["spec"], "volumeName"))
            .await?
        else {
            return Err("physical storage volume missing or replaced".into());
        };
        let lvs = self.k8s.list("LVMVolume", None, None).await?;
        let matching = lvs
            .iter()
            .filter(|lv| lv["metadata"]["name"] == receipt["volume_handle"])
            .collect::<Vec<_>>();
        if matching.len() != 1 || !native_lvm_owned(db, receipt, matching[0]) {
            return Err("physical storage LVM identity missing or replaced".into());
        }
        let identity = crate::power::native_volume_identity(
            db,
            authority,
            (namespace_value, cluster, storage),
            (claim, &pv),
            u64::try_from(now()).map_err(|_| "physical storage clock invalid")?,
        )
        .ok_or("physical storage custody changed")?;
        // The storage UID/state and resourceVersion used for the proof fence this patch.
        // An uncertain patch is read on the next reconcile; it is never replayed blindly.
        let written = self
            .k8s
            .patch(
                storage,
                &json!({"metadata":{"annotations":{VOLUME:serde_json::to_string(&identity)?}}}),
            )
            .await?;
        if written["metadata"]["uid"] != storage["metadata"]["uid"]
            || state(&written)? != state(storage)?
            || written["metadata"]["annotations"][VOLUME]
                .as_str()
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                != Some(identity)
        {
            return Err("physical storage custody write unknown".into());
        }
        Ok(Some(written))
    }
    async fn bind_volume(
        &self,
        db: &Value,
        cluster: &Value,
        pod: &Value,
        authority: &Value,
        stored: &Value,
    ) -> Result<Option<Value>, Error> {
        let name = format!("storage-{}", text(db, "id"));
        // The volume is derived while the receipt it is recorded in is read.
        let (identity, current) = tokio::try_join!(
            self.volume(db, cluster, pod, authority),
            self.k8s.read_known("ConfigMap", Some(SYSTEM), &name)
        )?;
        let Some(identity) = identity else {
            return Ok(None);
        };
        let current = current.ok_or("storage receipt disappeared")?;
        owned(&current, db, &name, Some(SYSTEM))?;
        if state(&current)? != *stored {
            return Err("storage receipt changed before physical binding".into());
        }
        if let Some(old) = current["metadata"]["annotations"][VOLUME].as_str() {
            if serde_json::from_str::<Value>(old)? != identity {
                return Err("physical storage identity changed".into());
            }
        } else {
            self.k8s
                .patch(
                    &current,
                    &json!({"metadata":{"annotations":{VOLUME:serde_json::to_string(&identity)?}}}),
                )
                .await?;
        }
        Ok(Some(identity))
    }
    async fn volume(
        &self,
        db: &Value,
        cluster: &Value,
        pod: &Value,
        authority: &Value,
    ) -> Result<Option<Value>, Error> {
        let ns = namespace(db);
        let primary = text(&cluster["status"], "currentPrimary");
        let claim_name = pod["spec"]["volumes"]
            .as_array()
            .and_then(|v| v.iter().find(|v| text(v, "name") == "pgdata"))
            .map(|v| text(&v["persistentVolumeClaim"], "claimName"))
            .ok_or("primary volume claim missing")?;
        if claim_name != primary {
            return Err("primary volume claim changed".into());
        }
        let Some(claim) = self
            .k8s
            .read_known("PersistentVolumeClaim", Some(&ns), claim_name)
            .await?
        else {
            return Ok(None);
        };
        let class = db["storage"]["storage_class"]
            .as_str()
            .unwrap_or("pgcf-lvm");
        if !cluster_owned(&claim, cluster)
            || text(&claim["status"], "phase") != "Bound"
            || text(&claim["spec"], "storageClassName") != class
            || !claim["metadata"]["deletionTimestamp"].is_null()
        {
            return Ok(None);
        }
        let capacity = number(&db["size"], "storage_gib") as f64 * 2_f64.powi(30);
        if quantity(&claim["spec"]["resources"]["requests"]["storage"]) != Some(capacity)
            || quantity(&claim["status"]["capacity"]["storage"]) != Some(capacity)
        {
            return Ok(None);
        }
        let name = text(&claim["spec"], "volumeName");
        let Some(pv) = self.k8s.read_known("PersistentVolume", None, name).await? else {
            return Ok(None);
        };
        if pv["spec"]["claimRef"]["uid"] != claim["metadata"]["uid"]
            || text(&pv["spec"]["claimRef"], "namespace") != ns
            || text(&pv["spec"]["csi"], "driver") != "local.csi.openebs.io"
            || text(&pv["spec"], "storageClassName") != class
            || text(&pv["status"], "phase") != "Bound"
            || !pv["metadata"]["deletionTimestamp"].is_null()
            || quantity(&pv["spec"]["capacity"]["storage"]) != Some(capacity)
        {
            return Ok(None);
        }
        if pv["spec"]["nodeAffinity"]["required"]["nodeSelectorTerms"].is_null() {
            return Err("local volume affinity missing".into());
        }
        if !pinned_to_node(&pv, text(db, "node")) {
            return Err("local volume node affinity changed".into());
        }
        let handle = text(&pv["spec"]["csi"], "volumeHandle");
        if handle.is_empty() {
            return Err("volume handle missing".into());
        }
        let mut identity = json!({"claimUid":uid(&claim)?,"volumeUid":uid(&pv)?,"handle":handle});
        if !db["storage"].is_null() {
            let storage = &db["storage"];
            if claim["spec"]["volumeAttributesClassName"] != storage["volume_attributes_class"]
                || claim["status"]["currentVolumeAttributesClassName"]
                    != storage["volume_attributes_class"]
                || !claim["status"]["modifyVolumeStatus"].is_null()
            {
                return Ok(None);
            }
            let reported = authority["volumes"].as_array().and_then(|volumes| {
                volumes.iter().find(|v| {
                    v["database_id"] == db["id"]
                        && text(v, "volume_handle") == handle
                        && v["pvc_uid"] == claim["metadata"]["uid"]
                        && v["pv_uid"] == pv["metadata"]["uid"]
                        && v["storage_class"] == storage["storage_class"]
                        && v["volume_attributes_class"] == storage["volume_attributes_class"]
                })
            });
            let Some(reported) = reported else {
                return Ok(None);
            };
            identity["lvUuid"] = reported["lv_uuid"].clone();
        }
        Ok(Some(identity))
    }
    /// The health of the database's continuous archive, sampled from the primary `pod` of
    /// `cluster`, which are read again after the sample and must still be the same.
    async fn archive(
        &self,
        db: &Value,
        cluster: &Value,
        pod: &Value,
        ca: &[u8],
    ) -> Result<Probed, Error> {
        let now = (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64;
        let ns = namespace(db);
        let maintenance = self
            .k8s
            .read("Secret", Some(&ns), "maintenance-credentials")
            .await?;
        let sql_eligible = maintenance.as_ref().is_some_and(|secret| {
            !db["maintenance"].is_null()
                && owned(secret, db, "maintenance-credentials", Some(&ns)).is_ok()
                && generation(secret) > 0
                && generation(secret) <= number(db, "generation")
                && secret["data"]["username"] == STANDARD.encode(text(&db["maintenance"], "role"))
                && secret["data"]["password"]
                    == STANDARD.encode(text(&db["maintenance"], "password"))
                && cluster["status"]["managedRolesStatus"]["byStatus"]["reconciled"]
                    .as_array()
                    .is_some_and(|roles| roles.contains(&db["maintenance"]["role"]))
                && cluster["status"]["managedRolesStatus"]["passwordStatus"]
                    [text(&db["maintenance"], "role")]["resourceVersion"]
                    == secret["metadata"]["resourceVersion"]
        });
        let sample = if sql_eligible {
            let result=async {
                let session=postgres::connect_via(db,ca,text(&db["maintenance"],"role"),text(&db["maintenance"],"password"),text(db,"id"),self.power.postgres).await?;
                let identity=session.query(constant("ARCHIVE_IDENTITY_QUERY").as_str().ok_or("archive SQL not generated")?,&[&text(&db["maintenance"],"role")]).await?;
                if identity.len()!=1{return Err::<ArchiveSample,Error>("archive SQL identity missing".into());}
                let row=&identity[0];
                if row.try_get::<_,String>("database")?!=text(db,"id")||row.try_get::<_,String>("role")?!=text(&db["maintenance"],"role")||row.try_get::<_,String>("server_address")?!=text(&pod["status"],"podIP")||["recovery","rolsuper","rolcreatedb","rolcreaterole","rolreplication","rolbypassrls"].iter().any(|key|row.try_get::<_,bool>(*key).unwrap_or(true))||["tls","stats","only_stats","archive_listing"].iter().any(|key|row.try_get::<_,bool>(*key).map_or(true,|v|!v)){return Err("archive SQL identity changed".into());}
                let rows=session.query(constant("ARCHIVE_QUERY").as_str().ok_or("archive SQL not generated")?,&[]).await?;
                if rows.len()!=1{return Err("archive SQL sample missing".into());}
                let row=&rows[0];
                let count=row.try_get::<_,String>("ready_wal_files")?.parse::<u64>()?;
                let archived=row.try_get::<_,String>("archived_count")?.parse::<u64>()?;
                let time=row.try_get::<_,String>("last_archived_time")?.parse::<f64>()?;
                let failed=row.try_get::<_,String>("failed_count")?.parse::<u64>()?;
                if [count,archived,failed].iter().any(|n|*n>9_007_199_254_740_991){return Err("archive SQL count invalid".into());}
                let source=format!("cnpg_collector_pg_wal_archive_status{{value=\"ready\"}} {count}\ncnpg_pg_stat_archiver_archived_count {archived}\ncnpg_pg_stat_archiver_last_archived_time {time}");
                health::metrics(&source,now)
            }.await;
            result.ok()
        } else {
            let result = async {
                let address: IpAddr = text(&pod["status"], "podIP").parse()?;
                if !match address {
                    IpAddr::V4(v) => v.is_private(),
                    IpAddr::V6(v) => v.is_unique_local(),
                } {
                    return Err::<ArchiveSample, Error>(
                        "archive probe target is not private".into(),
                    );
                }
                let target = if address.is_ipv6() {
                    format!("http://[{address}]:9187/metrics")
                } else {
                    format!("http://{address}:9187/metrics")
                };
                let response = self.http.get(target).send().await?;
                if !response.status().is_success() {
                    return Err("archive exporter unavailable".into());
                }
                health::metrics(
                    &String::from_utf8(bounded(response, 1024 * 1024).await?)?,
                    now,
                )
            }
            .await;
            result.ok()
        };
        // What the probe is bound to is read again together after it: the credential it logged in
        // with (a changed one makes the sample none), the Cluster, the Pod and the receipt the
        // health of the archive is recorded in.
        let storage_name = format!("storage-{}", text(db, "id"));
        let (fresh_secret, fresh_cluster, fresh_pod, receipt) = tokio::join!(
            async {
                if sql_eligible {
                    self.k8s
                        .read("Secret", Some(&ns), "maintenance-credentials")
                        .await
                } else {
                    Ok(None)
                }
            },
            self.k8s.read("Cluster", Some(&ns), "database"),
            self.k8s
                .read("Pod", Some(&ns), text(&pod["metadata"], "name")),
            self.k8s.read("ConfigMap", Some(SYSTEM), &storage_name),
        );
        let sample = if sql_eligible {
            let unchanged = matches!((&maintenance, &fresh_secret), (Some(secret), Ok(Some(fresh)))
                if fresh["metadata"]["uid"] == secret["metadata"]["uid"]
                    && fresh["metadata"]["resourceVersion"] == secret["metadata"]["resourceVersion"]);
            sample.filter(|_| unchanged)
        } else {
            sample
        };
        let (fresh_cluster, fresh_pod) = (fresh_cluster?, fresh_pod?);
        let fresh_cluster = fresh_cluster.ok_or("archive Cluster disappeared")?;
        let fresh_pod = fresh_pod.ok_or("archive primary disappeared")?;
        if fresh_cluster["metadata"]["uid"] != cluster["metadata"]["uid"]
            || generation(&fresh_cluster) != number(db, "generation")
            || fresh_cluster["status"]["currentPrimary"] != pod["metadata"]["name"]
            || fresh_pod["metadata"]["uid"] != pod["metadata"]["uid"]
            || fresh_pod["status"]["podIP"] != pod["status"]["podIP"]
            || condition(&fresh_pod, "Ready") != Some("True")
            || !contains(&fresh_cluster["spec"], &cluster["spec"], "")
            || !contains(&cluster["spec"], &fresh_cluster["spec"], "")
            || !fresh_pod["metadata"]["deletionTimestamp"].is_null()
        {
            return Err("archive binding changed during probe".into());
        }
        let (archive, alarm) =
            health::archive_health(&self.k8s, db, &fresh_cluster, sample, receipt?).await?;
        Ok(Probed { archive, alarm })
    }
    /// A runtime switch at the same generation relabels the namespace that runtime admission
    /// matches, then deletes only a primary on the other runtime, so that CNPG recreates it on its
    /// volume under the selected RuntimeClass. A CNPG restart annotation would restart the primary
    /// in place and keep its immutable RuntimeClass. Until the switch completes, the Cluster
    /// records the exact Pod before its deletion, one per generation, runtime and pool release;
    /// an unknown write is read back.
    async fn runtime_selected(
        &self,
        db: &Value,
        context: &Value,
        namespace_uid: &Value,
        cluster: &Value,
    ) -> Result<bool, Error> {
        let ns = namespace(db);
        let pool = &context["computePool"];
        let selection = if pool.is_null() {
            format!("{}/standard", number(db, "generation"))
        } else {
            format!(
                "{}/pool/{}",
                number(db, "generation"),
                text(&pool["profile"], "release_id")
            )
        };
        let primary = text(&cluster["status"], "currentPrimary");
        // The label is checked (and written, if it differs) while the primary is read: the
        // Pod does not depend on the label of its namespace.
        let (labelled, pod) = tokio::join!(self.runtime_label(db, context, namespace_uid), async {
            if dns_label(primary) {
                self.k8s.read_known("Pod", Some(&ns), primary).await
            } else {
                Ok(None)
            }
        });
        // Both were awaited, so that the write of the label is not dropped half sent.
        labelled?;
        let pod = pod?;
        if !dns_label(primary) {
            return Ok(false);
        }
        let Some(pod) = pod else {
            return Ok(false);
        };
        if text(&pod["metadata"], "uid").is_empty()
            || text(&pod["metadata"], "resourceVersion").is_empty()
            || !cluster_owned(&pod, cluster)
            || pod["metadata"]["labels"]["cnpg.io/cluster"] != "database"
            || pod["spec"]["nodeName"] != db["node"]
            || !pod["metadata"]["deletionTimestamp"].is_null()
        {
            return Ok(false);
        }
        let recorded = &cluster["metadata"]["annotations"][SWITCH];
        if text(&pod["spec"], "runtimeClassName") == runtime_class(context) {
            // The switch is complete; without its record a later flip at this generation can
            // switch the primary once more.
            if !recorded.is_null() {
                self.record_switch(db, cluster, Value::Null).await?;
            }
            return Ok(true);
        }
        let marker = format!("{selection}/{}", text(&pod["metadata"], "uid"));
        if recorded != marker.as_str() {
            // A replacement that came up on the other runtime is not deleted again.
            if recorded
                .as_str()
                .is_some_and(|value| value.starts_with(&format!("{selection}/")))
            {
                return Ok(false);
            }
            self.record_switch(db, cluster, marker.into()).await?;
        }
        // The recorded Pod still runs: its UID and resourceVersion bind exactly this deletion.
        if let Err(error) = self.k8s.delete(&pod, "Background").await {
            match self.k8s.read("Pod", Some(&ns), primary).await? {
                Some(after)
                    if after["metadata"]["uid"] == pod["metadata"]["uid"]
                        && after["metadata"]["deletionTimestamp"].is_null() =>
                {
                    return Err(error);
                }
                _ => {}
            }
        }
        Ok(false)
    }
    /// Labels the database namespace with the selected runtime, which admission matches when CNPG
    /// creates a Pod, under its UID and resourceVersion; an unknown write is read back.
    async fn runtime_label(
        &self,
        db: &Value,
        context: &Value,
        namespace_uid: &Value,
    ) -> Result<Value, Error> {
        let ns = namespace(db);
        let mode = if context["computePool"].is_null() {
            "standard"
        } else {
            "pool"
        };
        let current = self
            .k8s
            .read_known("Namespace", None, &ns)
            .await?
            .ok_or("database namespace missing")?;
        owned(&current, db, &ns, None)?;
        if current["metadata"]["uid"] != *namespace_uid {
            return Err("database namespace identity changed".into());
        }
        if text(&current["metadata"]["labels"], RUNTIME) == mode {
            return Ok(current);
        }
        match self
            .k8s
            .patch(&current, &json!({"metadata":{"labels":{RUNTIME:mode}}}))
            .await
        {
            Ok(after) => Ok(after),
            Err(error) => match self.k8s.read("Namespace", None, &ns).await? {
                Some(after)
                    if after["metadata"]["uid"] == *namespace_uid
                        && text(&after["metadata"]["labels"], RUNTIME) == mode =>
                {
                    owned(&after, db, &ns, None)?;
                    Ok(after)
                }
                _ => Err(error),
            },
        }
    }
    /// Writes or clears the runtime switch record under the Cluster's UID and resourceVersion;
    /// an unknown write is read back.
    async fn record_switch(&self, db: &Value, cluster: &Value, value: Value) -> Result<(), Error> {
        let ns = namespace(db);
        if let Err(error) = self
            .k8s
            .patch(cluster, &json!({"metadata":{"annotations":{SWITCH:value}}}))
            .await
        {
            match self.k8s.read("Cluster", Some(&ns), "database").await? {
                Some(after)
                    if after["metadata"]["uid"] == cluster["metadata"]["uid"]
                        && after["metadata"]["annotations"][SWITCH] == value =>
                {
                    owned(&after, db, "database", Some(&ns))?
                }
                _ => return Err(error),
            }
        }
        Ok(())
    }
    pub async fn reconcile(
        &self,
        db: &Value,
        snapshot: &DesiredSnapshot,
    ) -> Result<Option<Value>, Error> {
        let result = self.reconcile_current(db, snapshot).await?;
        let Some(value) = &result else {
            return Ok(result);
        };
        if db["admission"].is_null()
            || text(db, "desired_state") != "running"
            || (text(value, "state") != "provisioning" && text(value, "state") != "ready")
            || (value["runtime_attestation"]["v"] == 2
                && crate::contracts::schema_valid(
                    "DatabaseRuntimeAttestation",
                    &value["runtime_attestation"],
                ))
        {
            return Ok(result);
        }
        // Same-generation provisioning is ignored by legacy observation consumers. Once a
        // persisted target was admitted, emit the existing error invalidator instead of
        // hiding a missing/currently unverifiable primary, CA or watch proof behind startup.
        let name = format!("gateway-fence-{}", text(db, "id"));
        let Some(map) = self.k8s.read("ConfigMap", Some(SYSTEM), &name).await? else {
            return Ok(result);
        };
        owned(&map, db, &name, Some(SYSTEM))?;
        let Some(raw) = map["data"]["admission_target"].as_str() else {
            return Ok(result);
        };
        let target: Value = serde_json::from_str(raw)?;
        if !pgcf_native_protocol::valid_schema("gatewayAdmissionTarget", &target)
            || number(&target, "generation") > number(db, "generation")
        {
            return Err("admitted target history invalid".into());
        }
        if target["generation"] == db["generation"] {
            return Ok(Some(observation(
                db,
                "error",
                Some("Current admitted runtime proof is unavailable"),
            )));
        }
        Ok(result)
    }
    async fn reconcile_current(
        &self,
        db: &Value,
        snapshot: &DesiredSnapshot,
    ) -> Result<Option<Value>, Error> {
        if !database_valid(db) {
            return Err("invalid desired database".into());
        }
        let state_name = text(db, "desired_state");
        let id = text(db, "id");
        // The identity of the cluster is read once by a pass: everything the pass goes on to
        // read, it reads from this cluster.
        self.k8s.assert_cluster(&self.cluster_uid).await?;
        // A database a pool slot serves is the pool's until its slot is retired; a wake of a
        // sleeping one is decided by the pool first (rule 6.2).
        if let Some(serving) = self.pool.serving(id) {
            match state_name {
                "running" => match self.pool.serve_pass(self, db, snapshot, serving).await? {
                    crate::pool::Served::Observed(observed) => return Ok(observed),
                    crate::pool::Served::HandedOver => {}
                },
                "suspended" => return self.pool.sleep(self, db, serving).await,
                _ => {
                    self.pool.unwind_later(id, "deleted");
                    if !self.pool.unwind(self, id, None).await? {
                        return Err("pool slot retirement pending".into());
                    }
                }
            }
        } else if state_name == "running"
            && timing::waking(db)
            && let Some(observed) = self.pool.desired(self, db, snapshot).await?
        {
            return Ok(Some(observed));
        }
        if state_name == "deleted" {
            return self
                .power
                .delete_database(db, &snapshot.region["storage_nodes"])
                .await;
        }
        let ns = namespace(db);
        let fence_name = format!("storage-{id}");
        // What the pass needs to know of the database is read together: the Node and the host
        // authority it stands on, the marker of a deletion, its namespace, its receipt and its
        // Cluster. None depends on another, and they are judged in the order they always were.
        let deletion = format!("delete-{id}");
        let (guarded, retired, ns_read, fence_read, cluster_read) = tokio::join!(
            self.guard(db, snapshot),
            self.k8s.read_known("ConfigMap", Some(SYSTEM), &deletion),
            self.k8s.read_known("Namespace", None, &ns),
            self.k8s.read_known("ConfigMap", Some(SYSTEM), &fence_name),
            self.k8s.read_known("Cluster", Some(&ns), "database"),
        );
        let (authority, node_observed) = guarded?;
        if retired?.is_some() {
            return Err("database deletion is irreversible".into());
        }
        let mut ns_current = ns_read?;
        let mut fence = fence_read?;
        let prior_cluster = cluster_read?;
        for item in [&ns_current, &fence, &prior_cluster].into_iter().flatten() {
            let (name, scope) = if text(item, "kind") == "Namespace" {
                (ns.as_str(), None)
            } else if text(item, "kind") == "Cluster" {
                ("database", Some(ns.as_str()))
            } else {
                (fence_name.as_str(), Some(SYSTEM))
            };
            owned(item, db, name, scope)?;
            let accepted = item["metadata"]["annotations"][ACCEPTED]
                .as_str()
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(0);
            if generation(item).max(accepted) > number(db, "generation") {
                return Ok(None);
            }
        }
        let mut stored = if let Some(fence) = &fence {
            state(fence)?
        } else {
            if !pending_creation(db) || ns_current.is_some() || prior_cluster.is_some() {
                return Ok(Some(observation(
                    db,
                    "error",
                    Some("storage recovery required"),
                )));
            }
            {
                let mut initial = json!({"namespaceUid":null,"clusterUid":null,"node":db["node"],"archivePath":db["archive"]["destination_path"]});
                if !db["storage"].is_null() {
                    initial["storage"] = db["storage"].clone();
                }
                initial
            }
        };
        if stored["node"] != db["node"]
            || stored["archivePath"] != db["archive"]["destination_path"]
            || stored["storage"] != db["storage"]
        {
            return Ok(Some(observation(
                db,
                "error",
                Some("immutable storage identity changed"),
            )));
        }
        for (key, resource) in [
            ("namespaceUid", &ns_current),
            ("clusterUid", &prior_cluster),
        ] {
            if !stored[key].is_null()
                && resource
                    .as_ref()
                    .is_none_or(|v| v["metadata"]["uid"] != stored[key])
            {
                return Ok(Some(observation(
                    db,
                    "error",
                    Some("established storage resource disappeared"),
                )));
            }
        }
        if !db["storage"].is_null()
            && let (Some(namespace_value), Some(cluster), Some(storage)) =
                (&ns_current, &prior_cluster, &fence)
            && let Some(written) = self
                .bind_native_volume(db, &authority, (namespace_value, cluster, storage))
                .await?
        {
            // Later writes use the exact CAS result rather than the read before binding.
            fence = Some(written);
        }
        let finalized = !db["recovery"].is_null()
            && stored["recoveryMappedOperation"] == db["recovery"]["operation_id"];
        if state_name == "suspended" {
            return self.power.suspend(db, None).await;
        }
        if !db["storage"].is_null()
            && authority["write_allowed"] != true
            && starts_postgres(prior_cluster.as_ref(), db, &self.postgres_image)
        {
            return Ok(Some(observation(
                db,
                "provisioning",
                Some("waiting for thin pool room"),
            )));
        }
        let intent = desired_power(db)?;
        let mut context = self.context(db, snapshot, finalized).await?;
        // The Cluster says which roles awaiting removal it already drops; the rest are disabled.
        context["droppingRoles"] = removal::cluster_drops(db, prior_cluster.as_ref());
        let built = manifests::build(db, &context);
        let established =
            db["creation"]["ever_ready"] == true || db["recovery"]["ever_ready"] == true;
        if intent.is_some() {
            // CNPG creates the woken primary as soon as hibernation is released, and admission
            // matches the namespace label at that moment, so the runtime is selected first.
            if let Some(current) = &ns_current {
                ns_current = Some(
                    self.runtime_label(db, &context, &current["metadata"]["uid"])
                        .await?,
                );
            }
            match self.power.prepare_running(db).await? {
                PrepareRunning::Pending => return Ok(Some(observation(db, "provisioning", None))),
                PrepareRunning::Observation(v) => return Ok(Some(v)),
                PrepareRunning::Proceed => {}
            }
        }
        if fence.is_none() && !db["storage"].is_null() {
            stored["storage"] = db["storage"].clone();
        }
        if !db["recovery"].is_null() {
            let r = &db["recovery"];
            let mut values = vec![
                r["operation_id"].clone(),
                r["source_database_id"].clone(),
                r["source_archive_path"].clone(),
                r["source_storage_generation"].clone(),
                r["backup_id"].clone(),
                r["target_time"].clone(),
            ];
            if !r["source_archive"].is_null() {
                values.extend([
                    r["source_archive"]["region_id"].clone(),
                    r["source_archive"]["bucket"].clone(),
                    r["source_archive"]["endpoint_url"].clone(),
                    r["source_archive"]["region"].clone(),
                ]);
            }
            let recovery = serde_json::to_string(&values)?;
            if stored["recoveryIntent"].is_null() {
                if prior_cluster.is_some() {
                    return Err("recovery storage authority missing".into());
                }
                stored["recoveryIntent"] = recovery.into();
            } else if text(&stored, "recoveryIntent") != recovery {
                return Err("recovery source identity changed".into());
            }
        }
        fence = Some(self.save_state(db, &stored, fence.as_ref()).await?);
        let mut manifests = built?;
        let mut desired_ns = manifests.remove(0);
        desired_ns["metadata"]["annotations"] =
            json!({ACCEPTED:number(db,"generation").to_string()});
        let wanted = number(db, "generation").to_string();
        let namespace_value = if let Some(current) = ns_current {
            if current["metadata"]["annotations"][ACCEPTED].as_str() == Some(wanted.as_str()) {
                current
            } else {
                let mut patch = desired_ns.clone();
                patch["metadata"]["annotations"] = json!({ACCEPTED:wanted});
                self.k8s.patch(&current, &patch).await?
            }
        } else {
            self.k8s.create(&desired_ns).await?
        };
        stored["namespaceUid"] = namespace_value["metadata"]["uid"].clone();
        fence = Some(self.save_state(db, &stored, fence.as_ref()).await?);
        let mut applied = vec![];
        let apply_phase = timing::Phase::begin(db, "desired_apply");
        // The objects the pass is about to bring to the desired state are read together before the
        // first of them is written. What binds the Pod the Cluster creates (the quota, the limits,
        // the policies, the archive: everything before the Cluster in the manifests) is written
        // together when all of it exists, and all of it is written before the Cluster is. When
        // something has to be created, the objects are written one after another in the order of
        // the manifests, as the Cluster's Pod may only start under what it is bound by. The Cluster
        // is read when its turn comes: CNPG writes its status continually, and a patch over a
        // version read ahead of the writes before it would conflict.
        let identity = |manifest: &Value| {
            (
                text(manifest, "kind").to_string(),
                manifest["metadata"]["namespace"]
                    .as_str()
                    .map(str::to_string),
                text(&manifest["metadata"], "name").to_string(),
            )
        };
        let cluster_at = manifests
            .iter()
            .position(|manifest| text(manifest, "kind") == "Cluster")
            .unwrap_or(manifests.len());
        let ahead: Vec<usize> = (0..manifests.len())
            .filter(|index| *index != cluster_at)
            .collect();
        let named: Vec<_> = ahead
            .iter()
            .map(|index| identity(&manifests[*index]))
            .collect();
        let refs: Vec<_> = named
            .iter()
            .map(|(kind, namespace, name)| (kind.as_str(), namespace.as_deref(), name.as_str()))
            .collect();
        let mut current: std::collections::HashMap<usize, Option<Value>> = ahead
            .into_iter()
            .zip(self.k8s.read_all_known(&refs).await?)
            .collect();
        let binding: Vec<Option<Value>> = (0..cluster_at)
            .map(|index| current.remove(&index).flatten())
            .collect();
        if binding.len() > 1 && binding.iter().all(Option::is_some) {
            // All of them are awaited, so that no write is dropped half sent when one fails; the
            // first failure in the order of the manifests is the one reported.
            let written = futures_util::future::join_all(
                manifests[..cluster_at]
                    .iter()
                    .zip(binding)
                    .map(|(manifest, read)| self.apply_to(db, manifest, read)),
            )
            .await;
            for actual in written {
                applied.push(actual?);
            }
        } else {
            for (manifest, read) in manifests[..cluster_at].iter().zip(binding) {
                applied.push(self.apply_to(db, manifest, read).await?);
            }
        }
        for (index, manifest) in manifests.iter().enumerate().skip(cluster_at) {
            let read = match current.remove(&index) {
                Some(read) => read,
                None => {
                    let (kind, namespace, name) = identity(manifest);
                    self.k8s
                        .read_known(&kind, namespace.as_deref(), &name)
                        .await?
                }
            };
            let actual = self.apply_to(db, manifest, read).await?;
            if text(manifest, "kind") == "Cluster" {
                if !stored["clusterUid"].is_null()
                    && actual["metadata"]["uid"] != stored["clusterUid"]
                {
                    return Err("Cluster UID changed".into());
                }
                stored["clusterUid"] = actual["metadata"]["uid"].clone();
            }
            applied.push(actual);
        }
        fence = Some(self.save_state(db, &stored, fence.as_ref()).await?);
        apply_phase.completed();
        let Some(cluster) = self
            .k8s
            .read_known("Cluster", Some(&ns), "database")
            .await?
        else {
            return Ok(Some(observation(db, "provisioning", None)));
        };
        owned(&cluster, db, "database", Some(&ns))?;
        if cluster["metadata"]["uid"] != stored["clusterUid"] {
            return Err("Cluster identity changed after apply".into());
        }
        if !self
            .runtime_selected(db, &context, &stored["namespaceUid"], &cluster)
            .await?
        {
            return Ok(Some(observation(db, "provisioning", None)));
        }
        let ca_phase = timing::Phase::begin(db, "ca_publication");
        let Some((ca, ca_secret)) = self.ca(db, &cluster).await? else {
            ca_phase.pending();
            return Ok(Some(observation(db, "provisioning", None)));
        };
        ca_phase.completed();
        if !db["recovery"].is_null() && !finalized {
            let primary = text(&cluster["status"], "currentPrimary");
            if primary.is_empty() {
                return Ok(Some(observation(db, "provisioning", None)));
            }
            let Some(pod) = self.k8s.read("Pod", Some(&ns), primary).await? else {
                return Ok(Some(observation(db, "provisioning", None)));
            };
            if !cluster_owned(&pod, &cluster)
                || self
                    .bind_volume(db, &cluster, &pod, &authority, &stored)
                    .await?
                    .is_none()
            {
                return Ok(Some(observation(db, "provisioning", None)));
            }
            if condition(&cluster, "Ready") != Some("True")
                || !self.map_recovery(db, &context, &ca, false).await?
            {
                return Ok(Some(observation(db, "provisioning", None)));
            }
            stored["recoveryMappedOperation"] = db["recovery"]["operation_id"].clone();
            self.save_state(db, &stored, fence.as_ref()).await?;
            return Ok(Some(observation(db, "provisioning", None)));
        }
        if finalized {
            if cluster["spec"]["enableSuperuserAccess"] != false
                || !cluster["spec"]["superuserSecret"].is_null()
                || !self.map_recovery(db, &context, &ca, true).await?
            {
                return Ok(Some(observation(db, "provisioning", None)));
            }
            if let Some(secret) = self
                .k8s
                .read("Secret", Some(&ns), "restore-superuser")
                .await?
            {
                owned(&secret, db, "restore-superuser", Some(&ns))?;
                self.k8s.delete(&secret, "Background").await?;
                return Ok(Some(observation(db, "provisioning", None)));
            }
        }
        if condition(&cluster, "Ready") != Some("True") {
            return Ok(Some(observation(db, "provisioning", None)));
        }
        let primary = text(&cluster["status"], "currentPrimary");
        if primary.is_empty() {
            return Ok(Some(observation(db, "provisioning", None)));
        }
        let Some(pod) = self.k8s.read_known("Pod", Some(&ns), primary).await? else {
            return Ok(Some(observation(db, "provisioning", None)));
        };
        if !primary_current(&pod, &cluster, db, &context) {
            return Ok(Some(observation(db, "provisioning", None)));
        }
        let expected_image = db["postgres"]["image"]
            .as_str()
            .unwrap_or(&self.postgres_image);
        let postgres_container = pod["spec"]["containers"]
            .as_array()
            .and_then(|v| v.iter().find(|c| text(c, "name") == "postgres"))
            .ok_or("postgres container missing")?;
        let status = pod["status"]["containerStatuses"]
            .as_array()
            .and_then(|v| v.iter().find(|c| text(c, "name") == "postgres"))
            .ok_or("postgres runtime proof missing")?;
        let image_id = text(status, "imageID");
        if postgres_container["image"] != expected_image
            || status["ready"] != true
            || status["state"]["running"].is_null()
            || !image_id.ends_with(
                expected_image
                    .rsplit('@')
                    .next()
                    .ok_or("image digest missing")?,
            )
        {
            return Ok(Some(observation(db, "provisioning", None)));
        }
        let desired_cluster = manifests
            .iter()
            .find(|m| text(m, "kind") == "Cluster")
            .ok_or("desired Cluster missing")?;
        if !contains(&cluster["spec"], &desired_cluster["spec"], "")
            || !contains(
                &postgres_container["resources"],
                &desired_cluster["spec"]["resources"],
                "resources",
            )
        {
            return Ok(Some(observation(db, "provisioning", None)));
        }
        let volume_phase = timing::Phase::begin(db, "volume_identity");
        let Some(volume_identity) = self
            .bind_volume(db, &cluster, &pod, &authority, &stored)
            .await?
        else {
            volume_phase.pending();
            return Ok(Some(observation(db, "provisioning", None)));
        };
        volume_phase.completed();
        if applied.iter().any(|resource| {
            text(resource, "kind") == "Secret" && !credential_acknowledged(db, &cluster, resource)
        }) {
            return Ok(Some(observation(db, "provisioning", None)));
        }
        let proof_continuity = self.k8s.runtime_continuity();
        let roles = timing::Phase::begin(db, "role_runtime_auth");
        if !postgres::roles(db, &ca, text(&pod["status"], "podIP"), self.power.postgres).await? {
            roles.pending();
            return Ok(Some(observation(db, "provisioning", None)));
        }
        roles.completed();
        let unchanged = timing::Phase::begin(db, "runtime_unchanged");
        // Every applied object and the TLS authority are read together, and judged in order.
        let mut asked: Vec<_> = applied
            .iter()
            .map(|actual| {
                (
                    text(actual, "kind"),
                    actual["metadata"]["namespace"].as_str(),
                    text(&actual["metadata"], "name"),
                )
            })
            .collect();
        asked.push((
            "Secret",
            Some(ns.as_str()),
            text(&ca_secret["metadata"], "name"),
        ));
        let mut fresh_all = self.k8s.read_all_known(&asked).await?;
        let current_ca = fresh_all.pop().flatten();
        for (actual, fresh) in applied.iter().zip(fresh_all) {
            let Some(fresh) = fresh else {
                unchanged.pending();
                return Ok(Some(observation(db, "provisioning", None)));
            };
            if fresh["metadata"]["uid"] != actual["metadata"]["uid"]
                || if text(actual, "kind") == "Secret" {
                    fresh["metadata"]["resourceVersion"] != actual["metadata"]["resourceVersion"]
                } else {
                    !contains(&fresh["spec"], &actual["spec"], "")
                }
            {
                unchanged.pending();
                return Ok(Some(observation(db, "provisioning", None)));
            }
        }
        let current_ca = current_ca.ok_or("TLS authority disappeared")?;
        if current_ca["metadata"]["uid"] != ca_secret["metadata"]["uid"]
            || current_ca["metadata"]["resourceVersion"] != ca_secret["metadata"]["resourceVersion"]
            || !cluster_owned(&current_ca, &cluster)
        {
            unchanged.pending();
            return Ok(Some(observation(db, "provisioning", None)));
        }
        unchanged.completed();
        let metrics = timing::Phase::begin(db, "archive_metrics");
        let Probed {
            archive,
            alarm: archive_alarm,
        } = self.archive(db, &cluster, &pod, &ca).await?;
        metrics.completed();
        postgres_status(&pod).ok_or("postgres runtime proof missing")?;
        let is_ready = archive["continuous"] == true || established;
        let mut result = observation(
            db,
            if is_ready {
                "ready"
            } else if archive_alarm {
                "error"
            } else {
                "provisioning"
            },
            if archive_alarm {
                Some("continuous WAL archive health failed or remained unknown for ten minutes")
            } else {
                None
            },
        );
        result["backup"] = self.health.backup(db, &namespace_value, &cluster);
        result["archive"] = archive;
        result["postgres"] = json!({"image":expected_image,"image_id":image_id});
        if finalized {
            result["recovery"] = json!({"operation_id":db["recovery"]["operation_id"],"storage_generation":optional_number(db,"storage_generation",1),"verified":true});
        }
        let mut final_ns = self
            .k8s
            .read_known("Namespace", None, &ns)
            .await?
            .ok_or("Namespace disappeared before readiness")?;
        if final_ns["metadata"]["uid"] != namespace_value["metadata"]["uid"]
            || final_ns["metadata"]["annotations"][ACCEPTED].as_str()
                != Some(number(db, "generation").to_string().as_str())
        {
            return Err("Namespace generation changed before readiness".into());
        }
        // The completed generation is this controller's own write to the namespace the runtime
        // proof names at its version, so it is written before the proof and seen by the watch the
        // proof is read back against: written after, it would change the namespace under the
        // proof of the first pass of every generation.
        if generation(&final_ns) != number(db, "generation") {
            final_ns = self.k8s.patch(&final_ns,&json!({"metadata":{"annotations":{GENERATION:number(db,"generation").to_string(),ACCEPTED:number(db,"generation").to_string()}}})).await?;
            if proof_continuity.is_some() && !db["admission"].is_null() {
                self.k8s.observed(&final_ns, WATCH_LAG).await;
            }
        }
        if is_ready
            && let Some(proof) = self
                .attestation(
                    db,
                    &Attesting {
                        resources: RuntimeResources {
                            namespace: &final_ns,
                            cluster: &cluster,
                            pod: &pod,
                            ca: &current_ca,
                            node: &node_observed,
                        },
                        container: postgres_container,
                        ca: &ca,
                        storage: fence.as_ref().ok_or("runtime storage receipt absent")?,
                        volume: &volume_identity,
                        tls_server_name: format!("database-rw.{ns}.svc"),
                        continuity: proof_continuity,
                    },
                )
                .await?
        {
            result["runtime_attestation"] = proof;
        }
        let release = timing::Phase::begin(db, "fence_release");
        let mut result = if let Some(intent) = intent {
            let intent = serde_json::to_value(intent)?;
            self.power
                .finish_running(db, result, Some(&intent), false)
                .await?
        } else {
            self.power.publish_ready_fence(db, result, false).await?
        };
        if result.as_ref().is_some_and(|v| v["state"] == "ready") {
            release.completed();
        } else {
            release.pending();
        }
        // The roles awaiting removal advance after the database is ready, never before: readiness
        // waits for the present roles only. The Cluster is not written until the attestation above
        // was formed and published, which pins the Cluster's version.
        if let Some(value) = result.as_mut().filter(|value| value["state"] == "ready")
            && let Some(roles) = self
                .advance_removals(db, &context, &ca, self.power.postgres)
                .await
        {
            value["roles"] = roles;
        }
        Ok(result)
    }
    /// The runtime attestation of a ready database's PostgreSQL: v1 for a database Cloudflare has
    /// not admitted, v2 with the watch's read-back for one it has; `None` when the watch cannot
    /// vouch for the resources it names.
    async fn attestation(&self, db: &Value, a: &Attesting<'_>) -> Result<Option<Value>, Error> {
        let RuntimeResources {
            namespace,
            cluster,
            pod,
            ca: ca_secret,
            node,
        } = &a.resources;
        let status = postgres_status(pod).ok_or("postgres runtime proof missing")?;
        let expected_image = db["postgres"]["image"]
            .as_str()
            .unwrap_or(&self.postgres_image);
        let cid = text(status, "containerID")
            .strip_prefix("containerd://")
            .unwrap_or("");
        let boot = text(&node["status"]["nodeInfo"], "bootID");
        let mut proof = json!({"v":1,"database_id":db["id"],"generation":db["generation"],"storage_generation":optional_number(db,"storage_generation",1),"node_uid":node["metadata"]["uid"],"boot_id":boot,"cluster_uid":self.cluster_uid,"namespace_uid":namespace["metadata"]["uid"],"cnpg_cluster_uid":cluster["metadata"]["uid"],"storage_uid":a.storage["metadata"]["uid"],"pvc_uid":a.volume["claimUid"],"pv_uid":a.volume["volumeUid"],"pod_uid":pod["metadata"]["uid"],"container_id":cid,"postgres_image_sha256":expected_image.rsplit("@sha256:").next().ok_or("runtime image digest absent")?,"memory_request_bytes":quantity(&a.container["resources"]["requests"]["memory"]),"memory_limit_bytes":quantity(&a.container["resources"]["limits"]["memory"]),"observed_at":u64::try_from(now()).map_err(|_|"runtime clock invalid")?,"configuration_fingerprint":crate::contracts::configuration_fingerprint(db,&self.postgres_image)?});
        if !db["admission"].is_null() {
            if let Some(start) = &a.continuity {
                if let Some(mut continuity) = self
                    .runtime_readback(db, start, &a.resources, a.volume)
                    .await?
                {
                    proof["v"] = 2.into();
                    proof["region_id"] = self.power.region().into();
                    proof["route_revision"] = db["admission"]["route_revision"].clone();
                    proof["admission_epoch"] = db["admission"]["admission_epoch"].clone();
                    proof["applied_role_revisions"] = applied_role_revisions(db)
                        .ok_or("runtime role set missing")?
                        .into();
                    proof["tls_server_name"] = a.tls_server_name.as_str().into();
                    proof["ca_secret_uid"] = ca_secret["metadata"]["uid"].clone();
                    proof["ca_secret_resource_version"] =
                        ca_secret["metadata"]["resourceVersion"].clone();
                    proof["ca_sha256"] = Sha256::digest(a.ca)
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect::<String>()
                        .into();
                    proof["pod_ip"] = pod["status"]["podIP"].clone();
                    proof["postgres_port"] = 5432.into();
                    let verified = proof["observed_at"]
                        .as_u64()
                        .ok_or("runtime clock missing")?;
                    continuity["verified_at"] = verified.into();
                    continuity["expires_at"] = (verified
                        + constant("DATABASE_RUNTIME_PROOF_MAX_AGE_MS")
                            .as_u64()
                            .ok_or("runtime proof lifetime missing")?)
                    .into();
                    proof["observation"] = continuity;
                } else {
                    proof = Value::Null;
                }
            } else {
                proof = Value::Null;
            }
        }
        Ok(crate::contracts::schema_valid("DatabaseRuntimeAttestation", &proof).then_some(proof))
    }
    /// The ready observation of a database a pool slot serves, with the attestation of the slot's
    /// Pod (under the slot's own service name) for the gateway to route by.
    pub(crate) async fn slot_observation(
        &self,
        db: &Value,
        ns: &str,
        serving: &crate::pool::Serving,
    ) -> Result<Value, Error> {
        let id = text(db, "id");
        let continuity = self.k8s.runtime_continuity();
        let storage_name = format!("storage-{id}");
        let (namespace_value, cluster, pod, ca_secret, node, storage) = tokio::try_join!(
            self.k8s.read_known("Namespace", None, ns),
            self.k8s.read_known("Cluster", Some(ns), "database"),
            self.k8s.read_known("Pod", Some(ns), "database-1"),
            self.k8s.read_known("Secret", Some(ns), "database-ca"),
            self.k8s.read_known("Node", None, text(db, "node")),
            self.k8s
                .read_known("ConfigMap", Some(SYSTEM), &storage_name),
        )?;
        let (
            Some(namespace_value),
            Some(cluster),
            Some(pod),
            Some(ca_secret),
            Some(node),
            Some(storage),
        ) = (namespace_value, cluster, pod, ca_secret, node, storage)
        else {
            return Err("pool slot runtime missing".into());
        };
        if pod["metadata"]["uid"] != serving.pod.uid.as_str() {
            return Err("pool slot Pod replaced".into());
        }
        // The claim wrote the Cluster and resized the Pod a moment ago: the proof is read back
        // against a watch that has delivered them.
        if continuity.is_some() {
            tokio::join!(
                self.k8s.observed(&cluster, WATCH_LAG),
                self.k8s.observed(&pod, WATCH_LAG)
            );
        }
        let ca = ca_bytes(&ca_secret, &cluster)?;
        let volume: Value =
            serde_json::from_str(text(&storage["metadata"]["annotations"], VOLUME))?;
        let container = pod["spec"]["containers"]
            .as_array()
            .and_then(|v| v.iter().find(|c| text(c, "name") == "postgres"))
            .ok_or("postgres container missing")?
            .clone();
        let status = postgres_status(&pod).ok_or("postgres runtime proof missing")?;
        let expected_image = db["postgres"]["image"]
            .as_str()
            .unwrap_or(&self.postgres_image);
        let mut result = observation(db, "ready", None);
        result["postgres"] = json!({"image":expected_image,"image_id":text(status,"imageID")});
        result["backup"] = self.health.backup(db, &namespace_value, &cluster);
        if let Some(proof) = self
            .attestation(
                db,
                &Attesting {
                    resources: RuntimeResources {
                        namespace: &namespace_value,
                        cluster: &cluster,
                        pod: &pod,
                        ca: &ca_secret,
                        node: &node,
                    },
                    container: &container,
                    ca: &ca,
                    storage: &storage,
                    volume: &volume,
                    tls_server_name: pgcf_native_protocol::wake::slot_tls_name(ns),
                    continuity,
                },
            )
            .await?
        {
            result["runtime_attestation"] = proof;
        }
        Ok(result)
    }
    /// The object `resource` names, read again: from etcd for the Pod and the Cluster, whose
    /// status changes while a proof is formed, and as the watch proves it for the objects that
    /// only change when someone writes them.
    async fn reread(&self, resource: &Value) -> Result<Option<Value>, Error> {
        let (kind, namespace, name) = (
            text(resource, "kind"),
            resource["metadata"]["namespace"].as_str(),
            text(&resource["metadata"], "name"),
        );
        if matches!(kind, "Pod" | "Cluster") {
            self.k8s.read(kind, namespace, name).await
        } else {
            self.k8s.read_known(kind, namespace, name).await
        }
    }
    /// The proof read back: the resources it was built from are the ones the controller holds now,
    /// at the versions its watch holds.
    async fn runtime_readback(
        &self,
        db: &Value,
        start: &(String, u64),
        resources: &RuntimeResources<'_>,
        volume: &Value,
    ) -> Result<Option<Value>, Error> {
        let (namespace, cluster, pod, ca, node) = (
            resources.namespace,
            resources.cluster,
            resources.pod,
            resources.ca,
            resources.node,
        );
        let ns = crate::contracts::namespace(db);
        let claim_name = text(&pod["metadata"], "name");
        let storage_name = format!("storage-{}", text(db, "id"));
        // The claim and the receipt are read, and the resources the proof was built from are read
        // again, together; then the volume the claim names, with the claim and the receipt read
        // once more; then that volume again. Each is read again after it was first read.
        let (claim, storage, namespace_now, cluster_now, pod_now, ca_now, node_now) = tokio::try_join!(
            self.k8s
                .read_known("PersistentVolumeClaim", Some(&ns), claim_name),
            self.k8s
                .read_known("ConfigMap", Some(SYSTEM), &storage_name),
            self.reread(namespace),
            self.reread(cluster),
            self.reread(pod),
            self.reread(ca),
            self.reread(node),
        )?;
        let claim = claim.ok_or("runtime PVC missing")?;
        let storage = storage.ok_or("runtime storage receipt missing")?;
        let volume_name = text(&claim["spec"], "volumeName");
        let (pv, claim_now, storage_now) = tokio::try_join!(
            self.k8s.read_known("PersistentVolume", None, volume_name),
            self.reread(&claim),
            self.reread(&storage),
        )?;
        let pv = pv.ok_or("runtime PV missing")?;
        if claim["metadata"]["uid"] != volume["claimUid"]
            || pv["metadata"]["uid"] != volume["volumeUid"]
        {
            return Ok(None);
        }
        let pv_now = self.reread(&pv).await?;
        let mut versions = json!({});
        let resources = [
            ("namespace", namespace, namespace_now),
            ("cluster", cluster, cluster_now),
            ("pod", pod, pod_now),
            ("ca_secret", ca, ca_now),
            ("node", node, node_now),
            ("pvc", &claim, claim_now),
            ("pv", &pv, pv_now),
            ("storage", &storage, storage_now),
        ];
        for (key, resource, fresh) in &resources {
            let Some(fresh) = fresh else {
                return Ok(None);
            };
            if fresh["metadata"]["uid"] != resource["metadata"]["uid"]
                || fresh["metadata"]["resourceVersion"] != resource["metadata"]["resourceVersion"]
                || !fresh["metadata"]["deletionTimestamp"].is_null()
                || !self.k8s.runtime_resource_current(fresh)
            {
                return Ok(None);
            }
            versions[key] = fresh["metadata"]["resourceVersion"].clone();
        }
        if self.k8s.runtime_continuity().as_ref() != Some(start)
            || resources
                .iter()
                .any(|(_, resource, _)| !self.k8s.runtime_resource_current(resource))
        {
            return Ok(None);
        }
        Ok(Some(
            json!({"v":1,"controller_epoch":start.0,"watch_epoch":start.1,"coverage":"complete","resource_versions":versions}),
        ))
    }
    pub fn new(
        k8s: Kubernetes,
        cluster_uid: String,
        postgres_image: String,
        region: String,
        replicas: usize,
    ) -> Result<Self, Error> {
        if cluster_uid.is_empty() || !postgres_image.contains("@sha256:") {
            return Err("sealed runtime identity required".into());
        }
        let _ = rustls::crypto::ring::default_provider().install_default();
        let mut power = PowerCoordinator::new(k8s.clone(), region, replicas)?;
        power.postgres_image = postgres_image.clone();
        let http = crate::cluster_http(Duration::from_secs(5))?;
        Ok(Self {
            pool: crate::pool::Pool::new(k8s.clone(), postgres_image.clone())?,
            k8s,
            power,
            health: Health::default(),
            cluster_uid,
            postgres_image,
            http,
        })
    }
    /// Whether the database's node has thin pool room for a start (Cloudflare's reserve rule):
    /// its storage row in the snapshot stands for `node`, as the watch holds it, and its
    /// `write_allowed` says so.
    pub(crate) fn room(&self, db: &Value, snapshot: &DesiredSnapshot, node: &Value) -> bool {
        snapshot.region["storage_nodes"]
            .as_array()
            .and_then(|nodes| nodes.iter().find(|n| n["name"] == db["node"]))
            .is_some_and(|row| storage_guard(db, node, row).is_ok() && row["write_allowed"] == true)
    }
    /// The Node and the host authority the database stands on. The pass has asserted the identity
    /// of the cluster before it asks.
    async fn guard(&self, db: &Value, snapshot: &DesiredSnapshot) -> Result<(Value, Value), Error> {
        let assigned = snapshot.fleet_release["nodes"]
            .as_array()
            .and_then(|nodes| {
                nodes
                    .iter()
                    .find(|node| text(node, "k8s_node_name") == text(db, "node"))
            })
            .ok_or("database node has no immutable fleet assignment")?;
        let node = self
            .k8s
            .read_known("Node", None, text(db, "node"))
            .await?
            .ok_or("database node disappeared")?;
        if text(assigned, "role") != "customer"
            || node["metadata"]["uid"] != assigned["node_uid"]
            || !node["metadata"]["deletionTimestamp"].is_null()
        {
            return Err("database physical Node UID changed".into());
        }
        if db["storage"].is_null() {
            return Ok((Value::Null, node));
        }
        let authority = snapshot.region["storage_nodes"]
            .as_array()
            .and_then(|nodes| {
                nodes
                    .iter()
                    .find(|node| text(node, "name") == text(db, "node"))
            })
            .ok_or("thin node storage missing")?;
        storage_guard(db, &node, authority)?;
        Ok((authority.clone(), node))
    }
    /// The receipt of the database's storage, with the state it records. A receipt that records
    /// the state already is left as it is when its generation is the desired one.
    async fn save_state(
        &self,
        db: &Value,
        stored: &Value,
        previous: Option<&Value>,
    ) -> Result<Value, Error> {
        let name = format!("storage-{}", text(db, "id"));
        let encoded = serde_json::to_string(stored)?;
        if let Some(previous) = previous {
            owned(previous, db, &name, Some(SYSTEM))?;
            if generation(previous) > number(db, "generation") {
                return Err("storage revision advanced".into());
            }
            if generation(previous) == number(db, "generation") && state(previous)? == *stored {
                return Ok(previous.clone());
            }
            self.k8s.patch(previous,&json!({"metadata":{"annotations":{GENERATION:number(db,"generation").to_string()}},"data":{"state":encoded}})).await
        } else {
            self.k8s.create(&json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":name,"namespace":SYSTEM,"labels":{LABEL:db["id"]},"annotations":{GENERATION:number(db,"generation").to_string()}},"data":{"state":encoded}})).await
        }
    }
    async fn apply(&self, db: &Value, manifest: &Value) -> Result<Value, Error> {
        let kind = text(manifest, "kind");
        let ns = manifest["metadata"]["namespace"].as_str();
        let name = text(&manifest["metadata"], "name");
        let current = self.k8s.read(kind, ns, name).await?;
        self.apply_to(db, manifest, current).await
    }
    /// Brings the object `manifest` names, as it was read, to the manifest. An object that has
    /// the manifest's content, labels and annotations is left as it is when it carries this
    /// generation.
    async fn apply_to(
        &self,
        db: &Value,
        manifest: &Value,
        current: Option<Value>,
    ) -> Result<Value, Error> {
        let kind = text(manifest, "kind");
        let ns = manifest["metadata"]["namespace"].as_str();
        let name = text(&manifest["metadata"], "name");
        // The manifest's own annotations (the CA publication names its source Secret in them)
        // are written with the generation stamp, never in place of it.
        let stated = &manifest["metadata"]["annotations"];
        let mut annotations = stated.clone();
        annotations[GENERATION] = number(db, "generation").to_string().into();
        if let Some(current) = &current {
            owned(current, db, name, ns)?;
            if generation(current) > number(db, "generation") {
                return Err("resource generation advanced".into());
            }
            let content = if kind == "Secret" || kind == "ConfigMap" {
                "data"
            } else {
                "spec"
            };
            if (kind == "Secret" || generation(current) == number(db, "generation"))
                && contains(&current[content], &manifest[content], "")
                && contains(
                    &current["metadata"]["labels"],
                    &manifest["metadata"]["labels"],
                    "",
                )
                && (stated.is_null() || contains(&current["metadata"]["annotations"], stated, ""))
            {
                return Ok(current.clone());
            }
            let mut patch = manifest.clone();
            patch["metadata"]["annotations"] = annotations;
            if kind == "Cluster"
                && manifest["spec"]["enableSuperuserAccess"] == false
                && !current["spec"]["superuserSecret"].is_null()
            {
                patch["spec"]["superuserSecret"] = Value::Null;
            }
            self.k8s.patch(current, &patch).await
        } else {
            let mut manifest = manifest.clone();
            manifest["metadata"]["annotations"] = annotations;
            self.k8s.create(&manifest).await
        }
    }
    /// The context a pool slot is rendered in: the region's backup, the cluster's selectors and
    /// the standard runtime.
    pub(crate) async fn slot_context(&self, snapshot: &DesiredSnapshot) -> Result<Value, Error> {
        let mut context = self.base_context(snapshot).await?;
        context["recoveryFinalized"] = false.into();
        context["computePool"] = Value::Null;
        Ok(context)
    }
    pub(crate) async fn context(
        &self,
        db: &Value,
        snapshot: &DesiredSnapshot,
        finalized: bool,
    ) -> Result<Value, Error> {
        let (mut context, pool) = tokio::try_join!(
            self.base_context(snapshot),
            self.admitted_pool(db, &snapshot.region["compute_pool"])
        )?;
        context["recoveryFinalized"] = finalized.into();
        context["computePool"] = pool;
        if !db["recovery"]["source_archive"].is_null() {
            let source = snapshot.region["recovery_sources"]
                [text(&db["recovery"]["source_archive"], "region_id")]
            .clone();
            if source["bucket"] != db["recovery"]["source_archive"]["bucket"]
                || source["endpoint_url"] != db["recovery"]["source_archive"]["endpoint_url"]
            {
                return Err("recovery source read custody changed".into());
            }
            context["recoverySource"] = json!({"bucket":source["bucket"],"endpointUrl":source["endpoint_url"],"region":"auto","credentials":{"accessKeyId":source["access_key_id"],"secretAccessKey":source["secret_access_key"]}});
        }
        Ok(context)
    }
    async fn base_context(&self, snapshot: &DesiredSnapshot) -> Result<Value, Error> {
        // The shared backup credential is written by no pass of the controller.
        let secret = self
            .k8s
            .read_known_cached("Secret", Some(SYSTEM), "pgcf-backup-s3")
            .await?
            .ok_or("regional backup credentials missing")?;
        let decode = |name: &str| -> Result<String, Error> {
            let encoded = text(&secret["data"], name);
            if encoded.len() > 4096 {
                return Err("backup credential exceeds bound".into());
            }
            let bytes = STANDARD.decode(encoded)?;
            if STANDARD.encode(&bytes) != encoded {
                return Err("backup credential not canonical".into());
            }
            let value = String::from_utf8(bytes)?;
            if value.is_empty() || value.contains(['\r', '\n', '\0']) {
                return Err("backup credential invalid".into());
            }
            Ok(value)
        };
        Ok(
            json!({"backup":{"bucket":snapshot.region["backup"]["bucket"],"endpointUrl":snapshot.region["backup"]["endpoint_url"],"region":"auto","credentials":{"accessKeyId":decode("AWS_ACCESS_KEY_ID")?,"secretAccessKey":decode("AWS_SECRET_ACCESS_KEY")?}},"postgresImage":self.postgres_image,"systemNamespace":SYSTEM,"cnpgNamespace":"cnpg-system","storageClass":"pgcf-lvm","gatewaySelector":{"namespace":SYSTEM,"podLabels":{"app.kubernetes.io/name":"pgcf-gateway"}},"agentSelector":{"namespace":SYSTEM,"podLabels":{"app.kubernetes.io/name":"pgcf-agent"}}}),
        )
    }
    /// The region pool applies to a database only once node-bootstrap has admitted a compute
    /// profile on this cluster: RuntimeClass, MutatingAdmissionPolicy and its binding stamped with
    /// one profile hash, and the database node labelled for it. node-bootstrap stamps the node
    /// policy profile of the release it applies, which rollouts advance without the region
    /// template, so the template only switches the pool on. Until admission, the Pod keeps the
    /// standard runtime, so a region switch that precedes it can never strand a recreated primary
    /// without its RuntimeClass.
    async fn admitted_pool(&self, db: &Value, pool: &Value) -> Result<Value, Error> {
        if pool.is_null() {
            return Ok(Value::Null);
        }
        let (class, policy, binding, node) = tokio::try_join!(
            self.k8s.read_cached("RuntimeClass", None, PRESTARTED),
            self.k8s
                .read_cached("MutatingAdmissionPolicy", None, ADMISSION),
            self.k8s
                .read_cached("MutatingAdmissionPolicyBinding", None, ADMISSION),
            self.k8s.read_known_cached("Node", None, text(db, "node"))
        )?;
        let profile = class.as_ref().map_or("", |class| {
            text(
                &class["metadata"]["annotations"],
                "pgcf.io/compute-profile-sha256",
            )
        });
        if profile.len() != 64
            || !profile
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Ok(Value::Null);
        }
        let selector = format!("r-{}", &profile[..40]);
        let current = |object: &Option<Value>| {
            object.as_ref().is_some_and(|value| {
                let metadata = &value["metadata"];
                metadata["deletionTimestamp"].is_null()
                    && metadata["labels"]["pgcf.io/managed-by"] == "node-bootstrap"
                    && metadata["annotations"]["pgcf.io/runtime-admission"] == "1"
                    && metadata["annotations"]["pgcf.io/compute-profile-sha256"] == profile
            })
        };
        let admitted = current(&class)
            && current(&policy)
            && current(&binding)
            && class.as_ref().is_some_and(|class| {
                class["handler"] == "pgcf"
                    && class["scheduling"]["nodeSelector"][PROFILE] == selector.as_str()
            })
            && binding
                .as_ref()
                .is_some_and(|binding| binding["spec"]["policyName"] == ADMISSION)
            && node.as_ref().is_some_and(|node| {
                node["metadata"]["deletionTimestamp"].is_null()
                    && node["metadata"]["labels"][PROFILE] == selector.as_str()
            });
        Ok(if admitted { pool.clone() } else { Value::Null })
    }
    async fn ca(&self, db: &Value, cluster: &Value) -> Result<Option<(Vec<u8>, Value)>, Error> {
        let name = text(&cluster["status"]["certificates"], "serverCASecret");
        if name.is_empty() {
            return Ok(None);
        }
        let ns = namespace(db);
        // The authority is read while the ConfigMap it is published in is.
        let published_name = format!("ca-{}", text(db, "id"));
        let (secret, published) = tokio::try_join!(
            self.k8s.read_known("Secret", Some(&ns), name),
            self.k8s
                .read_known("ConfigMap", Some(SYSTEM), &published_name)
        )?;
        let secret = secret.ok_or("CNPG CA secret disappeared")?;
        let ca = ca_bytes(&secret, cluster)?;
        let mut manifest = json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":format!("ca-{}",text(db,"id")),"namespace":SYSTEM,"labels":{LABEL:db["id"]}},"data":{"ca.crt":String::from_utf8(ca.clone())?}});
        if !db["admission"].is_null() {
            manifest["metadata"]["annotations"] = json!({"pgcf.io/source-ca-secret-uid":secret["metadata"]["uid"],"pgcf.io/source-ca-secret-resource-version":secret["metadata"]["resourceVersion"]});
        }
        self.apply_to(db, &manifest, published).await?;
        Ok(Some((ca, secret)))
    }
    async fn map_recovery(
        &self,
        db: &Value,
        context: &Value,
        ca: &[u8],
        verify_disabled: bool,
    ) -> Result<bool, Error> {
        let mut hmac = Hmac::<Sha256>::new_from_slice(
            text(&context["backup"]["credentials"], "secretAccessKey").as_bytes(),
        )?;
        hmac.update(
            format!(
                "pgcf-restore|{}|{}",
                text(db, "id"),
                text(&db["recovery"], "operation_id")
            )
            .as_bytes(),
        );
        let password = URL_SAFE_NO_PAD.encode(hmac.finalize().into_bytes());
        let session = match postgres::connect(db, ca, "postgres", &password, "postgres").await {
            Ok(session) => session,
            Err(error) => {
                return Ok(verify_disabled&&error.downcast_ref::<tokio_postgres::Error>().and_then(|e|e.code()).is_some_and(|c|c==&tokio_postgres::error::SqlState::INVALID_PASSWORD||c==&tokio_postgres::error::SqlState::INVALID_AUTHORIZATION_SPECIFICATION));
            }
        };
        if verify_disabled {
            return Ok(false);
        }
        let recovering = session.query("SELECT pg_is_in_recovery()", &[]).await?;
        if recovering.len() != 1 || recovering[0].try_get::<_, bool>(0)? {
            return Ok(false);
        }
        session.query("BEGIN", &[]).await?;
        let names = vec![
            text(&db["recovery"], "source_database_id").to_string(),
            text(db, "id").to_string(),
        ];
        let query = "SELECT oid::text,datname,pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=ANY($1::text[])";
        let rows = session.query(query, &[&names]).await?;
        if rows.len() != 1
            || rows[0].try_get::<_, String>(2)?
                != constant("OWNER_ROLE_NAME")
                    .as_str()
                    .ok_or("owner role missing")?
        {
            return Ok(false);
        }
        let oid: String = rows[0].try_get(0)?;
        let actual: String = rows[0].try_get(1)?;
        if actual == names[0] {
            session
                .query(
                    &format!("ALTER DATABASE \"{}\" RENAME TO \"{}\"", names[0], names[1]),
                    &[],
                )
                .await?;
        } else if actual != names[1] {
            return Ok(false);
        }
        let verified = session.query(query, &[&names]).await?;
        if verified.len() != 1
            || verified[0].try_get::<_, String>(0)? != oid
            || verified[0].try_get::<_, String>(1)? != names[1]
            || verified[0].try_get::<_, String>(2)? != constant("OWNER_ROLE_NAME").as_str().unwrap()
        {
            return Ok(false);
        }
        session.query("COMMIT", &[]).await?;
        Ok(true)
    }
}

/// Every node selector term of a local PersistentVolume pins exactly this node. OpenEBS LVM LocalPV
/// publishes both topology keys; volumes it provisioned before carry only `openebs.io/nodename`.
pub(crate) fn pinned_to_node(pv: &Value, node: &str) -> bool {
    pv["spec"]["nodeAffinity"]["required"]["nodeSelectorTerms"]
        .as_array()
        .is_some_and(|terms| {
            !terms.is_empty()
                && terms.iter().all(|term| {
                    term["matchExpressions"]
                        .as_array()
                        .is_some_and(|expressions| {
                            expressions.iter().any(|e| {
                                ["kubernetes.io/hostname", "openebs.io/nodename"]
                                    .contains(&text(e, "key"))
                                    && text(e, "operator") == "In"
                                    && e["values"] == json!([node])
                            })
                        })
                })
        })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_cluster_held_down_starts_postgres_when_released() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../packages/contracts/native/power-vectors.generated.json"
        ))
        .unwrap();
        let db = vectors["intents"][0]["db"].clone();
        let image = "registry.test/postgres@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let steady = json!({"metadata":{"annotations":{}},
            "spec":{"imageName":image,"resources":{"requests":{"cpu":"25m","memory":"128Mi"},"limits":{"cpu":"250m","memory":"256Mi"}},"postgresql":{"parameters":manifests::parameters(&db)}},
            "status":{"currentPrimary":"database-1"}});
        assert!(
            !starts_postgres(Some(&steady), &db, image),
            "a steady Cluster starts nothing"
        );
        assert!(starts_postgres(None, &db, image));
        let changed = |change: &dyn Fn(&mut Value)| {
            let mut cluster = steady.clone();
            change(&mut cluster);
            starts_postgres(Some(&cluster), &db, image)
        };
        // CNPG reports hibernation as a condition of type `cnpg.io/hibernation` with the reason
        // `Hibernated`; that condition alone, or the annotation alone, is a hibernated Cluster.
        assert!(changed(&|c| {
            c["status"]["conditions"] =
                json!([{"type":"cnpg.io/hibernation","status":"True","reason":"Hibernated"}]);
        }));
        assert!(changed(&|c| {
            c["metadata"]["annotations"]["cnpg.io/hibernation"] = "on".into();
        }));
        // A condition that is not CNPG's, or one that does not hold, says nothing.
        assert!(!changed(&|c| {
            c["status"]["conditions"] = json!([{"type":"Hibernated","status":"True"}]);
        }));
        assert!(!changed(&|c| {
            c["status"]["conditions"] =
                json!([{"type":"cnpg.io/hibernation","status":"False","reason":"Hibernated"}]);
        }));
        // A fenced instance starts PostgreSQL when the fence is lifted.
        assert!(changed(&|c| {
            c["metadata"]["annotations"]["cnpg.io/fencedInstances"] = "[\"*\"]".into();
        }));
        assert!(changed(&|c| c["status"]["currentPrimary"] = "".into()));
        assert!(changed(
            &|c| c["spec"]["imageName"] = "registry.test/other@sha256:1".into()
        ));
        assert!(changed(&|c| {
            c["spec"]["resources"]["requests"]["memory"] = "64Mi".into();
        }));
    }
    #[test]
    fn a_retained_volume_pinned_by_the_openebs_node_label_belongs_to_its_node() {
        // OpenEBS LVM LocalPV 1.x provisioned R1 volumes with only `openebs.io/nodename`.
        let pv = |terms: Value| json!({"spec":{"nodeAffinity":{"required":{"nodeSelectorTerms":terms}}}});
        let term = |key: &str, node: &str| json!({"matchExpressions":[{"key":key,"operator":"In","values":[node]}]});
        let node = "pgcf-node-aaaaaaaaaaaaaaaaaaaa";
        assert!(pinned_to_node(
            &pv(json!([term("openebs.io/nodename", node)])),
            node
        ));
        assert!(pinned_to_node(
            &pv(json!([term("kubernetes.io/hostname", node)])),
            node
        ));
        assert!(pinned_to_node(
            &pv(
                json!([{"matchExpressions":[{"key":"kubernetes.io/hostname","operator":"In","values":[node]},{"key":"openebs.io/nodename","operator":"In","values":[node]}]}])
            ),
            node
        ));
        assert!(!pinned_to_node(
            &pv(json!([term(
                "openebs.io/nodename",
                "pgcf-node-bbbbbbbbbbbbbbbbbbbb"
            )])),
            node
        ));
        assert!(!pinned_to_node(
            &pv(json!([term("topology.kubernetes.io/zone", node)])),
            node
        ));
        assert!(!pinned_to_node(
            &pv(json!([
                term("openebs.io/nodename", node),
                term("openebs.io/nodename", "pgcf-node-bbbbbbbbbbbbbbbbbbbb")
            ])),
            node
        ));
        assert!(!pinned_to_node(&pv(json!([])), node));
        assert!(!pinned_to_node(&json!({"spec":{}}), node));
    }
    #[test]
    fn credentials_require_cnpg_ack_for_exact_secret_version() {
        let db = json!({"id":"db","generation":2,"roles":[{"name":"app","owner":true,"password":"secret"}]});
        let mut secret = json!({"apiVersion":"v1","kind":"Secret","type":"kubernetes.io/basic-auth","metadata":{"name":manifests::role_secret("app"),"namespace":"pgcf-db-db","uid":"secret-uid","resourceVersion":"7","labels":{"pgcf.io/database-id":"db","cnpg.io/reload":"true"},"annotations":{"pgcf.io/generation":"2"}},"data":{"username":STANDARD.encode("app"),"password":STANDARD.encode("secret")}});
        let mut cluster =
            json!({"status":{"secretsResourceVersion":{"applicationSecretVersion":"6"}}});
        assert!(!credential_acknowledged(&db, &cluster, &secret));
        cluster["status"]["secretsResourceVersion"]["applicationSecretVersion"] = "7".into();
        assert!(credential_acknowledged(&db, &cluster, &secret));
        secret["metadata"]["annotations"][ACCEPTED] = "3".into();
        assert!(!credential_acknowledged(&db, &cluster, &secret));
    }
    #[test]
    fn the_node_storage_row_binds_only_the_node_volume_group_and_pool() {
        let db = json!({"storage":{"node_uid":"same","volume_group_uuid":"vg","pool_uuid":"pool","profile_sha256":"profile","profile_revision":1,"storage_class":"class","guard_seconds":10}});
        let node = json!({"metadata":{"uid":"same"}});
        // Write authority, its expiry and the profile are no longer the controller's to judge.
        let row = json!({"observed_at":"1970-01-01T00:00:01.000Z","expires_at":"1970-01-01T00:00:02.000Z","write_allowed":false,"node_uid":"same","cluster_uid":"other","volume_group_uuid":"vg","pool_uuid":"pool","profile_sha256":"other","profile_revision":1,"storage_class":"other"});
        assert!(storage_guard(&db, &node, &row).is_ok());
        let mut replaced = node.clone();
        replaced["metadata"]["uid"] = "replaced".into();
        assert!(storage_guard(&db, &replaced, &row).is_err());
        for key in ["node_uid", "volume_group_uuid", "pool_uuid"] {
            let mut changed = row.clone();
            changed[key] = "replaced".into();
            assert!(storage_guard(&db, &node, &changed).is_err(), "{key}");
        }
    }
    #[test]
    fn native_lvm_custody_requires_ready_and_a_live_owned_object() {
        let db = json!({"node":"pgcf-node-aaaaaaaaaaaaaaaaaaaa"});
        let receipt = json!({"volume_handle":"pvc-01234567-89ab-4def-8123-000000000005"});
        let lvm = json!({"metadata":{"name":receipt["volume_handle"],"uid":"01234567-89ab-4def-8123-000000000007"},"spec":{"ownerNodeID":db["node"]},"status":{"state":"Ready"}});
        assert!(native_lvm_owned(&db, &receipt, &lvm));
        let mut changed = lvm.clone();
        changed["status"]["state"] = "Pending".into();
        assert!(!native_lvm_owned(&db, &receipt, &changed));
        changed = lvm.clone();
        changed["metadata"]["deletionTimestamp"] = "2026-10-13T20:57:10.382Z".into();
        assert!(!native_lvm_owned(&db, &receipt, &changed));
        changed = lvm.clone();
        changed["spec"]["ownerNodeID"] = "other-node".into();
        assert!(!native_lvm_owned(&db, &receipt, &changed));
    }
    #[test]
    fn normalized_kubernetes_quantities_compare_numerically() {
        assert_eq!(quantity(&json!("1k")), Some(1000.0));
        assert_eq!(quantity(&json!("1e3")), Some(1000.0));
        assert_eq!(quantity(&json!("1000m")), Some(1.0));
        assert!(contains(
            &json!({"requests":{"cpu":"1","memory":"134217728"}}),
            &json!({"requests":{"cpu":"1000m","memory":"128Mi"}}),
            "resources"
        ));
        assert!(!contains(
            &json!({"requests":{"cpu":"999m"}}),
            &json!({"requests":{"cpu":"1000m"}}),
            "resources"
        ));
        assert!(quantity(&json!("NaN")).is_none());
    }
}

#[cfg(test)]
mod runtime_tests {
    use super::*;
    use crate::test_server::{Server, uid};
    fn vector(name: &str) -> Value {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../packages/contracts/native/controller-vectors.generated.json"
        ))
        .unwrap();
        vectors
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["name"] == name)
            .unwrap()
            .clone()
    }
    struct Fixture {
        server: Server,
        db: Value,
        ns: String,
        snapshot: DesiredSnapshot,
        reconciler: Reconciler,
    }
    fn primary(db: &Value, pod_uid: String, runtime: Option<&str>) -> Value {
        let mut pod = json!({"apiVersion":"v1","kind":"Pod","metadata":{"name":"database-1","namespace":namespace(db),"uid":pod_uid,"labels":{"cnpg.io/cluster":"database",LABEL:db["id"]},"ownerReferences":[{"apiVersion":"postgresql.cnpg.io/v1","kind":"Cluster","name":"database","uid":uid(3),"controller":true}]},"spec":{"nodeName":db["node"]}});
        if let Some(runtime) = runtime {
            pod["spec"]["runtimeClassName"] = runtime.into();
        }
        pod
    }
    /// An established running database whose primary still needs its runtime decision.
    async fn fixture(runtime: &str, pod_runtime: Option<&str>, pool: Value) -> Fixture {
        let server = Server::start().await;
        let entry = vector("entry-request-limit-split");
        let db = entry["db"].clone();
        let ns = namespace(&db);
        let id = text(&db, "id").to_string();
        let mut params = rcgen::CertificateParams::new(vec!["unit-ca".into()]).unwrap();
        params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        let ca = params
            .self_signed(&rcgen::KeyPair::generate().unwrap())
            .unwrap()
            .pem();
        for object in [
            json!({"apiVersion":"v1","kind":"Namespace","metadata":{"name":"kube-system","uid":uid(1)}}),
            json!({"apiVersion":"v1","kind":"Node","metadata":{"name":db["node"],"uid":uid(4),"labels":{}}}),
            json!({"apiVersion":"v1","kind":"Secret","metadata":{"name":"pgcf-backup-s3","namespace":SYSTEM,"uid":uid(5)},"data":{"AWS_ACCESS_KEY_ID":STANDARD.encode("unit-access"),"AWS_SECRET_ACCESS_KEY":STANDARD.encode("unit-secret")}}),
            json!({"apiVersion":"v1","kind":"Namespace","metadata":{"name":ns,"uid":uid(2),"labels":{LABEL:id,RUNTIME:runtime,"other.example/label":"kept"},"annotations":{GENERATION:"1",ACCEPTED:"1"}}}),
            json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":format!("storage-{id}"),"namespace":SYSTEM,"uid":uid(6),"labels":{LABEL:id},"annotations":{GENERATION:"1"}},"data":{"state":json!({"namespaceUid":uid(2),"clusterUid":uid(3),"node":db["node"],"archivePath":db["archive"]["destination_path"]}).to_string()}}),
            json!({"apiVersion":"postgresql.cnpg.io/v1","kind":"Cluster","metadata":{"name":"database","namespace":ns,"uid":uid(3),"labels":{LABEL:id},"annotations":{GENERATION:"1","other.example/annotation":"kept"}},"spec":{},"status":{"currentPrimary":"database-1","certificates":{"serverCASecret":"database-ca"}}}),
            json!({"apiVersion":"v1","kind":"Secret","metadata":{"name":"database-ca","namespace":ns,"uid":uid(7),"ownerReferences":[{"apiVersion":"postgresql.cnpg.io/v1","kind":"Cluster","name":"database","uid":uid(3),"controller":true}]},"data":{"ca.crt":STANDARD.encode(ca)}}),
            primary(&db, uid(8), pod_runtime),
        ] {
            server.put(object);
        }
        let snapshot = DesiredSnapshot {
            region: json!({"id":"eu-test","backup":{"bucket":"native-controller-test","endpoint_url":"https://backup.example.invalid","region":"auto"},"compute_pool":pool}),
            fleet_release: json!({"nodes":[{"k8s_node_name":db["node"],"role":"customer","node_uid":uid(4)}]}),
            databases: vec![],
        };
        let reconciler = Reconciler::new(
            server.k8s.clone(),
            uid(1),
            text(&entry["ctx"], "postgresImage").into(),
            "eu-test".into(),
            1,
        )
        .unwrap();
        Fixture {
            server,
            db,
            ns,
            snapshot,
            reconciler,
        }
    }
    async fn observed(f: &Fixture) -> Value {
        f.reconciler
            .reconcile(&f.db, &f.snapshot)
            .await
            .unwrap()
            .unwrap()["state"]
            .clone()
    }
    #[tokio::test]
    async fn an_existing_current_admitted_target_losing_proof_is_not_hidden_by_provisioning() {
        let mut f = fixture("native", Some("pgcf-native"), Value::Null).await;
        f.db["admission"] = json!({"v":1,"admission_epoch":1,"route_revision":1});
        assert!(database_valid(&f.db));
        // Initial startup has no admission to withdraw.
        assert_eq!(observed(&f).await, "provisioning");
        let target = json!({"v":1,"generation":f.db["generation"],"route_revision":1,"admission_epoch":1,"pod_uid":uid(8),"container_id":"a".repeat(64),"ca_secret_uid":uid(7),"ca_secret_resource_version":"1","ca_sha256":"b".repeat(64),"tls_server_name":format!("database-rw.{}.svc",f.ns)});
        assert!(pgcf_native_protocol::valid_schema(
            "gatewayAdmissionTarget",
            &target
        ));
        let name = format!("gateway-fence-{}", text(&f.db, "id"));
        f.server.put(json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":name,"namespace":SYSTEM,"uid":uid(9),"labels":{LABEL:f.db["id"]}},"data":{"admission_target":serde_json::to_string(&target).unwrap()}}));
        assert_eq!(observed(&f).await, "error");
        // A target from the preceding database generation is an ordinary cold startup.
        f.db["generation"] = 2.into();
        assert_eq!(observed(&f).await, "provisioning");
    }
    /// The CA publication follows the runtime decision, so it shows that reconciliation went on.
    fn published(f: &Fixture) -> bool {
        f.server
            .get(
                "ConfigMap",
                Some(SYSTEM),
                &format!("ca-{}", text(&f.db, "id")),
            )
            .is_some()
    }
    /// Every Pod deletion as (path, DeleteOptions). The API double never replaces a Pod for a
    /// restart annotation, which CNPG applies in place to a primary without a new RuntimeClass.
    fn deletes(f: &Fixture) -> Vec<(String, Value)> {
        let state = f.server.state.lock().unwrap();
        assert!(state.writes.iter().all(|(_, _, body)| {
            body["metadata"]["annotations"]["kubectl.kubernetes.io/restartedAt"].is_null()
        }));
        state
            .writes
            .iter()
            .filter(|(method, _, _)| method == "DELETE")
            .map(|(_, path, body)| (path.clone(), body.clone()))
            .collect()
    }
    fn switch(f: &Fixture) -> Value {
        f.server.get("Cluster", Some(&f.ns), "database").unwrap()["metadata"]["annotations"][SWITCH]
            .clone()
    }
    /// The exact primary deletion that lets CNPG recreate it under the selected runtime.
    fn deleted(f: &Fixture, pod_uid: String, version: &str) -> (String, Value) {
        (
            crate::test_server::path("Pod", Some(&f.ns), "database-1"),
            json!({"apiVersion":"v1","kind":"DeleteOptions","preconditions":{"uid":pod_uid,"resourceVersion":version},"propagationPolicy":"Background"}),
        )
    }
    fn runtime(f: &Fixture) -> Value {
        f.server.get("Namespace", None, &f.ns).unwrap()["metadata"]["labels"][RUNTIME].clone()
    }
    /// Exactly the owned objects node-bootstrap applies for one compute profile.
    fn admission(server: &Server, profile: &str) {
        let meta = |name: &str| json!({"name":name,"labels":{"pgcf.io/managed-by":"node-bootstrap"},"annotations":{"pgcf.io/compute-profile-sha256":profile,"pgcf.io/runtime-admission":"1"}});
        server.put(json!({"apiVersion":"node.k8s.io/v1","kind":"RuntimeClass","metadata":meta("pgcf-prestarted"),"handler":"pgcf","overhead":{"podFixed":{"cpu":"50m","memory":"64Mi"}},"scheduling":{"nodeSelector":{PROFILE:format!("r-{}",&profile[..40])}}}));
        for kind in ["MutatingAdmissionPolicy", "MutatingAdmissionPolicyBinding"] {
            server.put(json!({"apiVersion":"admissionregistration.k8s.io/v1","kind":kind,"metadata":meta("pgcf-cnpg-prestarted"),"spec":{"policyName":"pgcf-cnpg-prestarted"}}));
        }
    }
    #[test]
    fn readiness_requires_exactly_the_selected_runtime() {
        let cluster = json!({"apiVersion":"postgresql.cnpg.io/v1","metadata":{"uid":uid(3)}});
        let db = json!({"node":"customer"});
        let mut pod = json!({"metadata":{"ownerReferences":[{"apiVersion":"postgresql.cnpg.io/v1","kind":"Cluster","name":"database","uid":uid(3)}]},"spec":{"nodeName":"customer"},"status":{"conditions":[{"type":"Ready","status":"True"}]}});
        let standard = json!({"computePool":null});
        let pool = json!({"computePool":{"version":1}});
        assert!(primary_current(&pod, &cluster, &db, &standard));
        assert!(!primary_current(&pod, &cluster, &db, &pool));
        pod["spec"]["runtimeClassName"] = "pgcf-prestarted".into();
        assert!(!primary_current(&pod, &cluster, &db, &standard));
        assert!(primary_current(&pod, &cluster, &db, &pool));
    }
    #[tokio::test]
    async fn a_same_generation_runtime_switch_deletes_only_the_primary_once() {
        let f = fixture("pool", Some("pgcf-prestarted"), Value::Null).await;
        f.server.state.lock().unwrap().lose = Some(Box::new(|path, _| path.contains("/pods/")));
        assert_eq!(observed(&f).await, "provisioning");
        let ns = f.server.get("Namespace", None, &f.ns).unwrap();
        assert_eq!(ns["metadata"]["labels"][RUNTIME], "standard");
        assert_eq!(ns["metadata"]["labels"]["other.example/label"], "kept");
        let cluster = f.server.get("Cluster", Some(&f.ns), "database").unwrap();
        assert_eq!(switch(&f), format!("1/standard/{}", uid(8)));
        assert_eq!(
            cluster["metadata"]["annotations"]["other.example/annotation"],
            "kept"
        );
        // The delete committed although its reply was lost; the read-back resolves it.
        assert_eq!(deletes(&f), vec![deleted(&f, uid(8), "1")]);
        assert!(!published(&f));
        assert_eq!(observed(&f).await, "provisioning");
        assert!(!published(&f));
        // A replacement that still came up on the other runtime is never deleted in a loop.
        f.server
            .put(primary(&f.db, uid(9), Some("pgcf-prestarted")));
        assert_eq!(observed(&f).await, "provisioning");
        assert_eq!(deletes(&f).len(), 1);
        // Only a deletion makes CNPG recreate the primary, here without a RuntimeClass.
        f.server.put(primary(&f.db, uid(10), None));
        assert_eq!(observed(&f).await, "provisioning");
        assert!(published(&f));
        assert_eq!(deletes(&f).len(), 1);
        assert_eq!(
            f.server.get("Namespace", None, &f.ns).unwrap()["metadata"]["uid"],
            uid(2)
        );
        assert_eq!(
            f.server.get("Cluster", Some(&f.ns), "database").unwrap()["metadata"]["uid"],
            uid(3)
        );
    }
    #[tokio::test]
    async fn a_recorded_switch_deletes_its_primary_that_still_runs() {
        let f = fixture("pool", Some("pgcf-prestarted"), Value::Null).await;
        // The switch was recorded, but its deletion never landed (a crash or a changed version).
        f.server
            .edit("Cluster", Some(&f.ns), "database", |cluster| {
                cluster["metadata"]["annotations"][SWITCH] =
                    format!("1/standard/{}", uid(8)).into();
            });
        assert_eq!(observed(&f).await, "provisioning");
        assert_eq!(deletes(&f), vec![deleted(&f, uid(8), "1")]);
        assert!(
            f.server
                .state
                .lock()
                .unwrap()
                .writes
                .iter()
                .all(|(_, _, body)| body["metadata"]["annotations"][SWITCH].is_null())
        );
        assert!(!published(&f));
    }
    #[tokio::test]
    async fn the_region_pool_waits_for_runtime_admission_of_the_current_profile() {
        let pooled = vector("assigned-sandbox-overhead");
        let f = fixture("standard", None, pooled["ctx"]["computePool"].clone()).await;
        let quota = |f: &Fixture| {
            f.server
                .get("ResourceQuota", Some(&f.ns), "database-resources")
                .unwrap()["spec"]["hard"]
                .clone()
        };
        let node = text(&f.db, "node").to_string();
        // A profile hash that node-bootstrap stamps on the admission objects and the node.
        let current = "4f36e3c1ff2eade6a35e642c8206ac7852caab47d06f0fd8aaae71ed11dd96b4";
        let label = |f: &Fixture, value: Option<String>| {
            f.server.edit("Node", None, &node, |n| {
                let labels = n["metadata"]["labels"].as_object_mut().unwrap();
                match value {
                    Some(value) => labels.insert(PROFILE.into(), value.into()),
                    None => labels.remove(PROFILE),
                };
            })
        };
        assert_eq!(observed(&f).await, "provisioning");
        assert!(published(&f));
        assert_eq!(runtime(&f), "standard");
        assert_eq!(
            quota(&f),
            vector("entry-request-limit-split")["manifests"][1]["spec"]["hard"]
        );
        admission(&f.server, &"f".repeat(64));
        label(&f, Some(format!("r-{}", &current[..40])));
        assert_eq!(observed(&f).await, "provisioning");
        assert_eq!(runtime(&f), "standard");
        admission(&f.server, current);
        label(&f, None);
        assert_eq!(observed(&f).await, "provisioning");
        assert_eq!(runtime(&f), "standard");
        assert!(deletes(&f).is_empty());
        label(&f, Some(format!("r-{}", &current[..40])));
        assert_eq!(observed(&f).await, "provisioning");
        assert_eq!(runtime(&f), "pool");
        assert_eq!(switch(&f), format!("1/pool/native-compute-test/{}", uid(8)));
        assert_eq!(deletes(&f), vec![deleted(&f, uid(8), "1")]);
        assert_eq!(quota(&f), pooled["manifests"][1]["spec"]["hard"]);
    }
    #[tokio::test]
    async fn a_runtime_flip_at_the_same_generation_switches_the_primary_once_more() {
        let pooled = vector("assigned-sandbox-overhead");
        let f = fixture("standard", None, pooled["ctx"]["computePool"].clone()).await;
        let stamped = "0123456789abcdef".repeat(4);
        let label = |value: Option<String>| {
            f.server.edit("Node", None, text(&f.db, "node"), |node| {
                let labels = node["metadata"]["labels"].as_object_mut().unwrap();
                match value {
                    Some(value) => labels.insert(PROFILE.into(), value.into()),
                    None => labels.remove(PROFILE),
                };
            })
        };
        admission(&f.server, &stamped);
        label(Some(format!("r-{}", &stamped[..40])));
        assert_eq!(observed(&f).await, "provisioning");
        assert_eq!(deletes(&f), vec![deleted(&f, uid(8), "1")]);
        // One reconcile misses admission while CNPG recreates the primary under `standard`.
        label(None);
        assert_eq!(observed(&f).await, "provisioning");
        assert_eq!(runtime(&f), "standard");
        f.server.put(primary(&f.db, uid(9), None));
        assert_eq!(observed(&f).await, "provisioning");
        assert!(published(&f));
        assert!(switch(&f).is_null());
        // Admission returns: the primary that now runs `standard` switches once more.
        label(Some(format!("r-{}", &stamped[..40])));
        assert_eq!(observed(&f).await, "provisioning");
        assert_eq!(runtime(&f), "pool");
        assert_eq!(
            deletes(&f),
            vec![deleted(&f, uid(8), "1"), deleted(&f, uid(9), "1")]
        );
        assert_eq!(switch(&f), format!("1/pool/native-compute-test/{}", uid(9)));
    }
    #[tokio::test]
    async fn a_wake_selects_the_runtime_before_it_releases_hibernation() {
        let pooled = vector("assigned-sandbox-overhead");
        let mut f = fixture("standard", None, pooled["ctx"]["computePool"].clone()).await;
        // The database slept under `standard`; the pool was admitted before its wake.
        f.db["generation"] = 2.into();
        f.db["creation"]["ever_ready"] = true.into();
        f.db["power"] = json!({"operation":format!("op_{}","w".repeat(20)),"revision":2,"mode":"running","reason":null});
        let stamped = "0123456789abcdef".repeat(4);
        admission(&f.server, &stamped);
        f.server.edit("Node", None, text(&f.db, "node"), |node| {
            node["metadata"]["labels"][PROFILE] = format!("r-{}", &stamped[..40]).into();
        });
        f.server
            .edit("Cluster", Some(&f.ns), "database", |cluster| {
                cluster["metadata"]["annotations"]["cnpg.io/hibernation"] = "on".into();
            });
        let id = text(&f.db, "id").to_string();
        f.server
            .edit("ConfigMap", Some(SYSTEM), &format!("storage-{id}"), |map| {
                map["metadata"]["annotations"][VOLUME] =
                    json!({"claimUid":uid(11),"volumeUid":uid(12),"handle":"pvc-retained"})
                        .to_string()
                        .into();
            });
        f.server.put(json!({"apiVersion":"v1","kind":"PersistentVolume","metadata":{"name":"pvc-retained","uid":uid(12)},"spec":{"claimRef":{"name":"database-1","namespace":f.ns,"uid":uid(11)},"csi":{"driver":"local.csi.openebs.io","volumeHandle":"pvc-retained"},"storageClassName":"pgcf-lvm"},"status":{"phase":"Bound"}}));
        f.server.put(json!({"apiVersion":"v1","kind":"PersistentVolumeClaim","metadata":{"name":"database-1","namespace":f.ns,"uid":uid(11)},"spec":{"volumeName":"pvc-retained","storageClassName":"pgcf-lvm"},"status":{"phase":"Bound"}}));
        f.server.put(json!({"apiVersion":"local.openebs.io/v1alpha1","kind":"LVMVolume","metadata":{"name":"pvc-retained","namespace":"openebs","uid":uid(13)}}));
        assert_eq!(observed(&f).await, "provisioning");
        let writes = f.server.state.lock().unwrap().writes.clone();
        let position = |path: String, wanted: &dyn Fn(&Value) -> bool| {
            writes
                .iter()
                .position(|(method, at, body)| method == "PATCH" && *at == path && wanted(body))
                .unwrap()
        };
        let label = position(
            crate::test_server::path("Namespace", None, &f.ns),
            &|body| body["metadata"]["labels"][RUNTIME] == "pool",
        );
        let wake = position(
            crate::test_server::path("Cluster", Some(&f.ns), "database"),
            &|body| body["metadata"]["annotations"]["cnpg.io/hibernation"] == "off",
        );
        // Admission matches the namespace label when CNPG creates the woken primary.
        assert!(label < wake);
    }
    #[tokio::test]
    async fn the_region_pool_follows_the_profile_that_node_bootstrap_stamped() {
        // A rollout restamps admission with its release's node policy profile, while the region
        // template that switches the pool on still names the previous release.
        let pooled = vector("assigned-sandbox-overhead");
        let f = fixture("standard", None, pooled["ctx"]["computePool"].clone()).await;
        let stamped = "0123456789abcdef".repeat(4);
        f.server.edit("Node", None, text(&f.db, "node"), |node| {
            node["metadata"]["labels"][PROFILE] = format!("r-{}", &stamped[..40]).into();
        });
        admission(&f.server, &stamped);
        f.server.edit(
            "MutatingAdmissionPolicyBinding",
            None,
            ADMISSION,
            |binding| {
                binding["metadata"]["annotations"]["pgcf.io/compute-profile-sha256"] =
                    "f".repeat(64).into();
            },
        );
        assert_eq!(observed(&f).await, "provisioning");
        assert_eq!(runtime(&f), "standard");
        assert!(deletes(&f).is_empty());
        admission(&f.server, &stamped);
        assert_eq!(observed(&f).await, "provisioning");
        assert_eq!(runtime(&f), "pool");
        assert_eq!(deletes(&f), vec![deleted(&f, uid(8), "1")]);
    }
}
#[cfg(test)]
mod admission_tests;
#[cfg(test)]
mod removal_tests;

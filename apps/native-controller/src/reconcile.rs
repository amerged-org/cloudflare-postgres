// SPDX-License-Identifier: Apache-2.0
use crate::{
    Error,
    api::DesiredSnapshot,
    contracts::{
        constant, database_valid, generation, integer, namespace, number, optional_number, text,
    },
    health::{self, ArchiveSample, Health},
    kubernetes::{Kubernetes, bounded},
    manifests, postgres,
    power::{PowerCoordinator, PrepareRunning, desired_power},
};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use hmac::{Hmac, KeyInit, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use std::{
    net::IpAddr,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const SYSTEM: &str = "pgcf-system";
const LABEL: &str = "pgcf.io/database-id";
const GENERATION: &str = "pgcf.io/generation";
const ACCEPTED: &str = "pgcf.io/accepted-generation";
const VOLUME: &str = "pgcf.io/volume-identity";
pub struct Reconciler {
    pub k8s: Kubernetes,
    pub power: PowerCoordinator,
    pub health: Health,
    pub cluster_uid: String,
    postgres_image: String,
    http: reqwest::Client,
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
fn condition<'a>(v: &'a Value, name: &str) -> Option<&'a str> {
    v["status"]["conditions"]
        .as_array()?
        .iter()
        .find(|c| text(c, "type") == name)?["status"]
        .as_str()
}
fn credential_acknowledged(db: &Value, cluster: &Value, secret: &Value) -> bool {
    let name = text(&secret["metadata"], "name");
    let role = db["roles"].as_array().and_then(|roles| {
        roles
            .iter()
            .find(|role| manifests::role_secret(text(role, "name")) == name)
    });
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
fn cluster_owned(v: &Value, cluster: &Value) -> bool {
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
fn contains(actual: &Value, desired: &Value, path: &str) -> bool {
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
fn millis(value: &Value) -> Option<i128> {
    time::OffsetDateTime::parse(
        value.as_str()?,
        &time::format_description::well_known::Rfc3339,
    )
    .ok()
    .map(|t| t.unix_timestamp_nanos() / 1_000_000)
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
fn startup_valid(db: &Value) -> bool {
    let hold = &db["storage_startup"];
    !hold.is_null()
        && hold["generation"] == db["generation"]
        && hold["node_uid"] == db["storage"]["node_uid"]
        && integer(hold, "budget_bytes")
            .is_ok_and(|n| n >= number(&db["storage"], "startup_reserve_bytes"))
        && millis(&hold["expires_at"]).is_some_and(|expiry| expiry > now())
}
impl Reconciler {
    async fn bind_volume(
        &self,
        db: &Value,
        cluster: &Value,
        pod: &Value,
        authority: &Value,
        stored: &Value,
    ) -> Result<Option<Value>, Error> {
        let Some(identity) = self.volume(db, cluster, pod, authority).await? else {
            return Ok(None);
        };
        let name = format!("storage-{}", text(db, "id"));
        let current = self
            .k8s
            .read("ConfigMap", Some(SYSTEM), &name)
            .await?
            .ok_or("storage receipt disappeared")?;
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
            .read("PersistentVolumeClaim", Some(&ns), claim_name)
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
        let Some(pv) = self.k8s.read("PersistentVolume", None, name).await? else {
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
        let terms = pv["spec"]["nodeAffinity"]["required"]["nodeSelectorTerms"]
            .as_array()
            .ok_or("local volume affinity missing")?;
        if terms.is_empty()
            || !terms.iter().all(|term| {
                term["matchExpressions"]
                    .as_array()
                    .is_some_and(|expressions| {
                        expressions.iter().any(|e| {
                            text(e, "key") == "kubernetes.io/hostname"
                                && text(e, "operator") == "In"
                                && e["values"] == json!([db["node"]])
                        })
                    })
            })
        {
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
            let io = reported["io"].as_array().and_then(|items| {
                items
                    .iter()
                    .find(|io| io["pod_uid"] == pod["metadata"]["uid"])
            });
            if io.is_none_or(|io| {
                io["write_bytes_per_second"] != storage["write_bytes_per_second"]
                    || io["write_iops_per_second"] != storage["write_iops_per_second"]
            }) {
                return Ok(None);
            }
            identity["lvUuid"] = reported["lv_uuid"].clone();
        }
        Ok(Some(identity))
    }
    async fn archive(
        &self,
        db: &Value,
        cluster: &Value,
        pod: &Value,
        ca: &[u8],
    ) -> Result<(Value, bool), Error> {
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
                let session=postgres::connect(db,ca,text(&db["maintenance"],"role"),text(&db["maintenance"],"password"),text(db,"id")).await?;
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
                let sample=health::metrics(&source,now)?;
                let secret=maintenance.as_ref().ok_or("archive secret missing")?;
                let fresh=self.k8s.read("Secret",Some(&ns),"maintenance-credentials").await?.ok_or("archive secret disappeared")?;
                if fresh["metadata"]["uid"]!=secret["metadata"]["uid"]||fresh["metadata"]["resourceVersion"]!=secret["metadata"]["resourceVersion"]{return Err("archive secret changed during probe".into());}
                Ok(sample)
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
        let (fresh_cluster, fresh_pod) = tokio::try_join!(
            self.k8s.read("Cluster", Some(&ns), "database"),
            self.k8s
                .read("Pod", Some(&ns), text(&pod["metadata"], "name"))
        )?;
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
        health::archive_health(&self.k8s, db, &fresh_cluster, sample).await
    }
    pub async fn renew_storage_authority(&self, db: &Value) -> Result<(), Error> {
        if db["storage"].is_null() {
            return Ok(());
        }
        let name = format!("storage-{}", text(db, "id"));
        let Some(map) = self.k8s.read("ConfigMap", Some(SYSTEM), &name).await? else {
            return Ok(());
        };
        owned(&map, db, &name, Some(SYSTEM))?;
        let key = constant("STORAGE_AUTHORITY_LEDGER_KEY")
            .as_str()
            .ok_or("storage gate key not generated")?;
        let token = db["storage_authority"].as_str();
        if map["data"][key].as_str() != token {
            self.k8s.patch(&map, &json!({"data":{key:token}})).await?;
        }
        Ok(())
    }
    pub async fn reconcile(
        &self,
        db: &Value,
        snapshot: &DesiredSnapshot,
    ) -> Result<Option<Value>, Error> {
        if !database_valid(db) {
            return Err("invalid desired database".into());
        }
        let state_name = text(db, "desired_state");
        self.k8s.assert_cluster(&self.cluster_uid).await?;
        if state_name == "deleted" {
            return self
                .power
                .delete_database(db, &snapshot.region["storage_nodes"])
                .await;
        }
        let (authority, node_observed) =
            match self.guard(db, snapshot, state_name == "running").await {
                Ok(value) => value,
                Err(error) => {
                    if state_name == "running" && !db["storage"].is_null() {
                        return self.power.protect_storage(db).await;
                    }
                    return Err(error);
                }
            };
        if self
            .k8s
            .read(
                "ConfigMap",
                Some(SYSTEM),
                &format!("delete-{}", text(db, "id")),
            )
            .await?
            .is_some()
        {
            return Err("database deletion is irreversible".into());
        }
        let ns = namespace(db);
        let ns_current = self.k8s.read("Namespace", None, &ns).await?;
        let fence_name = format!("storage-{}", text(db, "id"));
        let mut fence = self
            .k8s
            .read("ConfigMap", Some(SYSTEM), &fence_name)
            .await?;
        let prior_cluster = self.k8s.read("Cluster", Some(&ns), "database").await?;
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
        if state_name == "suspended" {
            return self.power.suspend(db).await;
        }
        if !db["storage"].is_null() {
            let size = &db["size"];
            let expected = json!({"requests":{"cpu":format!("{}m",optional_number(size,"cpu_request_millicores",number(size,"cpu_millicores"))),"memory":format!("{}Mi",optional_number(size,"memory_request_mib",number(size,"memory_mib")))},"limits":{"cpu":format!("{}m",number(size,"cpu_millicores")),"memory":format!("{}Mi",number(size,"memory_mib"))}});
            let needs_startup = prior_cluster.as_ref().is_none_or(|cluster| {
                condition(cluster, "Hibernated") == Some("True")
                    || text(&cluster["status"], "currentPrimary").is_empty()
                    || text(&cluster["spec"], "imageName")
                        != db["postgres"]["image"]
                            .as_str()
                            .unwrap_or(&self.postgres_image)
                    || !contains(&cluster["spec"]["resources"], &expected, "resources")
                    || !contains(
                        &cluster["spec"]["postgresql"]["parameters"],
                        &manifests::parameters(db),
                        "",
                    )
            });
            if needs_startup && !startup_valid(db) {
                return Ok(Some(observation(
                    db,
                    "provisioning",
                    Some("waiting for current Cloudflare startup admission"),
                )));
            }
        }
        let intent = desired_power(db)?;
        if intent.is_some() {
            match self.power.prepare_running(db).await? {
                PrepareRunning::Pending => return Ok(Some(observation(db, "provisioning", None))),
                PrepareRunning::Observation(v) => return Ok(Some(v)),
                PrepareRunning::Proceed => {}
            }
        }
        let finalized = !db["recovery"].is_null()
            && stored["recoveryMappedOperation"] == db["recovery"]["operation_id"];
        let context = self.context(db, snapshot, finalized).await?;
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
        let mut manifests = manifests::build(db, &context)?;
        let mut desired_ns = manifests.remove(0);
        desired_ns["metadata"]["annotations"] =
            json!({ACCEPTED:number(db,"generation").to_string()});
        let namespace_value = if let Some(current) = ns_current {
            if current["metadata"]["annotations"][ACCEPTED].as_str()
                == Some(number(db, "generation").to_string().as_str())
            {
                current
            } else {
                let mut patch = desired_ns.clone();
                patch["metadata"]["annotations"] =
                    json!({ACCEPTED:number(db,"generation").to_string()});
                self.k8s.patch(&current, &patch).await?
            }
        } else {
            self.k8s.create(&desired_ns).await?
        };
        stored["namespaceUid"] = namespace_value["metadata"]["uid"].clone();
        fence = Some(self.save_state(db, &stored, fence.as_ref()).await?);
        let mut applied = vec![];
        for manifest in &manifests {
            let actual = self.apply(db, manifest).await?;
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
        self.renew_storage_authority(db).await?;
        let Some(cluster) = self.k8s.read("Cluster", Some(&ns), "database").await? else {
            return Ok(Some(observation(db, "provisioning", None)));
        };
        owned(&cluster, db, "database", Some(&ns))?;
        if cluster["metadata"]["uid"] != stored["clusterUid"] {
            return Err("Cluster identity changed after apply".into());
        }
        let Some((ca, ca_secret)) = self.ca(db, &cluster).await? else {
            return Ok(Some(observation(db, "provisioning", None)));
        };
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
        let Some(pod) = self.k8s.read("Pod", Some(&ns), primary).await? else {
            return Ok(Some(observation(db, "provisioning", None)));
        };
        if !cluster_owned(&pod, &cluster)
            || condition(&pod, "Ready") != Some("True")
            || pod["spec"]["nodeName"] != db["node"]
            || !pod["metadata"]["deletionTimestamp"].is_null()
        {
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
        let Some(volume_identity) = self
            .bind_volume(db, &cluster, &pod, &authority, &stored)
            .await?
        else {
            return Ok(Some(observation(db, "provisioning", None)));
        };
        if applied.iter().any(|resource| {
            text(resource, "kind") == "Secret" && !credential_acknowledged(db, &cluster, resource)
        }) {
            return Ok(Some(observation(db, "provisioning", None)));
        }
        if !postgres::roles(db, &ca).await? {
            return Ok(Some(observation(db, "provisioning", None)));
        }
        for actual in &applied {
            let Some(fresh) = self
                .k8s
                .read(
                    text(actual, "kind"),
                    actual["metadata"]["namespace"].as_str(),
                    text(&actual["metadata"], "name"),
                )
                .await?
            else {
                return Ok(Some(observation(db, "provisioning", None)));
            };
            if fresh["metadata"]["uid"] != actual["metadata"]["uid"]
                || if text(actual, "kind") == "Secret" {
                    fresh["metadata"]["resourceVersion"] != actual["metadata"]["resourceVersion"]
                } else {
                    !contains(&fresh["spec"], &actual["spec"], "")
                }
            {
                return Ok(Some(observation(db, "provisioning", None)));
            }
        }
        let current_ca = self
            .k8s
            .read("Secret", Some(&ns), text(&ca_secret["metadata"], "name"))
            .await?
            .ok_or("TLS authority disappeared")?;
        if current_ca["metadata"]["uid"] != ca_secret["metadata"]["uid"]
            || current_ca["metadata"]["resourceVersion"] != ca_secret["metadata"]["resourceVersion"]
            || !cluster_owned(&current_ca, &cluster)
        {
            return Ok(Some(observation(db, "provisioning", None)));
        }
        let (archive, archive_alarm) = self.archive(db, &cluster, &pod, &ca).await?;
        let established =
            db["creation"]["ever_ready"] == true || db["recovery"]["ever_ready"] == true;

        if !db["storage"].is_null() && db["storage_authority"].as_str().is_none() {
            return Ok(Some(observation(db, "provisioning", None)));
        }
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
        let final_ns = self
            .k8s
            .read("Namespace", None, &ns)
            .await?
            .ok_or("Namespace disappeared before readiness")?;
        if final_ns["metadata"]["uid"] != namespace_value["metadata"]["uid"]
            || final_ns["metadata"]["annotations"][ACCEPTED].as_str()
                != Some(number(db, "generation").to_string().as_str())
        {
            return Err("Namespace generation changed before readiness".into());
        }
        if is_ready {
            let cid = text(status, "containerID")
                .strip_prefix("containerd://")
                .unwrap_or("");
            let boot = text(&node_observed["status"]["nodeInfo"], "bootID");
            let proof = json!({"v":1,"database_id":db["id"],"generation":db["generation"],"storage_generation":optional_number(db,"storage_generation",1),"node_uid":node_observed["metadata"]["uid"],"boot_id":boot,"cluster_uid":self.cluster_uid,"namespace_uid":final_ns["metadata"]["uid"],"cnpg_cluster_uid":cluster["metadata"]["uid"],"storage_uid":fence.as_ref().ok_or("runtime storage receipt absent")?["metadata"]["uid"],"pvc_uid":volume_identity["claimUid"],"pv_uid":volume_identity["volumeUid"],"pod_uid":pod["metadata"]["uid"],"container_id":cid,"postgres_image_sha256":expected_image.rsplit("@sha256:").next().ok_or("runtime image digest absent")?,"memory_request_bytes":quantity(&postgres_container["resources"]["requests"]["memory"]),"memory_limit_bytes":quantity(&postgres_container["resources"]["limits"]["memory"]),"observed_at":u64::try_from(now()).map_err(|_|"runtime clock invalid")?,"configuration_fingerprint":crate::contracts::configuration_fingerprint(db,&self.postgres_image)?});
            if crate::contracts::schema_valid("DatabaseRuntimeAttestation", &proof) {
                result["runtime_attestation"] = proof;
            }
        }
        if generation(&final_ns) != number(db, "generation") {
            self.k8s.patch(&final_ns,&json!({"metadata":{"annotations":{GENERATION:number(db,"generation").to_string(),ACCEPTED:number(db,"generation").to_string()}}})).await?;
        }
        if let Some(intent) = intent {
            let intent = serde_json::to_value(intent)?;
            self.power.finish_running(db, result, Some(&intent)).await
        } else {
            self.power.publish_ready_fence(db, result).await
        }
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
        let power = PowerCoordinator::new(k8s.clone(), region, replicas)?;
        let http = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()?;
        Ok(Self {
            k8s,
            power,
            health: Health::default(),
            cluster_uid,
            postgres_image,
            http,
        })
    }
    async fn guard(
        &self,
        db: &Value,
        snapshot: &DesiredSnapshot,
        require_write: bool,
    ) -> Result<(Value, Value), Error> {
        self.k8s.assert_cluster(&self.cluster_uid).await?;
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
            .read("Node", None, text(db, "node"))
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
        let storage = &db["storage"];
        let authority = snapshot.region["storage_nodes"]
            .as_array()
            .and_then(|nodes| {
                nodes
                    .iter()
                    .find(|node| text(node, "name") == text(db, "node"))
            })
            .ok_or("thin host authority missing")?;
        let current = now();
        let start = millis(&authority["observed_at"]).ok_or("host observation clock invalid")?;
        let end = millis(&authority["expires_at"]).ok_or("host observation expiry invalid")?;
        if current < 0
            || start > current + 5000
            || start < current - 120000
            || end <= current
            || end - start > i128::from(number(storage, "guard_seconds")) * 1000
            || (require_write && authority["write_allowed"] != true)
            || authority["node_uid"] != node["metadata"]["uid"]
            || text(authority, "cluster_uid") != self.cluster_uid
            || authority["node_uid"] != storage["node_uid"]
            || authority["volume_group_uuid"] != storage["volume_group_uuid"]
            || authority["pool_uuid"] != storage["pool_uuid"]
            || authority["profile_sha256"] != storage["profile_sha256"]
            || integer(authority, "profile_revision")? < number(storage, "profile_revision")
            || authority["storage_class"] != storage["storage_class"]
        {
            return Err("thin host identity or write authority changed".into());
        }
        Ok((authority.clone(), node))
    }
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
            {
                return Ok(current.clone());
            }
            let mut patch = manifest.clone();
            patch["metadata"]["annotations"] =
                json!({GENERATION:number(db,"generation").to_string()});
            if kind == "Cluster"
                && manifest["spec"]["enableSuperuserAccess"] == false
                && !current["spec"]["superuserSecret"].is_null()
            {
                patch["spec"]["superuserSecret"] = Value::Null;
            }
            self.k8s.patch(current, &patch).await
        } else {
            let mut manifest = manifest.clone();
            manifest["metadata"]["annotations"] =
                json!({GENERATION:number(db,"generation").to_string()});
            self.k8s.create(&manifest).await
        }
    }
    async fn context(
        &self,
        db: &Value,
        snapshot: &DesiredSnapshot,
        finalized: bool,
    ) -> Result<Value, Error> {
        let secret = self
            .k8s
            .read("Secret", Some(SYSTEM), "pgcf-backup-s3")
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
        let mut context = json!({"backup":{"bucket":snapshot.region["backup"]["bucket"],"endpointUrl":snapshot.region["backup"]["endpoint_url"],"region":"auto","credentials":{"accessKeyId":decode("AWS_ACCESS_KEY_ID")?,"secretAccessKey":decode("AWS_SECRET_ACCESS_KEY")?}},"postgresImage":self.postgres_image,"systemNamespace":SYSTEM,"cnpgNamespace":"cnpg-system","storageClass":"pgcf-lvm","gatewaySelector":{"namespace":SYSTEM,"podLabels":{"app.kubernetes.io/name":"pgcf-gateway"}},"agentSelector":{"namespace":SYSTEM,"podLabels":{"app.kubernetes.io/name":"pgcf-agent"}},"recoveryFinalized":finalized,"computePool":snapshot.region["compute_pool"]});
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
    async fn ca(&self, db: &Value, cluster: &Value) -> Result<Option<(Vec<u8>, Value)>, Error> {
        let name = text(&cluster["status"]["certificates"], "serverCASecret");
        if name.is_empty() {
            return Ok(None);
        }
        let ns = namespace(db);
        let secret = self
            .k8s
            .read("Secret", Some(&ns), name)
            .await?
            .ok_or("CNPG CA secret disappeared")?;
        if !cluster_owned(&secret, cluster)
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
        let manifest = json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":format!("ca-{}",text(db,"id")),"namespace":SYSTEM,"labels":{LABEL:db["id"]}},"data":{"ca.crt":String::from_utf8(ca.clone())?}});
        self.apply(db, &manifest).await?;
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

#[cfg(test)]
mod tests {
    use super::*;
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
    fn thin_startup_requires_current_owned_generation_node_budget_and_expiry() {
        let expires = (time::OffsetDateTime::now_utc() + time::Duration::minutes(1))
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap();
        let mut db = json!({"generation":7,"storage":{"node_uid":"same-node","startup_reserve_bytes":4096},"storage_startup":{"generation":7,"node_uid":"same-node","budget_bytes":4096,"expires_at":expires}});
        assert!(startup_valid(&db));
        db["storage_startup"]["generation"] = 6.into();
        assert!(!startup_valid(&db));
        db["storage_startup"]["generation"] = 7.into();
        db["storage_startup"]["budget_bytes"] = 4095.into();
        assert!(!startup_valid(&db));
        db["storage_startup"]["budget_bytes"] = 4096.into();
        db["storage_startup"]["node_uid"] = "another-node".into();
        assert!(!startup_valid(&db));
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

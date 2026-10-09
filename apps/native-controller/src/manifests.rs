// SPDX-License-Identifier: Apache-2.0
use crate::{
    Error,
    contracts::{constant, database_valid, namespace, number, optional_number, schema_valid, text},
};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use hmac::{Hmac, KeyInit, Mac};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::net::IpAddr;

pub fn role_secret(name: &str) -> String {
    let readable = format!("role-{name}");
    if readable.len() <= 63
        && readable
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !readable.ends_with('-')
    {
        readable
    } else {
        format!(
            "role-h-{}",
            &Sha256::digest(name.as_bytes())
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()[..56]
        )
    }
}
fn metadata(name: &str, namespace: &str, id: &str) -> Value {
    json!({"name":name,"namespace":namespace,"labels":{"pgcf.io/database-id":id}})
}
fn resource(api: &str, kind: &str, meta: Value, spec: Value) -> Value {
    json!({"apiVersion":api,"kind":kind,"metadata":meta,"spec":spec})
}
fn endpoint(ctx: &Value) -> Result<reqwest::Url, Error> {
    let url = reqwest::Url::parse(text(&ctx["backup"], "endpointUrl"))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none_or(|h| h.parse::<IpAddr>().is_ok())
        || text(&ctx["backup"]["credentials"], "accessKeyId").is_empty()
        || text(&ctx["backup"]["credentials"], "secretAccessKey").is_empty()
    {
        return Err("invalid backup context".into());
    }
    Ok(url)
}
fn selector(ctx: &Value, name: &str) -> Result<Value, Error> {
    let s = &ctx[name];
    let ns = text(s, "namespace");
    let labels = s["podLabels"]
        .as_object()
        .ok_or("invalid workload selector")?;
    if ns.is_empty() || labels.is_empty() {
        return Err("invalid workload selector".into());
    }
    let mut result = serde_json::Map::new();
    for (key, value) in labels {
        result.insert(format!("k8s:{key}"), value.clone());
    }
    result.insert("k8s:io.kubernetes.pod.namespace".into(), ns.into());
    Ok(result.into())
}
fn sidecar(ctx: &Value) -> Value {
    let s = constant("SIDECAR");
    json!({"env":[{"name":"AWS_DEFAULT_REGION","value":ctx["backup"]["region"]}],"resources":{"requests":{"cpu":format!("{}m",number(s,"requestCpuMillicores")),"memory":format!("{}Mi",number(s,"requestMemoryMib"))},"limits":{"cpu":format!("{}m",number(s,"limitCpuMillicores")),"memory":format!("{}Mi",number(s,"limitMemoryMib"))}}})
}
pub fn parameters(db: &Value) -> Value {
    let size = &db["size"];
    let memory = number(size, "memory_mib");
    let request = optional_number(size, "memory_request_mib", memory);
    json!({"shared_buffers":format!("{}MB",(request/4).max(1)),"effective_cache_size":format!("{}MB",memory/2),"max_connections":number(size,"max_connections").to_string(),"archive_timeout":format!("{}s",number(size,"archive_timeout_seconds"))})
}
fn secret(name: &str, ns: &str, id: &str, role: &str, password: &str) -> Value {
    let mut meta = metadata(name, ns, id);
    meta["labels"]["cnpg.io/reload"] = "true".into();
    json!({"apiVersion":"v1","kind":"Secret","metadata":meta,"type":"kubernetes.io/basic-auth","data":{"username":STANDARD.encode(role),"password":STANDARD.encode(password)}})
}
fn archive_secret(name: &str, ns: &str, id: &str, credentials: &Value) -> Value {
    json!({"apiVersion":"v1","kind":"Secret","metadata":metadata(name,ns,id),"type":"Opaque","data":{"AWS_ACCESS_KEY_ID":STANDARD.encode(text(credentials,"accessKeyId")),"AWS_SECRET_ACCESS_KEY":STANDARD.encode(text(credentials,"secretAccessKey"))}})
}
fn object_store(
    name: &str,
    ns: &str,
    id: &str,
    destination: &Value,
    url: &Value,
    credential: &str,
    ctx: &Value,
) -> Value {
    resource(
        "barmancloud.cnpg.io/v1",
        "ObjectStore",
        metadata(name, ns, id),
        json!({"configuration":{"destinationPath":destination,"endpointURL":url,"s3Credentials":{"accessKeyId":{"name":credential,"key":"AWS_ACCESS_KEY_ID"},"secretAccessKey":{"name":credential,"key":"AWS_SECRET_ACCESS_KEY"}},"wal":{"compression":"gzip"},"data":{"compression":"gzip"}},"instanceSidecarConfiguration":sidecar(ctx)}),
    )
}
pub fn build(db: &Value, ctx: &Value) -> Result<Vec<Value>, Error> {
    if !database_valid(db) || text(db, "desired_state") != "running" {
        return Err("invalid running database".into());
    }
    let backup_endpoint = endpoint(ctx)?;
    if text(ctx, "systemNamespace") != "pgcf-system"
        || text(ctx, "cnpgNamespace") != "cnpg-system"
        || text(ctx, "storageClass") != "pgcf-lvm"
        || text(&ctx["backup"], "region") != "auto"
    {
        return Err("invalid management context".into());
    }
    let image = db["postgres"]["image"]
        .as_str()
        .unwrap_or(text(ctx, "postgresImage"));
    if !image.rsplit_once("@sha256:").is_some_and(|(repo, digest)| {
        !repo.is_empty()
            && digest.len() == 64
            && digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }) {
        return Err("mutable image refused".into());
    }
    if !ctx["computePool"].is_null() {
        let policy = &ctx["computePool"];
        if !schema_valid("ComputePoolPolicy", policy)
            || number(policy, "target_slots") * number(policy, "per_slot_cpu_millicores")
                > number(policy, "max_idle_cpu_millicores")
            || number(policy, "target_slots") * number(policy, "per_slot_memory_mib")
                > number(policy, "max_idle_memory_mib")
        {
            return Err("invalid assigned runtime overhead policy".into());
        }
    }
    let id = text(db, "id");
    let ns = namespace(db);
    let labels = json!({"pgcf.io/database-id":id});
    let size = &db["size"];
    let memory = number(size, "memory_mib");
    let cpu = number(size, "cpu_millicores");
    let cpu_request = optional_number(size, "cpu_request_millicores", cpu);
    let slots = constant("QUOTA_SLOTS")
        .as_u64()
        .ok_or("quota slots missing")?;
    let side = constant("SIDECAR");
    let overhead_cpu = number(&ctx["computePool"], "per_slot_cpu_millicores");
    let overhead_memory = number(&ctx["computePool"], "per_slot_memory_mib");
    let meta = |name: &str| metadata(name, &ns, id);
    if !text(&db["archive"], "destination_path")
        .starts_with(&format!("s3://{}/", text(&ctx["backup"], "bucket")))
    {
        return Err("backup bucket identity mismatch".into());
    }
    let gateway = selector(ctx, "gatewaySelector")?;
    let agent = selector(ctx, "agentSelector")?;
    let ingress = |name: &str, selection: &str, ports: Value| {
        resource(
            "networking.k8s.io/v1",
            "NetworkPolicy",
            meta(name),
            json!({"podSelector":{"matchLabels":{"cnpg.io/cluster":"database"}},"policyTypes":["Ingress"],"ingress":[{"from":[{"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":ctx[selection]["namespace"]}},"podSelector":{"matchLabels":ctx[selection]["podLabels"]}}],"ports":ports}]}),
        )
    };
    let mut hosts =
        vec![json!({"matchName":backup_endpoint.host_str().ok_or("backup host missing")?})];
    let recovery = &db["recovery"];
    let source = &recovery["source_archive"];
    if !source.is_null() {
        let source_ctx = json!({"backup":ctx["recoverySource"]});
        let source_endpoint = endpoint(&source_ctx)?;
        if ctx["recoverySource"]["bucket"] != source["bucket"]
            || ctx["recoverySource"]["endpointUrl"] != source["endpoint_url"]
        {
            return Err("recovery credentials identity mismatch".into());
        }
        let host = json!({"matchName":source_endpoint.host_str().ok_or("recovery host missing")?});
        if !hosts.contains(&host) {
            hosts.push(host);
        }
    }
    let mut result = vec![
        json!({"apiVersion":"v1","kind":"Namespace","metadata":{"name":ns,"labels":{"pgcf.io/database-id":id,"pod-security.kubernetes.io/enforce":"restricted","pod-security.kubernetes.io/enforce-version":"latest"}}}),
        resource(
            "v1",
            "ResourceQuota",
            meta("database-resources"),
            json!({"hard":{"requests.cpu":format!("{}m",slots*(cpu_request+number(side,"requestCpuMillicores")+overhead_cpu)),"limits.cpu":format!("{}m",slots*(cpu+number(side,"limitCpuMillicores")+overhead_cpu)),"requests.memory":format!("{}Mi",slots*(memory+number(side,"requestMemoryMib")+overhead_memory)),"limits.memory":format!("{}Mi",slots*(memory+number(side,"limitMemoryMib")+overhead_memory)),"requests.storage":format!("{}Gi",number(size,"storage_gib")),"persistentvolumeclaims":"1","pods":slots.to_string()}}),
        ),
        resource(
            "v1",
            "LimitRange",
            meta("container-defaults"),
            json!({"limits":[{"type":"Container","defaultRequest":{"cpu":"25m","memory":"64Mi"},"default":{"cpu":"100m","memory":"128Mi"}}]}),
        ),
        resource(
            "networking.k8s.io/v1",
            "NetworkPolicy",
            meta("default-deny"),
            json!({"podSelector":{},"policyTypes":["Ingress","Egress"]}),
        ),
        ingress(
            "gateway-ingress",
            "gatewaySelector",
            json!([{"port":5432,"protocol":"TCP"}]),
        ),
        ingress(
            "agent-management-ingress",
            "agentSelector",
            json!([{"port":5432,"protocol":"TCP"},{"port":9187,"protocol":"TCP"}]),
        ),
        resource(
            "cilium.io/v2",
            "CiliumNetworkPolicy",
            meta("database-boundaries"),
            json!({"endpointSelector":{"matchLabels":{"cnpg.io/cluster":"database"}},"ingress":[{"fromEndpoints":[{"matchLabels":gateway}],"toPorts":[{"ports":[{"port":"5432","protocol":"TCP"}]}]},{"fromEndpoints":[{"matchLabels":agent}],"toPorts":[{"ports":[{"port":"5432","protocol":"TCP"},{"port":"9187","protocol":"TCP"}]}]},{"fromEndpoints":[{"matchLabels":{"k8s:io.kubernetes.pod.namespace":ctx["cnpgNamespace"],"k8s:app.kubernetes.io/name":"cloudnative-pg"}},{"matchLabels":{"k8s:io.kubernetes.pod.namespace":ctx["cnpgNamespace"],"k8s:app.kubernetes.io/name":"plugin-barman-cloud"}}],"toPorts":[{"ports":[{"port":"8000","protocol":"TCP"}]}]}],"egress":[{"toEndpoints":[{"matchLabels":{"k8s:io.kubernetes.pod.namespace":"kube-system","k8s:k8s-app":"kube-dns"}}],"toPorts":[{"ports":[{"port":"53","protocol":"UDP"},{"port":"53","protocol":"TCP"}],"rules":{"dns":[{"matchPattern":"*"}]}}]},{"toEntities":["kube-apiserver"],"toPorts":[{"ports":[{"port":"443","protocol":"TCP"},{"port":"6443","protocol":"TCP"}]}]},{"toFQDNs":hosts,"toPorts":[{"ports":[{"port":"443","protocol":"TCP"}]}]}]}),
        ),
    ];
    let owner_name = constant("OWNER_ROLE_NAME")
        .as_str()
        .ok_or("owner role missing")?;
    let mut managed = vec![];
    for role in db["roles"].as_array().ok_or("roles missing")? {
        let name = text(role, "name");
        result.push(secret(
            &role_secret(name),
            &ns,
            id,
            name,
            text(role, "password"),
        ));
        if role["owner"] != true {
            managed.push(json!({"name":name,"ensure":"present","login":true,"superuser":false,"createdb":false,"createrole":false,"replication":false,"bypassrls":false,"inherit":true,"passwordSecret":{"name":role_secret(name)}}));
        }
    }
    if !db["maintenance"].is_null() {
        let role = constant("MAINTENANCE_ROLE")
            .as_str()
            .ok_or("maintenance role missing")?;
        result.push(secret(
            "maintenance-credentials",
            &ns,
            id,
            role,
            text(&db["maintenance"], "password"),
        ));
        managed.push(json!({"name":role,"ensure":"present","login":true,"superuser":false,"createdb":false,"createrole":false,"replication":false,"bypassrls":false,"inherit":true,"inRoles":["pg_read_all_stats"],"passwordSecret":{"name":"maintenance-credentials"}}));
    }
    result.push(archive_secret(
        "archive-credentials",
        &ns,
        id,
        &ctx["backup"]["credentials"],
    ));
    let mut archive = object_store(
        "archive",
        &ns,
        id,
        &db["archive"]["destination_path"],
        &ctx["backup"]["endpointUrl"],
        "archive-credentials",
        ctx,
    );
    archive["spec"]["retentionPolicy"] =
        format!("{}d", number(size, "backup_retention_days")).into();
    result.push(archive);
    if !recovery.is_null() {
        let credential = if !source.is_null() {
            result.push(archive_secret(
                "recovery-source-credentials",
                &ns,
                id,
                &ctx["recoverySource"]["credentials"],
            ));
            "recovery-source-credentials"
        } else {
            "archive-credentials"
        };
        let url = if !source.is_null() {
            &ctx["recoverySource"]["endpointUrl"]
        } else {
            &ctx["backup"]["endpointUrl"]
        };
        result.push(object_store(
            "recovery-source",
            &ns,
            id,
            &recovery["source_archive_path"],
            url,
            credential,
            ctx,
        ));
    }
    let final_recovery = ctx["recoveryFinalized"] == true;
    let recovering = !recovery.is_null() && !final_recovery;
    if recovering {
        let mut h = Hmac::<Sha256>::new_from_slice(
            text(&ctx["backup"]["credentials"], "secretAccessKey").as_bytes(),
        )?;
        h.update(format!("pgcf-restore|{id}|{}", text(recovery, "operation_id")).as_bytes());
        result.push(secret(
            "restore-superuser",
            &ns,
            id,
            "postgres",
            &URL_SAFE_NO_PAD.encode(h.finalize().into_bytes()),
        ));
        let last = result.last_mut().unwrap();
        last["metadata"]["labels"]
            .as_object_mut()
            .unwrap()
            .remove("cnpg.io/reload");
    }
    let mut bootstrap = if recovery.is_null() {
        json!({"initdb":{"database":id,"owner":owner_name,"secret":{"name":role_secret(owner_name)}}})
    } else {
        json!({"recovery":{"source":"origin","database":if final_recovery{id}else{text(recovery,"source_database_id")},"owner":owner_name,"secret":{"name":role_secret(owner_name)},"recoveryTarget":{"backupID":recovery["backup_id"]}}})
    };
    if recovery.is_null() && !db["maintenance"].is_null() {
        bootstrap["initdb"]["postInitApplicationSQL"] =
            constant("MAINTENANCE_BOOTSTRAP_SQL").clone();
    }
    if !recovery["target_time"].is_null() {
        bootstrap["recovery"]["recoveryTarget"]["targetTime"] = recovery["target_time"].clone();
    }
    let mut cluster = resource(
        "postgresql.cnpg.io/v1",
        "Cluster",
        meta("database"),
        json!({"instances":1,"probes":{"startup":{"periodSeconds":1,"failureThreshold":3600},"readiness":{"periodSeconds":1}},"imageName":image,"inheritedMetadata":{"labels":labels},"enableSuperuserAccess":recovering,"bootstrap":bootstrap,"affinity":{"nodeSelector":{"kubernetes.io/hostname":db["node"]}},"resources":{"requests":{"cpu":format!("{cpu_request}m"),"memory":format!("{}Mi",optional_number(size,"memory_request_mib",memory))},"limits":{"cpu":format!("{cpu}m"),"memory":format!("{memory}Mi")}},"seccompProfile":{"type":"RuntimeDefault"},"storage":{"storageClass":ctx["storageClass"],"size":format!("{}Gi",number(size,"storage_gib"))},"postgresql":{"parameters":parameters(db),"pg_hba":["hostnossl all all all reject"]},"managed":{"roles":managed},"plugins":[{"name":"barman-cloud.cloudnative-pg.io","enabled":true,"isWALArchiver":true,"parameters":{"barmanObjectName":"archive","serverName":db["archive"]["server_name"]}}]}),
    );
    if recovering {
        cluster["spec"]["superuserSecret"] = json!({"name":"restore-superuser"});
    }
    if !db["storage"].is_null() {
        cluster["spec"]["stopDelay"] = db["storage"]["drain_seconds"].clone();
        cluster["spec"]["smartShutdownTimeout"] = 0.into();
        cluster["spec"]["storage"]["storageClass"] = db["storage"]["storage_class"].clone();
        cluster["spec"]["storage"]["pvcTemplate"] =
            json!({"volumeAttributesClassName":db["storage"]["volume_attributes_class"]});
    }
    if !recovery.is_null() {
        cluster["spec"]["externalClusters"] = json!([{"name":"origin","plugin":{"name":"barman-cloud.cloudnative-pg.io","parameters":{"barmanObjectName":"recovery-source","serverName":"database"}}}]);
    }
    result.push(cluster);
    result.push(resource("postgresql.cnpg.io/v1","ScheduledBackup",meta("daily-backup"),json!({"schedule":"0 0 3 * * *","immediate":true,"backupOwnerReference":"cluster","cluster":{"name":"database"},"method":"plugin","pluginConfiguration":{"name":"barman-cloud.cloudnative-pg.io"}})));
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn integral_json_float_requests_do_not_fall_back_to_limits() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../packages/contracts/native/controller-vectors.generated.json"
        ))
        .unwrap();
        let mut db = vectors[0]["db"].clone();
        db["size"]["cpu_request_millicores"] = serde_json::from_str("25.0").unwrap();
        db["size"]["memory_request_mib"] = serde_json::from_str("128e0").unwrap();
        assert_eq!(
            build(&db, &vectors[0]["ctx"]).unwrap(),
            build(&vectors[0]["db"], &vectors[0]["ctx"]).unwrap()
        );
        db["size"]["cpu_request_millicores"] = serde_json::from_str("999.0").unwrap();
        assert!(!database_valid(&db));
    }
    #[test]
    fn exact_typescript_builder_conformance() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../packages/contracts/native/controller-vectors.generated.json"
        ))
        .unwrap();
        for v in vectors.as_array().unwrap() {
            assert_eq!(
                build(&v["db"], &v["ctx"]).unwrap(),
                v["manifests"].as_array().unwrap().clone(),
                "{}",
                v["name"]
            );
        }
    }
}

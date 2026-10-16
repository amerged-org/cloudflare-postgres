// SPDX-License-Identifier: Apache-2.0
use crate::{
    Error,
    contracts::{
        constant, database_valid, namespace, number, optional_number, present_roles, removal_roles,
        schema_valid, text,
    },
};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use hmac::{Hmac, KeyInit, Mac};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, net::IpAddr};

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
/// The removal entries whose role the Cluster already asks CNPG to drop (see `build`).
fn dropping_roles(ctx: &Value) -> Result<HashSet<&str>, Error> {
    match &ctx["droppingRoles"] {
        Value::Null => Ok(HashSet::new()),
        Value::Array(names) => names
            .iter()
            .map(|name| {
                name.as_str()
                    .filter(|name| pgcf_native_protocol::valid_role(name))
                    .ok_or_else(|| "invalid build context".into())
            })
            .collect(),
        _ => Err("invalid build context".into()),
    }
}
/// The roles in input order, each only after the roles it is a member of: the first role whose
/// memberships are all emitted comes next. Without memberships the input order is kept. A cycle,
/// which PostgreSQL refuses, is emitted as it stands.
fn membership_order<'a>(roles: impl Iterator<Item = &'a Value>) -> Vec<&'a Value> {
    let mut remaining: Vec<&Value> = roles.collect();
    let names: HashSet<&str> = remaining.iter().map(|role| text(role, "name")).collect();
    let mut emitted: HashSet<&str> = HashSet::new();
    let mut ordered = Vec::with_capacity(remaining.len());
    while !remaining.is_empty() {
        let ready = remaining.iter().position(|role| {
            role["member_of"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .all(|target| emitted.contains(target) || !names.contains(target))
        });
        let next = remaining.remove(ready.unwrap_or(0));
        emitted.insert(text(next, "name"));
        ordered.push(next);
    }
    ordered
}
/// A present role as CNPG manages it: today's keys, and an expiry, a limit and memberships only
/// where the role has them.
fn managed_role(role: &Value) -> Value {
    let name = text(role, "name");
    let mut entry = json!({"name":name,"ensure":"present","login":true,"superuser":false,"createdb":false,"createrole":false,"replication":false,"bypassrls":role["bypass_rls"] == true,"inherit":true,"passwordSecret":{"name":role_secret(name)}});
    if let Some(limit) = role.get("connection_limit") {
        entry["connectionLimit"] = limit.clone();
    }
    // The Cluster serialises metav1.Time in whole seconds, so the fraction is cut, not rounded.
    if let Some(until) = role["valid_until"]
        .as_str()
        .and_then(|until| until.get(..19))
    {
        entry["validUntil"] = format!("{until}Z").into();
    }
    let mut memberships: Vec<&str> = role["member_of"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    memberships.sort_unstable();
    memberships.dedup();
    if !memberships.is_empty() {
        entry["inRoles"] = json!(memberships);
    }
    entry
}
/// The shape and identity of one pool slot (pool design 2026-10-16): a stock CNPG Cluster pinned
/// to `node`, fenced from creation, with limits of the largest class on the node.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SlotSpec {
    /// Eight lowercase hexadecimal digits: the slot namespace is `pgcf-slot-<hex>`.
    pub hex: String,
    pub node: String,
    pub image: String,
    pub cpu_millicores: u64,
    pub memory_mib: u64,
    pub max_connections: u64,
    pub archive_timeout_seconds: u64,
}
/// The tenant parts a slot-served database needs in another namespace: its role Secrets and the
/// maintenance credential, and the managed roles of its Cluster.
pub struct TenantParts {
    pub secrets: Vec<Value>,
    pub managed_roles: Vec<Value>,
}
/// The role Secrets and the maintenance credential of `db` in namespace `ns`, and the managed
/// roles of its Cluster, as `build` renders them for the database's own namespace.
pub fn tenant_parts(db: &Value, ctx: &Value, ns: &str) -> Result<TenantParts, Error> {
    let id = text(db, "id");
    db["roles"].as_array().ok_or("roles missing")?;
    let dropping = dropping_roles(ctx)?;
    let mut secrets = vec![];
    let mut managed = vec![];
    let present: Vec<&Value> = present_roles(db).collect();
    for role in &present {
        let name = text(role, "name");
        secrets.push(secret(
            &role_secret(name),
            ns,
            id,
            name,
            text(role, "password"),
        ));
    }
    for role in membership_order(present.into_iter().filter(|role| role["owner"] != true)) {
        managed.push(managed_role(role));
    }
    // A removal entry never has a Secret: it is disabled first, then dropped once named.
    for role in removal_roles(db) {
        let name = text(role, "name");
        managed.push(if dropping.contains(name) {
            json!({"name":name,"ensure":"absent"})
        } else {
            json!({"name":name,"ensure":"present","login":false})
        });
    }
    if !db["maintenance"].is_null() {
        let role = constant("MAINTENANCE_ROLE")
            .as_str()
            .ok_or("maintenance role missing")?;
        secrets.push(secret(
            "maintenance-credentials",
            ns,
            id,
            role,
            text(&db["maintenance"], "password"),
        ));
        // The statistics it samples; and, only while a role awaits removal, the sessions of that
        // role it ends before the role is dropped. Any other database keeps the manifests it
        // always had.
        let memberships: &[&str] = if removal_roles(db).next().is_some() {
            &["pg_read_all_stats", "pg_signal_backend"]
        } else {
            &["pg_read_all_stats"]
        };
        managed.push(json!({"name":role,"ensure":"present","login":true,"superuser":false,"createdb":false,"createrole":false,"replication":false,"bypassrls":false,"inherit":true,"inRoles":memberships,"passwordSecret":{"name":"maintenance-credentials"}}));
    }
    Ok(TenantParts {
        secrets,
        managed_roles: managed,
    })
}
/// What every database namespace holds besides its tenant: the quota, the container defaults
/// and the network policies, with `labels` on each and `hosts` as the egress the archive needs.
fn runtime_parts(
    ns: &str,
    labels: &Value,
    ctx: &Value,
    hard: Value,
    hosts: Vec<Value>,
) -> Result<Vec<Value>, Error> {
    let meta = |name: &str| json!({"name":name,"namespace":ns,"labels":labels});
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
    Ok(vec![
        resource("v1", "ResourceQuota", meta("database-resources"), hard),
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
    ])
}
/// Whether `image` names an immutable digest.
pub(crate) fn pinned_image(image: &str) -> bool {
    image.rsplit_once("@sha256:").is_some_and(|(repo, digest)| {
        !repo.is_empty()
            && digest.len() == 64
            && digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
/// The probes every database instance has.
fn probes() -> Value {
    json!({"startup":{"periodSeconds":1,"failureThreshold":3600},"readiness":{"periodSeconds":1}})
}
/// The objects of one free pool slot, in creation order: its namespace, the policies of a
/// database namespace, a placeholder archive credential and ObjectStore, and a fenced Cluster
/// whose initdb fills a small placeholder volume. Nothing of a tenant is in any of them.
pub fn slot(spec: &SlotSpec, ctx: &Value) -> Result<Vec<Value>, Error> {
    if !pgcf_native_protocol::wake::is_slot_namespace(&format!(
        "{}{}",
        pgcf_native_protocol::wake::SLOT_NAMESPACE_PREFIX,
        spec.hex
    )) || !crate::kubernetes::identifier(&spec.node)
        || !pinned_image(&spec.image)
        || spec.cpu_millicores == 0
        || spec.memory_mib < 256
        || spec.max_connections < 10
        || spec.archive_timeout_seconds < 30
    {
        return Err("invalid pool slot".into());
    }
    let backup_endpoint = endpoint(ctx)?;
    if text(&ctx["backup"], "bucket").is_empty() || text(&ctx["backup"], "region") != "auto" {
        return Err("invalid management context".into());
    }
    let ns = format!(
        "{}{}",
        pgcf_native_protocol::wake::SLOT_NAMESPACE_PREFIX,
        spec.hex
    );
    let labels = json!({"pgcf.io/slot":spec.hex});
    let meta = |name: &str| json!({"name":name,"namespace":ns,"labels":labels});
    let slots = constant("QUOTA_SLOTS")
        .as_u64()
        .ok_or("quota slots missing")?;
    let side = constant("SIDECAR");
    let (cpu, memory) = (spec.cpu_millicores, spec.memory_mib);
    let hard = json!({"hard":{"requests.cpu":format!("{}m",slots*(cpu+number(side,"requestCpuMillicores"))),"limits.cpu":format!("{}m",slots*(cpu+number(side,"limitCpuMillicores"))),"requests.memory":format!("{}Mi",slots*(memory+number(side,"requestMemoryMib"))),"limits.memory":format!("{}Mi",slots*(memory+number(side,"limitMemoryMib"))),"requests.storage":"1Gi","persistentvolumeclaims":"1","pods":slots.to_string()}});
    let hosts = vec![json!({"matchName":backup_endpoint.host_str().ok_or("backup host missing")?})];
    let mut result = vec![
        json!({"apiVersion":"v1","kind":"Namespace","metadata":{"name":ns,"labels":{"pgcf.io/slot":spec.hex,"pgcf.io/slot-node":spec.node,"pgcf.io/compute-runtime":"standard","pod-security.kubernetes.io/enforce":"restricted","pod-security.kubernetes.io/enforce-version":"latest"}}}),
    ];
    result.extend(runtime_parts(&ns, &labels, ctx, hard, hosts)?);
    let placeholder = STANDARD.encode("pgcf-slot-placeholder");
    result.push(json!({"apiVersion":"v1","kind":"Secret","metadata":meta("archive-credentials"),"type":"Opaque","data":{"AWS_ACCESS_KEY_ID":placeholder,"AWS_SECRET_ACCESS_KEY":placeholder}}));
    let mut archive = resource(
        "barmancloud.cnpg.io/v1",
        "ObjectStore",
        meta("archive"),
        json!({"configuration":{"destinationPath":format!("s3://{}/slots/{}/",text(&ctx["backup"],"bucket"),spec.hex),"endpointURL":ctx["backup"]["endpointUrl"],"s3Credentials":{"accessKeyId":{"name":"archive-credentials","key":"AWS_ACCESS_KEY_ID"},"secretAccessKey":{"name":"archive-credentials","key":"AWS_SECRET_ACCESS_KEY"}},"wal":{"compression":"gzip"},"data":{"compression":"gzip"}},"instanceSidecarConfiguration":sidecar(ctx)}),
    );
    archive["spec"]["retentionPolicy"] = "1d".into();
    result.push(archive);
    let shape = json!({"id":"","size":{"memory_mib":memory,"memory_request_mib":128,"max_connections":spec.max_connections,"archive_timeout_seconds":spec.archive_timeout_seconds}});
    let mut cluster_meta = meta("database");
    cluster_meta["annotations"] = json!({"cnpg.io/fencedInstances":"[\"*\"]"});
    result.push(resource(
        "postgresql.cnpg.io/v1",
        "Cluster",
        cluster_meta,
        json!({"instances":1,"probes":probes(),"imageName":spec.image,"inheritedMetadata":{"labels":labels},"enableSuperuserAccess":false,"bootstrap":{"initdb":{"database":"slot","owner":"slot"}},"affinity":{"nodeSelector":{"kubernetes.io/hostname":spec.node}},"resources":{"requests":{"cpu":"100m","memory":"128Mi"},"limits":{"cpu":format!("{cpu}m"),"memory":format!("{memory}Mi")}},"seccompProfile":{"type":"RuntimeDefault"},"storage":{"storageClass":"pgcf-slot","size":"1Gi"},"postgresql":{"parameters":parameters(&shape),"pg_hba":["hostnossl all all all reject"]},"managed":{"roles":[]},"plugins":[{"name":"barman-cloud.cloudnative-pg.io","enabled":true,"isWALArchiver":true,"parameters":{"barmanObjectName":"archive","serverName":"database"}}],"stopDelay":30,"smartShutdownTimeout":0}),
    ));
    Ok(result)
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
    if !pinned_image(image) {
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
    let runtime = if ctx["computePool"].is_null() {
        "standard"
    } else {
        "pool"
    };
    let hard = json!({"hard":{"requests.cpu":format!("{}m",slots*(cpu_request+number(side,"requestCpuMillicores")+overhead_cpu)),"limits.cpu":format!("{}m",slots*(cpu+number(side,"limitCpuMillicores")+overhead_cpu)),"requests.memory":format!("{}Mi",slots*(memory+number(side,"requestMemoryMib")+overhead_memory)),"limits.memory":format!("{}Mi",slots*(memory+number(side,"limitMemoryMib")+overhead_memory)),"requests.storage":format!("{}Gi",number(size,"storage_gib")),"persistentvolumeclaims":"1","pods":slots.to_string()}});
    let mut result = vec![
        json!({"apiVersion":"v1","kind":"Namespace","metadata":{"name":ns,"labels":{"pgcf.io/database-id":id,"pgcf.io/compute-runtime":runtime,"pod-security.kubernetes.io/enforce":"restricted","pod-security.kubernetes.io/enforce-version":"latest"}}}),
    ];
    result.extend(runtime_parts(&ns, &labels, ctx, hard, hosts)?);
    let owner_name = constant("OWNER_ROLE_NAME")
        .as_str()
        .ok_or("owner role missing")?;
    let TenantParts {
        secrets,
        managed_roles: managed,
    } = tenant_parts(db, ctx, &ns)?;
    result.extend(secrets);
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
        json!({"instances":1,"probes":probes(),"imageName":image,"inheritedMetadata":{"labels":labels},"enableSuperuserAccess":recovering,"bootstrap":bootstrap,"affinity":{"nodeSelector":{"kubernetes.io/hostname":db["node"]}},"resources":{"requests":{"cpu":format!("{cpu_request}m"),"memory":format!("{}Mi",optional_number(size,"memory_request_mib",memory))},"limits":{"cpu":format!("{cpu}m"),"memory":format!("{memory}Mi")}},"seccompProfile":{"type":"RuntimeDefault"},"storage":{"storageClass":ctx["storageClass"],"size":format!("{}Gi",number(size,"storage_gib"))},"postgresql":{"parameters":parameters(db),"pg_hba":["hostnossl all all all reject"]},"managed":{"roles":managed},"plugins":[{"name":"barman-cloud.cloudnative-pg.io","enabled":true,"isWALArchiver":true,"parameters":{"barmanObjectName":"archive","serverName":db["archive"]["server_name"]}}]}),
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
    /// The entries of `spec.managed.roles`, by name and in order.
    fn managed(manifests: &[Value]) -> Vec<Value> {
        manifests.iter().find(|m| m["kind"] == "Cluster").unwrap()["spec"]["managed"]["roles"]
            .as_array()
            .unwrap()
            .clone()
    }
    #[test]
    fn the_maintenance_role_may_end_sessions_only_while_a_role_awaits_removal() {
        let memberships = |name: &str| {
            let v = vector(name);
            managed(&build(&v["db"], &v["ctx"]).unwrap())
                .into_iter()
                .find(|r| r["name"] == "pgcf_maintenance")
                .unwrap()["inRoles"]
                .clone()
        };
        // A database that awaits no removal keeps the manifests it always had.
        assert_eq!(
            memberships("entry-request-limit-split"),
            json!(["pg_read_all_stats"])
        );
        // Ending the sessions of a role it removes needs pg_signal_backend, disabled or dropping.
        for stage in ["role-removal-disable", "role-removal-drop"] {
            assert_eq!(
                memberships(stage),
                json!(["pg_read_all_stats", "pg_signal_backend"]),
                "{stage}"
            );
        }
        // The bootstrap SQL is untouched: CNPG grants the membership, a fresh database or not.
        assert!(
            !constant("MAINTENANCE_BOOTSTRAP_SQL")
                .to_string()
                .contains("pg_signal_backend")
        );
    }
    #[test]
    fn role_attributes_reach_the_managed_role_only_when_set() {
        let v = vector("role-attributes");
        let roles = managed(&build(&v["db"], &v["ctx"]).unwrap());
        let plain = roles.iter().find(|r| r["name"] == "reader_query").unwrap();
        let mut keys: Vec<_> = plain.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "bypassrls",
                "createdb",
                "createrole",
                "ensure",
                "inherit",
                "login",
                "name",
                "passwordSecret",
                "replication",
                "superuser"
            ]
        );
        let limited = roles.iter().find(|r| r["name"] == "report_job").unwrap();
        // The Cluster holds metav1.Time in whole seconds: the fraction is cut, never rounded up.
        assert_eq!(limited["validUntil"], "2031-01-02T03:04:05Z");
        assert_eq!(limited["connectionLimit"], 5);
        assert_eq!(limited["inRoles"], json!(["reader_query"]));
        assert_eq!(limited["bypassrls"], true);
    }
    #[test]
    fn a_role_is_emitted_after_the_roles_it_is_a_member_of() {
        let v = vector("role-membership-order");
        let names: Vec<_> = managed(&build(&v["db"], &v["ctx"]).unwrap())
            .iter()
            .map(|r| r["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            names,
            [
                "reader_query",
                "other_job",
                "base_job",
                "mid_job",
                "leaf_job",
                "pgcf_maintenance"
            ]
        );
        // Without memberships the input order stands: plain databases do not move.
        let mut flat = v["db"].clone();
        for role in flat["roles"].as_array_mut().unwrap() {
            role.as_object_mut().unwrap().remove("member_of");
        }
        let names: Vec<_> = managed(&build(&flat, &v["ctx"]).unwrap())
            .iter()
            .map(|r| r["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            names,
            [
                "reader_query",
                "leaf_job",
                "mid_job",
                "other_job",
                "base_job",
                "pgcf_maintenance"
            ]
        );
    }
    fn slot_spec() -> SlotSpec {
        SlotSpec {
            hex: "0a1b2c3d".into(),
            node: "native-test-node".into(),
            image: vector("entry-request-limit-split")["ctx"]["postgresImage"]
                .as_str()
                .unwrap()
                .into(),
            cpu_millicores: 500,
            memory_mib: 512,
            max_connections: 40,
            archive_timeout_seconds: 60,
        }
    }
    fn kind<'a>(manifests: &'a [Value], kind: &str) -> &'a Value {
        manifests
            .iter()
            .find(|m| m["kind"] == kind)
            .unwrap_or_else(|| panic!("no {kind}"))
    }
    #[test]
    fn the_slot_is_fenced_tenant_free_pinned_to_its_node_with_a_1gi_placeholder_whose_class_deletes_it()
     {
        let ctx = vector("entry-request-limit-split")["ctx"].clone();
        let slot = slot(&slot_spec(), &ctx).unwrap();
        let ns = "pgcf-slot-0a1b2c3d";
        assert_eq!(slot[0]["kind"], "Namespace");
        assert_eq!(
            slot[0]["metadata"],
            json!({"name":ns,"labels":{"pgcf.io/slot":"0a1b2c3d","pgcf.io/slot-node":"native-test-node","pgcf.io/compute-runtime":"standard","pod-security.kubernetes.io/enforce":"restricted","pod-security.kubernetes.io/enforce-version":"latest"}})
        );
        // Every object lives in the slot namespace, and none names a database or holds a tenant
        // byte: no role, no tenant archive path, no working archive key.
        for manifest in &slot[1..] {
            assert_eq!(manifest["metadata"]["namespace"], ns, "{manifest}");
            assert_eq!(
                manifest["metadata"]["labels"],
                json!({"pgcf.io/slot":"0a1b2c3d"}),
                "{manifest}"
            );
        }
        let text = serde_json::to_string(&slot).unwrap();
        assert!(!text.contains("pgcf.io/database-id"));
        assert!(!text.contains("unit-access") && !text.contains("unit-secret"));
        let credentials = kind(&slot, "Secret");
        assert_eq!(credentials["metadata"]["name"], "archive-credentials");
        assert_eq!(
            credentials["data"],
            json!({"AWS_ACCESS_KEY_ID":STANDARD.encode("pgcf-slot-placeholder"),"AWS_SECRET_ACCESS_KEY":STANDARD.encode("pgcf-slot-placeholder")})
        );
        let store = kind(&slot, "ObjectStore");
        assert_eq!(store["metadata"]["name"], "archive");
        assert_eq!(
            store["spec"]["configuration"]["destinationPath"],
            "s3://native-controller-test/slots/0a1b2c3d/"
        );
        assert_eq!(store["spec"]["retentionPolicy"], "1d");
        assert_eq!(
            store["spec"]["configuration"]["endpointURL"],
            "https://backup.example.invalid"
        );
        let cluster = kind(&slot, "Cluster");
        assert_eq!(cluster["metadata"]["name"], "database");
        assert_eq!(
            cluster["metadata"]["annotations"],
            json!({"cnpg.io/fencedInstances":"[\"*\"]"})
        );
        let spec = &cluster["spec"];
        assert_eq!(
            spec["bootstrap"],
            json!({"initdb":{"database":"slot","owner":"slot"}})
        );
        assert_eq!(
            spec["storage"],
            json!({"storageClass":"pgcf-slot","size":"1Gi"})
        );
        assert_eq!(
            spec["affinity"],
            json!({"nodeSelector":{"kubernetes.io/hostname":"native-test-node"}})
        );
        assert_eq!(
            spec["inheritedMetadata"],
            json!({"labels":{"pgcf.io/slot":"0a1b2c3d"}})
        );
        assert_eq!(spec["managed"], json!({"roles":[]}));
        assert_eq!(spec["enableSuperuserAccess"], false);
        assert_eq!(spec["stopDelay"], 30);
        assert_eq!(spec["smartShutdownTimeout"], 0);
        assert_eq!(
            spec["plugins"],
            json!([{"name":"barman-cloud.cloudnative-pg.io","enabled":true,"isWALArchiver":true,"parameters":{"barmanObjectName":"archive","serverName":"database"}}])
        );
        // The image, the probes and the confinement of a database of the class.
        let tenant = build(
            &vector("entry-request-limit-split")["db"],
            &vector("entry-request-limit-split")["ctx"],
        )
        .unwrap();
        let database = &kind(&tenant, "Cluster")["spec"];
        assert_eq!(spec["imageName"], slot_spec().image);
        for key in ["probes", "seccompProfile", "instances"] {
            assert_eq!(spec[key], database[key], "{key}");
        }
        assert_eq!(
            spec["postgresql"]["pg_hba"],
            database["postgresql"]["pg_hba"]
        );
        assert!(slot.iter().all(|m| m["kind"] != "ScheduledBackup"));
        // The policies a database namespace has, for the slot namespace.
        for (name, kind_name) in [
            ("database-resources", "ResourceQuota"),
            ("container-defaults", "LimitRange"),
            ("default-deny", "NetworkPolicy"),
            ("gateway-ingress", "NetworkPolicy"),
            ("agent-management-ingress", "NetworkPolicy"),
            ("database-boundaries", "CiliumNetworkPolicy"),
        ] {
            let ours = slot.iter().find(|m| m["metadata"]["name"] == name).unwrap();
            let theirs = tenant
                .iter()
                .find(|m| m["metadata"]["name"] == name)
                .unwrap();
            assert_eq!(ours["kind"], kind_name);
            if kind_name != "ResourceQuota" {
                assert_eq!(ours["spec"], theirs["spec"], "{name}");
            }
        }
    }
    #[test]
    fn the_slot_requests_100m_128mi_and_limits_the_shape_and_never_labels_a_database() {
        let ctx = vector("entry-request-limit-split")["ctx"].clone();
        let slot = slot(&slot_spec(), &ctx).unwrap();
        let cluster = kind(&slot, "Cluster");
        assert_eq!(
            cluster["spec"]["resources"],
            json!({"requests":{"cpu":"100m","memory":"128Mi"},"limits":{"cpu":"500m","memory":"512Mi"}})
        );
        assert_eq!(
            cluster["spec"]["postgresql"]["parameters"],
            json!({"shared_buffers":"32MB","effective_cache_size":"256MB","max_connections":"40","archive_timeout":"60s"})
        );
        // The quota admits the claimed shape: the postgres container is resized up to its limits.
        assert_eq!(
            kind(&slot, "ResourceQuota")["spec"]["hard"]["limits.memory"],
            format!(
                "{}Mi",
                constant("QUOTA_SLOTS").as_u64().unwrap() * (512 + 512)
            )
        );
        assert!(
            slot.iter()
                .all(|m| m["metadata"]["labels"]["pgcf.io/database-id"].is_null())
        );
        // A shape or image that is not a slot's is refused.
        let mut mutable = slot_spec();
        mutable.image = "registry.example/postgres:18".into();
        assert!(super::slot(&mutable, &ctx).is_err());
        let mut named = slot_spec();
        named.hex = "0A1B2C3D".into();
        assert!(super::slot(&named, &ctx).is_err());
    }
    #[test]
    fn tenant_parts_render_role_secrets_managed_roles_and_maintenance_for_another_namespace() {
        let v = vector("role-removal-disable");
        let tenant = build(&v["db"], &v["ctx"]).unwrap();
        let parts = tenant_parts(&v["db"], &v["ctx"], "pgcf-slot-0a1b2c3d").unwrap();
        // The same Secrets and managed roles the database's own manifests hold, in the other
        // namespace and labelled for the database.
        let ours: Vec<_> = parts
            .secrets
            .iter()
            .map(|s| s["metadata"]["name"].clone())
            .collect();
        let theirs: Vec<_> = tenant
            .iter()
            .filter(|m| m["kind"] == "Secret" && m["metadata"]["name"] != "archive-credentials")
            .map(|s| s["metadata"]["name"].clone())
            .collect();
        assert_eq!(ours, theirs);
        assert!(ours.contains(&json!("maintenance-credentials")));
        for secret in &parts.secrets {
            assert_eq!(secret["metadata"]["namespace"], "pgcf-slot-0a1b2c3d");
            assert_eq!(
                secret["metadata"]["labels"]["pgcf.io/database-id"],
                v["db"]["id"]
            );
            let same = tenant
                .iter()
                .find(|m| {
                    m["kind"] == "Secret" && m["metadata"]["name"] == secret["metadata"]["name"]
                })
                .unwrap();
            assert_eq!(secret["data"], same["data"]);
            assert_eq!(secret["type"], same["type"]);
        }
        assert_eq!(parts.managed_roles, managed(&tenant));
    }
    #[test]
    fn a_role_awaiting_removal_is_disabled_then_dropped_and_never_gets_a_secret() {
        let v = vector("role-removal-disable");
        let disabled = build(&v["db"], &v["ctx"]).unwrap();
        let roles = managed(&disabled);
        assert_eq!(
            roles.iter().map(|r| r["name"].clone()).collect::<Vec<_>>(),
            [
                "reader_query",
                "later_job",
                "report_job",
                "pgcf_maintenance"
            ]
        );
        assert_eq!(
            roles[2],
            json!({"name":"report_job","ensure":"present","login":false})
        );
        let secrets: Vec<_> = disabled
            .iter()
            .filter(|m| m["kind"] == "Secret")
            .map(|m| m["metadata"]["name"].as_str().unwrap().to_string())
            .collect();
        assert!(!secrets.contains(&role_secret("report_job")), "{secrets:?}");
        assert!(secrets.contains(&role_secret("later_job")));
        // Named in the context, a removal entry is dropped; a present role or an unknown name is not.
        let mut ctx = v["ctx"].clone();
        ctx["droppingRoles"] = json!(["report_job", "reader_query", "unknown_job"]);
        let dropped = managed(&build(&v["db"], &ctx).unwrap());
        assert_eq!(dropped[2], json!({"name":"report_job","ensure":"absent"}));
        assert_eq!(dropped[0]["ensure"], "present");
        assert_eq!(dropped[0]["login"], true);
        assert_eq!(dropped.len(), roles.len());
        // A context that names a role badly is not a context.
        for invalid in [
            json!(["Upper"]),
            json!(["pg_admin"]),
            json!([1]),
            json!("report_job"),
        ] {
            let mut ctx = v["ctx"].clone();
            ctx["droppingRoles"] = invalid;
            assert!(build(&v["db"], &ctx).is_err());
        }
    }
}

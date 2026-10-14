// SPDX-License-Identifier: Apache-2.0
//! Ordered private-PID teardown. The child, original namespace descriptors and stop RPCs remain
//! owned until the fixed worker is actually reaped; an uncertain unmount is never dispatched twice.
use crate::{
    policy::Client,
    pool_guard::Active,
    pool_io::{PrivateNamespace, Process, SharedBudget},
    pool_journal::{Cleanup, Journal, State},
    pool_runtime::Payload,
    slot::Settings,
};
use pgcf_native_protocol::pool;
use serde_json::{Value, json};
use std::{
    path::Path,
    process::Stdio,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tonic::Status;
fn refused() -> Status {
    Status::failed_precondition("pool_cleanup_unconfirmed")
}
fn text<'a>(v: &'a Value, k: &str) -> Result<&'a str, Status> {
    v[k].as_str().ok_or_else(refused)
}
fn now() -> u64 {
    u64::try_from(crate::policy::now_ms()).unwrap_or(0)
}
fn reap_dispatched(
    child: &mut tokio::process::Child,
    cleanup: &mut Cleanup,
) -> Result<bool, Status> {
    if child.try_wait().map_err(|_| refused())?.is_none() || !cleanup.dispatched {
        return Ok(false);
    }
    cleanup.worker_reaped = true;
    Ok(true)
}
fn journal(state: &State) -> Result<Journal, Status> {
    Journal::open(&Path::new(crate::pool_gate::ROOT).join(format!(
        "{}.state",
        crate::pool_gate::digest(state.record.volume_handle.as_bytes())
    )))
}
fn supervisor_stopped(scope: &Value, report: &Value) -> bool {
    pool::validate("PoolSupervisorReport", report)
        && report["state"] == "stopped"
        && report["binding_id"] == scope["binding_id"]
        && pool::scope_hash(scope).as_deref() == report["scope_sha256"].as_str()
        && report["pool_pod_uid"] == scope["pool_pod_uid"]
        && report["control_state"] == "shut down"
}
pub(crate) struct Session {
    child: tokio::process::Child,
    stdout: BufReader<tokio::process::ChildStdout>,
    ready: Vec<u8>,
    payload: Payload,
    scope: Value,
    holder: Value,
    supervisor: Value,
    originals: Vec<PrivateNamespace>,
    worker: Option<Process>,
    stops: Vec<tokio::task::JoinHandle<Result<(), Status>>>,
    active: Arc<Active>,
    permission: Option<crate::pool_cleanup_permission::Permission>,
    started: Instant,
    handed: bool,
    dispatched: bool,
    failed: bool,
    reaped: bool,
    released: bool,
}
impl Session {
    pub(crate) fn start(
        settings: &Settings,
        scope: &Value,
        holder: &Value,
        supervisor: &Value,
        containers: &[crate::pool_custody::Container],
        active: Arc<Active>,
    ) -> Result<Self, Status> {
        if !supervisor_stopped(scope, supervisor)
            || !active.current()
            || holder["binding_id"] != scope["binding_id"]
            || holder["holder_boot_id"] != scope["boot_id"]
            || holder["scope_sha256"] != pool::scope_hash(scope).ok_or_else(refused)?
            || !matches!(
                holder["state"].as_str(),
                Some("detaching" | "failed" | "lost")
            )
            || holder["cleanup_intent"]["operation_id"].as_str().is_none()
        {
            return Err(refused());
        }
        let expected = scope["container_ids"].as_array().ok_or_else(refused)?;
        let own = containers
            .iter()
            .filter(|c| c.pod_uid == scope["pool_pod_uid"])
            .collect::<Vec<_>>();
        if own.len() != expected.len()
            || own
                .iter()
                .any(|c| !expected.iter().any(|id| *id == c.process.container_id))
        {
            return Err(refused());
        }
        let originals = own
            .iter()
            .map(|c| c.process.private_namespace())
            .collect::<Result<Vec<_>, _>>()?;
        let main = own
            .iter()
            .find(|c| c.process.container_id == scope["container_id"])
            .ok_or_else(refused)?;
        let current = active.snapshot()?;
        let payload = Payload::create(&crate::pool_cleanup_worker::Request {
            v: 1,
            settings: settings.clone(),
            scope: scope.clone(),
            main_pid: main.process.pid,
            storage_authority: current.token,
        })?;
        let executable = std::env::current_exe().map_err(|_| refused())?;
        if crate::policy::digest(&executable)? != text(scope, "host_controller_sha256")? {
            return Err(refused());
        }
        let mut child = tokio::process::Command::new(executable)
            .arg("--pool-cleanup-worker")
            .arg(&payload.path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| refused())?;
        let stdout = BufReader::new(child.stdout.take().ok_or_else(refused)?);
        Ok(Self {
            child,
            stdout,
            ready: vec![],
            payload,
            scope: scope.clone(),
            holder: holder.clone(),
            supervisor: supervisor.clone(),
            originals,
            worker: None,
            stops: vec![],
            active,
            permission: None,
            started: Instant::now(),
            handed: false,
            dispatched: false,
            failed: false,
            reaped: false,
            released: false,
        })
    }
    fn fail(&mut self) {
        self.failed = true;
        let _ = self.active.revoke();
        let _ = self.child.start_kill();
    }
    /// Polling this retained owner never awaits a Stop RPC while its exact leaf contains the worker.
    pub(crate) async fn poll(
        &mut self,
        settings: &Settings,
        client: &Client,
        state: &State,
    ) -> Result<bool, Status> {
        let result = self.advance(settings, client, state).await;
        if !self.reaped
            && result
                .as_ref()
                .is_err_and(|e| e.code() != tonic::Code::Unavailable)
        {
            self.fail();
        }
        result
    }
    async fn advance(
        &mut self,
        settings: &Settings,
        client: &Client,
        original_state: &State,
    ) -> Result<bool, Status> {
        if self.released {
            return self.metadata_retired(settings).await;
        }
        let journal = journal(original_state)?;
        if self.failed {
            // A failed command is never replayed. Its actual reap may still permit the existing
            // no-write reference-destruction observation after a fresh complete physical survey.
            return self.finish_after_worker(settings, client, &journal).await;
        }
        if !self.dispatched && self.started.elapsed() > Duration::from_secs(60) {
            return Err(refused());
        }
        if self.worker.is_none() {
            let read = tokio::time::timeout(
                Duration::from_millis(10),
                self.stdout.read_until(b'\n', &mut self.ready),
            )
            .await;
            if self.ready.len() > 8192 {
                return Err(refused());
            }
            match read {
                Err(_) => return Ok(false),
                Ok(Err(_)) | Ok(Ok(0)) => return Err(refused()),
                Ok(Ok(_)) => {}
            }
            let ready: crate::pool_cleanup_worker::Ready =
                serde_json::from_slice(&self.ready).map_err(|_| refused())?;
            let pid = self.child.id().ok_or_else(refused)?;
            let worker = Process::capture(
                pid,
                text(&self.scope, "pool_pod_uid")?,
                text(&self.scope, "container_id")?,
            )?;
            if ready.v != 1
                || ready.pid != pid
                || ready.start_ticks != worker.start_ticks
                || ready.pid_namespace != worker.pid_namespace.inode
                || ready.cgroup_inode != worker.cgroup_inode
                || crate::policy::digest(Path::new(&format!("/proc/{pid}/exe")))?
                    != text(&self.scope, "host_controller_sha256")?
            {
                return Err(refused());
            }
            let host = crate::pool_io::host_pids(std::slice::from_ref(&worker))?;
            let profile = &self.scope["storage"]["profile"];
            let worker_value = json!({"container_id":worker.container_id,"cgroup_inode":worker.cgroup_inode,"pid":host.get(&pid).ok_or_else(refused)?,
                "start_ticks":worker.start_ticks,"pid_namespace":worker.pid_namespace.inode,"device_major":libc::major(original_state.device),"device_minor":libc::minor(original_state.device),
                "write_bytes_per_second":profile["write_bytes_per_second"],"write_iops_per_second":profile["write_iops_per_second"],"io_max_verified":true,
                "pool_pod_uid":self.scope["pool_pod_uid"],"executable_sha256":self.scope["host_controller_sha256"]});
            let bps = profile["write_bytes_per_second"]
                .as_u64()
                .ok_or_else(refused)?;
            let iops = profile["write_iops_per_second"]
                .as_u64()
                .ok_or_else(refused)?;
            if !worker.io_matches(original_state.device, bps, iops)? {
                return Err(refused());
            }
            let mut state = journal.read()?.ok_or_else(refused)?;
            if state.cleanup.is_some() {
                return Err(refused());
            }
            state.cleanup = Some(Cleanup {
                holder: self.holder.clone(),
                supervisor_report: self.supervisor.clone(),
                worker: worker_value,
                worker_caller_pid: pid,
                io: None,
                authority: None,
                dispatched: false,
                nonlazy_completed: false,
                worker_reaped: false,
                write_bytes_before: None,
                write_bytes_after: None,
            });
            journal.store(&state)?;
            self.worker = Some(worker);
            let channel = crate::transport::connect(&settings.containerd_socket).await?;
            for id in &state.container_ids {
                let id = id.clone();
                let channel = channel.clone();
                self.stops.push(tokio::spawn(async move {
                    crate::cri::runtime_service_client::RuntimeServiceClient::new(channel)
                        .stop_container(crate::cri::StopContainerRequest {
                            container_id: id,
                            timeout: 1,
                        })
                        .await?;
                    Ok(())
                }));
            }
        }
        if !self.handed {
            for original in &self.originals {
                if !original.stopped()? {
                    return Ok(false);
                }
            }
            let stopped = std::mem::take(&mut self.originals)
                .into_iter()
                .map(|p| p.confirm())
                .collect::<Result<Vec<_>, _>>()?;
            let worker = self.worker.take().ok_or_else(refused)?;
            // Keep an independently captured parent observation; Active owns the actual guard handle.
            let retained = Process::capture(
                worker.pid,
                text(&self.scope, "pool_pod_uid")?,
                text(&self.scope, "container_id")?,
            )?;
            self.active.handoff_cleanup(stopped, worker)?;
            self.worker = Some(retained);
            self.handed = true;
        }
        if !self.dispatched {
            let worker = self.worker.as_ref().ok_or_else(refused)?;
            worker.recheck()?;
            crate::pool_io::CapturedGroup::restore(&worker.group_record())?
                .only_process(worker.pid)?;
            let shared = SharedBudget::capture(std::slice::from_ref(worker))?;
            let mut state = journal.read()?.ok_or_else(refused)?;
            let cleanup = state.cleanup.as_ref().ok_or_else(refused)?;
            let profile = &self.scope["storage"]["profile"];
            let bps = profile["write_bytes_per_second"]
                .as_u64()
                .ok_or_else(refused)?;
            let iops = profile["write_iops_per_second"]
                .as_u64()
                .ok_or_else(refused)?;
            if !worker.io_matches(state.device, bps, iops)?
                || !shared.io_matches(state.device, bps, iops)?
            {
                return Err(refused());
            }
            let io = if let Some(io) = &cleanup.io {
                io.clone()
            } else {
                let value = json!({"v":1,"binding_id":state.binding_id,"scope_sha256":state.record.scope_sha256,"holder_revision":self.holder["holder_revision"],
                    "operation_id":self.holder["cleanup_intent"]["operation_id"],"holder_generation":self.scope["generation"],"database_generation":self.holder["cleanup_intent"]["database_generation"],
                    "node_uid":state.node_uid,"boot_id":state.boot_id,"observed_at":now(),"device":self.holder["device"],
                    "shared_pod_io":{"pod_cgroup_inode":shared.pod_cgroup_inode,"device_major":libc::major(state.device),"device_minor":libc::minor(state.device),
                        "write_bytes_per_second":bps,"write_iops_per_second":iops,"io_max_verified":true,"all_writer_cgroups_descendants":true},
                    "worker":cleanup.worker,"stopped_writers":state.groups.iter().map(|g|json!({"container_id":g.container_id,"cgroup_inode":g.cgroup_inode,"tenant_tasks_remaining":0})).collect::<Vec<_>>(),
                    "cleanup_worker_only_verified":true});
                if !pool::validate("PoolCleanupIoAttestation", &value) {
                    return Err(refused());
                }
                state.cleanup.as_mut().ok_or_else(refused)?.io = Some(value.clone());
                journal.store(&state)?;
                value
            };
            client.report_pool("PoolCleanupIoAttestation", &io).await?;
            let lease = client.storage_lease().await?;
            if lease.node_uid != state.node_uid
                || lease.boot_id.as_deref() != Some(state.boot_id.as_str())
                || lease.expires_at <= now()
            {
                return Err(refused());
            }
            let holder = lease
                .databases
                .iter()
                .filter_map(|e| e.pool.as_ref())
                .find(|h| h["binding_id"] == state.binding_id)
                .ok_or_else(refused)?;
            if holder["cleanup_authority"].is_null() {
                return Ok(false);
            }
            let permission = crate::pool_cleanup_permission::Permission::new(
                &self.scope,
                holder,
                &io,
                client.local(),
            )?;
            self.payload.grant(&crate::pool_cleanup_worker::Grant {
                v: 1,
                holder: holder.clone(),
                io: io.clone(),
                worker_caller_pid: worker.pid,
            })?;
            state = state.dispatch_detach()?;
            let cleanup = state.cleanup.as_mut().ok_or_else(refused)?;
            cleanup.authority = Some(permission.token().to_owned());
            cleanup.dispatched = true;
            journal.store(&state)?;
            self.active.grant_cleanup(permission.clone())?;
            self.permission = Some(permission);
            self.dispatched = true;
            let mut stdin = self.child.stdin.take().ok_or_else(refused)?;
            stdin.write_all(b"execute\n").await.map_err(|_| refused())?;
            drop(stdin);
        }
        self.finish_after_worker(settings, client, &journal).await
    }
    async fn finish_after_worker(
        &mut self,
        settings: &Settings,
        client: &Client,
        journal: &Journal,
    ) -> Result<bool, Status> {
        let mut state = journal.read()?.ok_or_else(refused)?;
        if state.cleanup.as_ref().is_none_or(|c| !c.dispatched) {
            if self.child.try_wait().map_err(|_| refused())?.is_some() {
                self.reaped = true;
            }
            return Ok(false);
        }
        if !self.reaped {
            if !reap_dispatched(&mut self.child, state.cleanup.as_mut().ok_or_else(refused)?)? {
                return Ok(false);
            }
            journal.store(&state)?;
            self.reaped = true;
        }
        if self.stops.iter().any(|s| !s.is_finished()) {
            return Ok(false);
        }
        for stop in self.stops.drain(..) {
            stop.await.map_err(|_| refused())??;
        }
        if !crate::pool_recovery::finish_cleanup(settings, client, journal, Some(&self.active))
            .await?
        {
            return Ok(false);
        }
        self.released = true;
        self.metadata_retired(settings).await
    }
    /// CF terminal ACK and physical release already completed. Keep the exact local exclusion
    /// until the controller removes CRI records; absence here retires bookkeeping only.
    async fn metadata_retired(&self, settings: &Settings) -> Result<bool, Status> {
        use crate::containerd::services::containers::v1 as containers;
        let channel = crate::transport::connect(&settings.containerd_socket).await?;
        let listed = containers::containers_client::ContainersClient::new(channel)
            .list(crate::transport::namespaced(
                containers::ListContainersRequest { filters: vec![] },
                &settings.namespace,
            )?)
            .await?
            .into_inner()
            .containers;
        if listed.len() > 10000 {
            return Err(refused());
        }
        let ids = self.scope["container_ids"].as_array().ok_or_else(refused)?;
        let mut present = false;
        for container in listed {
            if !ids.iter().any(|id| *id == container.id) {
                continue;
            }
            let spec = container
                .spec
                .as_ref()
                .filter(|s| s.value.len() <= 512 * 1024)
                .ok_or_else(refused)?;
            let spec: Value = serde_json::from_slice(&spec.value).map_err(|_| refused())?;
            if spec["annotations"]["io.kubernetes.cri.sandbox-uid"] != self.scope["pool_pod_uid"] {
                return Err(refused());
            }
            present = true;
        }
        Ok(!present)
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        if !self.reaped {
            self.fail();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn failed_dispatch_becomes_recoverable_only_after_actual_child_reap() {
        let mut cleanup = Cleanup {
            holder: Value::Null,
            supervisor_report: Value::Null,
            worker: Value::Null,
            worker_caller_pid: 1,
            io: None,
            authority: None,
            dispatched: true,
            nonlazy_completed: false,
            worker_reaped: false,
            write_bytes_before: None,
            write_bytes_after: None,
        };
        let mut child = tokio::process::Command::new("/bin/sh")
            .args(["-c", "exec sleep 30"])
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        assert!(!reap_dispatched(&mut child, &mut cleanup).unwrap());
        assert!(!cleanup.worker_reaped);
        child.start_kill().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !reap_dispatched(&mut child, &mut cleanup).unwrap() {
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(cleanup.worker_reaped);
        cleanup.dispatched = false;
        cleanup.worker_reaped = false;
        assert!(!reap_dispatched(&mut child, &mut cleanup).unwrap());
        assert!(
            !cleanup.worker_reaped,
            "a reaped predispatch worker cannot invent cleanup dispatch"
        );
    }
}

// SPDX-License-Identifier: Apache-2.0
//! Separate CF sa1 clock for the actual ordinary pool Pod. PB1 never permits physical writes.
use crate::{
    pool_device::{Backend, Device},
    pool_io::{Process, SharedBudget},
};
use pgcf_native_protocol::{
    pool,
    storage::{StorageTrust, VerifiedStorageAuthority},
};
use serde_json::Value;
use std::{
    collections::BTreeSet,
    time::{Duration, Instant},
};
use tonic::Status;
fn refused() -> Status {
    Status::failed_precondition("pool_thin_write_authority_unconfirmed")
}
fn now() -> u64 {
    u64::try_from(crate::policy::now_ms()).unwrap_or(0)
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str, Status> {
    v[key].as_str().ok_or_else(refused)
}
fn number(v: &Value, key: &str) -> Result<u64, Status> {
    v[key].as_u64().ok_or_else(refused)
}
pub struct Armed {
    scope: Value,
    token: String,
    authority: VerifiedStorageAuthority,
    processes: Vec<Process>,
    device: u64,
    received: Instant,
    remaining: Duration,
    expiry_latched: bool,
    physical_quiesced: bool,
    shared: SharedBudget,
}
impl Armed {
    pub fn arm(
        trust: &StorageTrust,
        scope: &Value,
        token: &str,
        node_uid: &str,
        processes: Vec<Process>,
    ) -> Result<Self, Status> {
        let received = Instant::now();
        let current = now();
        let authority = pool::verify_pool_storage_authority(trust, token, scope, current)
            .ok_or_else(refused)?;
        if text(scope, "node_uid")? != node_uid
            || text(scope, "boot_id")? != crate::storage::current_boot_id()?
            || scope["storage"]["backend"] != "lvm-thin-v1"
        {
            return Err(refused());
        }
        let storage = &scope["storage"];
        let profile = &storage["profile"];
        let device = Device::verify(
            text(storage, "volume_group_uuid")?,
            text(storage, "lv_uuid")?,
            text(storage, "volume_handle")?,
            Backend::Thin {
                pool_uuid: text(profile, "pool_uuid")?.to_owned(),
                thin_id: number(storage, "thin_id")?
                    .try_into()
                    .map_err(|_| refused())?,
            },
        )
        .map_err(|_| refused())?;
        let expected = scope["container_ids"]
            .as_array()
            .ok_or_else(refused)?
            .iter()
            .map(|id| id.as_str().ok_or_else(refused))
            .collect::<Result<BTreeSet<_>, _>>()?;
        let actual = processes
            .iter()
            .map(|p| p.container_id.as_str())
            .collect::<BTreeSet<_>>();
        if actual != expected
            || actual.len() != processes.len()
            || !actual.contains(text(scope, "container_id")?)
        {
            return Err(refused());
        }
        for process in &processes {
            if !process.io_matches(
                device.device(),
                number(profile, "write_bytes_per_second")?,
                number(profile, "write_iops_per_second")?,
            )? {
                return Err(refused());
            }
        }
        let shared = SharedBudget::capture(&processes)?;
        if !shared.io_matches(
            device.device(),
            number(profile, "write_bytes_per_second")?,
            number(profile, "write_iops_per_second")?,
        )? {
            return Err(refused());
        }
        let remaining = Duration::from_millis(authority.claims().exp.saturating_sub(current));
        if received.elapsed() >= remaining || now() >= authority.claims().exp {
            return Err(refused());
        }
        Ok(Self {
            scope: scope.clone(),
            token: token.to_owned(),
            authority,
            processes,
            device: device.device(),
            received,
            remaining,
            expiry_latched: false,
            physical_quiesced: false,
            shared,
        })
    }
    pub fn refresh(&mut self, trust: &StorageTrust, token: &str) -> Result<(), Status> {
        if !self.permits() {
            self.expiry_latched = true;
            return Err(refused());
        }
        let received = Instant::now();
        let current = now();
        let next = pool::verify_pool_storage_authority(trust, token, &self.scope, current)
            .ok_or_else(refused)?;
        let old = self.authority.claims();
        let new = next.claims();
        if self.expiry_latched
            || new.authority_revision < old.authority_revision
            || (new.authority_revision == old.authority_revision && new != old)
        {
            return Err(refused());
        }
        let mut remaining = Duration::from_millis(new.exp.saturating_sub(current));
        if new.authority_revision == old.authority_revision {
            remaining = remaining.min(self.remaining.saturating_sub(self.received.elapsed()))
        }
        for p in &self.processes {
            p.recheck()?;
            if !p.io_matches(
                self.device,
                number(&self.scope["storage"]["profile"], "write_bytes_per_second")?,
                number(&self.scope["storage"]["profile"], "write_iops_per_second")?,
            )? {
                return Err(refused());
            }
        }
        if !self.shared.io_matches(
            self.device,
            number(&self.scope["storage"]["profile"], "write_bytes_per_second")?,
            number(&self.scope["storage"]["profile"], "write_iops_per_second")?,
        )? {
            return Err(refused());
        }
        if !self.permits() || received.elapsed() >= remaining || now() >= new.exp {
            self.expiry_latched = true;
            return Err(refused());
        }
        self.authority = next;
        self.token = token.to_owned();
        self.remaining = remaining;
        self.received = received;
        Ok(())
    }
    pub fn permits(&self) -> bool {
        !self.expiry_latched
            && now() < self.authority.claims().exp
            && self.received.elapsed() < self.remaining
    }
    pub fn expires_at(&self) -> u64 {
        self.authority.claims().exp
    }
    pub fn authority_revision(&self) -> u64 {
        self.authority.claims().authority_revision
    }
    pub fn token(&self) -> &str {
        &self.token
    }
    /// Expiry blocks the entire verified thin device before stopping the exact writer groups.
    pub fn protect(&mut self) -> Result<(), Status> {
        if self.permits() {
            return Ok(());
        }
        self.expiry_latched = true;
        crate::storage_dm::suspend(&self.authority)?;
        self.physical_quiesced = true;
        // A dead/recycled PID never authorizes a different cgroup; failure leaves physical IO suspended.
        for process in &self.processes {
            if process.populated()? {
                process.stop_group()?
            }
        }
        Ok(())
    }
    pub fn protected(&self) -> bool {
        self.physical_quiesced
    }
    pub fn revoke(&mut self) -> Result<(), Status> {
        self.expiry_latched = true;
        self.protect()
    }
    pub fn cgroups(&self) -> &[Process] {
        &self.processes
    }
    pub fn device(&self) -> u64 {
        self.device
    }
    pub fn scope(&self) -> &Value {
        &self.scope
    }
    pub(crate) fn io_proof(&self) -> Result<Value, Status> {
        let profile = &self.scope["storage"]["profile"];
        let bps = number(profile, "write_bytes_per_second")?;
        let iops = number(profile, "write_iops_per_second")?;
        if !self.shared.io_matches(self.device, bps, iops)? {
            return Err(refused());
        }
        let host_pids = crate::pool_io::host_pids(&self.processes)?;
        let cgroups=self.processes.iter().map(|process|{
            process.recheck()?;if !process.io_matches(self.device,bps,iops)?{return Err(refused())}
            Ok(serde_json::json!({"container_id":process.container_id,"cgroup_inode":process.cgroup_inode,"pid":host_pids.get(&process.pid).ok_or_else(refused)?,"start_ticks":process.start_ticks,"pid_namespace":process.pid_namespace.inode,"device_major":libc::major(self.device),"device_minor":libc::minor(self.device),"write_bytes_per_second":bps,"write_iops_per_second":iops,"io_max_verified":true}))
        }).collect::<Result<Vec<_>,Status>>()?;
        Ok(
            serde_json::json!({"authority_token":self.token,"authority_revision":self.authority_revision(),"expires_at":self.expires_at(),"protect_on_expiry_armed":true,"shared_pod_io":{"pod_cgroup_inode":self.shared.pod_cgroup_inode,"device_major":libc::major(self.device),"device_minor":libc::minor(self.device),"write_bytes_per_second":bps,"write_iops_per_second":iops,"io_max_verified":true,"all_writer_cgroups_descendants":true},"cgroups":cgroups}),
        )
    }
}
/// The only caller that emits an armed-expiry proof owns a live independent local clock task.
pub struct Active {
    inner: std::sync::Arc<std::sync::Mutex<Armed>>,
    clock: tokio::task::JoinHandle<()>,
}
/// An immutable copy permits no refresh/resume and holds no lock over a slow peer operation.
pub struct Current {
    pub scope: Value,
    pub token: String,
    pub device: u64,
    pub expires_at: u64,
}
impl Active {
    pub fn start(armed: Armed) -> Self {
        let inner = std::sync::Arc::new(std::sync::Mutex::new(armed));
        let clock_guard = inner.clone();
        let clock = tokio::spawn(async move {
            loop {
                let result = clock_guard
                    .lock()
                    .map_err(|_| refused())
                    .and_then(|mut guard| guard.protect());
                if result.is_err() {
                    eprintln!("pool_expiry_protection_unconfirmed")
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        });
        Self { inner, clock }
    }
    pub fn current(&self) -> bool {
        !self.clock.is_finished() && self.inner.lock().is_ok_and(|guard| guard.permits())
    }
    pub fn refresh(&self, trust: &StorageTrust, token: &str) -> Result<(), Status> {
        if self.clock.is_finished() {
            self.revoke()?;
            return Err(refused());
        }
        self.inner
            .lock()
            .map_err(|_| refused())?
            .refresh(trust, token)
    }
    pub fn revoke(&self) -> Result<(), Status> {
        self.inner.lock().map_err(|_| refused())?.revoke()
    }
    pub fn proof(&self) -> Result<Value, Status> {
        if !self.current() {
            return Err(refused());
        }
        self.inner.lock().map_err(|_| refused())?.io_proof()
    }
    pub fn snapshot(&self) -> Result<Current, Status> {
        if self.clock.is_finished() {
            return Err(refused());
        }
        let guard = self.inner.lock().map_err(|_| refused())?;
        if !guard.permits() {
            return Err(refused());
        }
        Ok(Current {
            scope: guard.scope.clone(),
            token: guard.token.clone(),
            device: guard.device,
            expires_at: guard.expires_at(),
        })
    }
}
impl Drop for Active {
    fn drop(&mut self) {
        let _ = self.revoke();
        self.clock.abort();
    }
}

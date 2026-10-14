// SPDX-License-Identifier: Apache-2.0
//! Durable mount intent. A lost reply or a process restart never makes an old mount replayable.
use crate::{pool_gate::Record, pool_mount::MountIdentity};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};
use tonic::Status;
fn refused() -> Status {
    Status::failed_precondition("pool_mount_journal_unconfirmed")
}
fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Prepared,
    MountDispatched,
    Mounted,
    DetachDispatched,
    Detached,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct State {
    pub v: u8,
    pub record: Record,
    pub binding_id: String,
    pub node_uid: String,
    pub boot_id: String,
    pub pool_pod_uid: String,
    pub container_ids: Vec<String>,
    pub phase: Phase,
    pub ever_attached: bool,
    pub device: u64,
    pub mount_id: Option<u64>,
    pub authority_revision: u64,
    // Private on-disk protection identity only. Neither PB1 nor this historical token grants resume.
    pub storage_authority: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub io_attestation: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub groups: Vec<GroupRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_report: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub terminal_history: Vec<serde_json::Value>,
    #[serde(default)]
    pub terminal_acknowledged: bool,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GroupRecord {
    pub pod_uid: String,
    pub container_id: String,
    pub cgroup_inode: u64,
    pub relative: String,
}
pub struct Journal {
    path: PathBuf,
    directory: File,
}
impl Journal {
    pub fn open(path: &Path) -> Result<Self, Status> {
        let parent = path.parent().ok_or_else(refused)?;
        if !path.is_absolute() || fs::canonicalize(parent).map_err(|_| refused())? != parent {
            return Err(refused());
        }
        let directory = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(parent)
            .map_err(|_| refused())?;
        let meta = directory.metadata().map_err(|_| refused())?;
        if meta.uid() != 0
            || !meta.is_dir()
            || meta.mode() & 0o7777 != 0o700
            || path.file_name().and_then(|n| n.to_str()).is_none_or(|n| {
                n.len() != 70
                    || !n.ends_with(".state")
                    || !n[..64]
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
        {
            return Err(refused());
        }
        Ok(Self {
            path: path.to_owned(),
            directory,
        })
    }
    pub fn read(&self) -> Result<Option<State>, Status> {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&self.path);
        let file = match file {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(refused()),
        };
        let meta = file.metadata().map_err(|_| refused())?;
        if !meta.is_file()
            || meta.uid() != 0
            || meta.mode() & 0o7777 != 0o600
            || meta.nlink() != 1
            || meta.len() > 131072
        {
            return Err(refused());
        }
        let mut bytes = Vec::new();
        file.take(131073)
            .read_to_end(&mut bytes)
            .map_err(|_| refused())?;
        if bytes.len() > 131072 {
            return Err(refused());
        }
        let state: State = serde_json::from_slice(&bytes).map_err(|_| refused())?;
        state.valid()?;
        Ok(Some(state))
    }
    pub fn store(&self, next: &State) -> Result<(), Status> {
        next.valid()?;
        if let Some(previous) = self.read()? {
            previous.successor(next)?
        } else if next.phase != Phase::Prepared || next.ever_attached {
            return Err(refused());
        }
        let bytes = serde_json::to_vec(next).map_err(|_| refused())?;
        if bytes.len() > 131072 {
            return Err(refused());
        }
        let temporary = self
            .path
            .with_extension(format!("state.{}.pending", std::process::id()));
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(&temporary)
                .map_err(|_| refused())?;
            file.write_all(&bytes).map_err(|_| refused())?;
            file.sync_all().map_err(|_| refused())?;
            fs::rename(&temporary, &self.path).map_err(|_| refused())?;
            self.directory.sync_all().map_err(|_| refused())?;
            Ok(())
        })();
        let _ = fs::remove_file(temporary);
        result
    }
    /// Called while holding the same CSI lock after durable deny removal. A lost unlink reply
    /// is harmless: only a persisted, exact Cloudflare terminal acknowledgment is retireable.
    pub(crate) fn retire_acknowledged(&self) -> Result<(), Status> {
        let state = self.read()?.ok_or_else(refused)?;
        if state.phase != Phase::Detached || !state.terminal_acknowledged {
            return Err(refused());
        }
        fs::remove_file(&self.path).map_err(|_| refused())?;
        self.directory.sync_all().map_err(|_| refused())
    }
}
impl State {
    pub fn valid(&self) -> Result<(), Status> {
        self.record.bytes()?;
        if self.v != 1
            || !uuid(&self.binding_id)
            || !uuid(&self.node_uid)
            || !uuid(&self.boot_id)
            || !uuid(&self.pool_pod_uid)
            || self.container_ids.is_empty()
            || self.container_ids.len() > 4
            || self.container_ids.iter().any(|id| {
                id.len() != 64
                    || !id
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
            || self
                .container_ids
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != self.container_ids.len()
            || self.device == 0
            || self.mount_id.is_some_and(|id| id == 0)
            || self.authority_revision == 0
            || self
                .storage_authority
                .as_ref()
                .is_some_and(|s| s.len() > 32768)
        {
            return Err(refused());
        }
        if (self.phase == Phase::Mounted && (self.mount_id.is_none() || !self.ever_attached))
            || (self.phase == Phase::Prepared && (self.ever_attached || self.mount_id.is_some()))
            || (self.phase == Phase::Detached && self.mount_id.is_some())
        {
            return Err(refused());
        }
        if let Some(scope) = &self.scope
            && (crate::pool_gate::digest(&serde_json::to_vec(scope).map_err(|_| refused())?)
                != self.record.scope_sha256
                || scope["binding_id"] != self.binding_id
                || scope["pool_pod_uid"] != self.pool_pod_uid
                || scope["node_uid"] != self.node_uid
                || scope["boot_id"] != self.boot_id
                || scope["storage"]["volume_handle"] != self.record.volume_handle
                || scope["container_ids"] != serde_json::json!(self.container_ids))
        {
            return Err(refused());
        }
        if let Some(io) = &self.io_attestation
            && (self.scope.is_none()
                || io["scope_sha256"] != self.record.scope_sha256
                || io["binding_id"] != self.binding_id
                || io["boot_id"] != self.boot_id
                || io["pool_pod_uid"] != self.pool_pod_uid)
        {
            return Err(refused());
        }
        if self.terminal_history.len() > 32
            || (self.terminal_acknowledged && self.terminal_report.is_none())
            || self
                .terminal_report
                .as_ref()
                .is_some_and(|r| !self.terminal_history.contains(r))
            || (self.terminal_report.is_none() && !self.terminal_history.is_empty())
        {
            return Err(refused());
        }
        for report in &self.terminal_history {
            if self.phase != Phase::Detached
                || report["binding_id"] != self.binding_id
                || report["scope_sha256"] != self.record.scope_sha256
                || report["node_uid"] != self.node_uid
                || report["pool_pod_uid"] != self.pool_pod_uid
                || !matches!(report["state"].as_str(), Some("released" | "refused"))
                || !report["kernel_proof"]["mount_id"].is_null()
                || report["kernel_proof"]["dm_open_count"] != 0
                || report["kernel_proof"]["foreign_mounts"] != 0
                || report["kernel_proof"]["named_namespace_scan_complete"] != true
            {
                return Err(refused());
            }
        }
        Ok(())
    }
    fn successor(&self, next: &Self) -> Result<(), Status> {
        if self.record != next.record
            || self.binding_id != next.binding_id
            || self.node_uid != next.node_uid
            || self.boot_id != next.boot_id
            || self.pool_pod_uid != next.pool_pod_uid
            || self.container_ids != next.container_ids
            || self.device != next.device
            || self.scope != next.scope
            || self.io_attestation != next.io_attestation
            || self.groups != next.groups
            || !next.terminal_history.starts_with(&self.terminal_history)
            || (self.terminal_acknowledged
                && (!next.terminal_acknowledged
                    || self.terminal_report != next.terminal_report
                    || self.terminal_history != next.terminal_history))
            || (!self.terminal_acknowledged
                && next.terminal_acknowledged
                && (self.terminal_history != next.terminal_history
                    || next
                        .terminal_report
                        .as_ref()
                        .is_none_or(|r| !self.terminal_history.contains(r))))
            || next.authority_revision < self.authority_revision
            || (self.ever_attached && !next.ever_attached)
        {
            return Err(refused());
        }
        let allowed = matches!(
            (self.phase, next.phase),
            (
                Phase::Prepared,
                Phase::Prepared | Phase::MountDispatched | Phase::Detached
            ) | (
                Phase::MountDispatched,
                Phase::Mounted | Phase::DetachDispatched | Phase::Detached
            ) | (Phase::Mounted, Phase::Mounted | Phase::DetachDispatched)
                | (
                    Phase::DetachDispatched,
                    Phase::DetachDispatched | Phase::Detached
                )
                | (Phase::Detached, Phase::Detached)
        );
        if !allowed
            || ((self.phase == Phase::Mounted || self.phase == Phase::DetachDispatched)
                && next.phase != Phase::Detached
                && self.mount_id != next.mount_id)
        {
            return Err(refused());
        }
        Ok(())
    }
    pub fn dispatch_mount(&self) -> Result<Self, Status> {
        if self.phase != Phase::Prepared {
            return Err(refused());
        }
        let mut next = self.clone();
        next.phase = Phase::MountDispatched;
        Ok(next)
    }
    pub fn mounted(&self, identity: MountIdentity) -> Result<Self, Status> {
        if self.phase != Phase::MountDispatched
            || identity.device != self.device
            || identity.mount_id == 0
        {
            return Err(refused());
        }
        let mut next = self.clone();
        next.phase = Phase::Mounted;
        next.ever_attached = true;
        next.mount_id = Some(identity.mount_id);
        Ok(next)
    }
    pub fn dispatch_detach(&self) -> Result<Self, Status> {
        if !matches!(
            self.phase,
            Phase::MountDispatched | Phase::Mounted | Phase::DetachDispatched
        ) {
            return Err(refused());
        }
        let mut next = self.clone();
        next.phase = Phase::DetachDispatched;
        Ok(next)
    }
    /// This transition consumes an actual kernel zero proof; it cannot authorize a subsequent mount.
    pub fn detached(&self, zero: &crate::pool_device::ZeroDevice) -> Result<Self, Status> {
        if zero.uuid != self.record.device_uuid
            || zero.handle != self.record.volume_handle
            || !zero.still_zero().map_err(|_| refused())?
        {
            return Err(refused());
        }
        let mut next = self.clone();
        next.phase = Phase::Detached;
        next.mount_id = None;
        Ok(next)
    }
    pub fn terminal(&self, report: serde_json::Value) -> Result<Self, Status> {
        if self.phase != Phase::Detached || self.terminal_acknowledged {
            return Err(refused());
        }
        let mut next = self.clone();
        if !next.terminal_history.contains(&report) {
            next.terminal_history.push(report.clone());
        }
        next.terminal_report = Some(report);
        next.valid()?;
        Ok(next)
    }
    /// An HTTP success or missing snapshot entry is insufficient: retained details must contain
    /// this exact durable report and the corresponding immutable terminal binding.
    pub fn acknowledge(&self, details: &serde_json::Value) -> Result<Self, Status> {
        let report = self
            .terminal_history
            .iter()
            .find(|r| **r == details["node_report"])
            .ok_or_else(refused)?;
        let desired = &details["binding"];
        let binding = &desired["binding"];
        if self.phase != Phase::Detached
            || desired["authority"] != "revoked"
            || !desired["permission"].is_null()
            || !desired["storage_authority"].is_null()
            || self.scope.as_ref() != Some(&binding["scope"])
            || binding["scope_sha256"] != self.record.scope_sha256
            || binding["state"] != report["state"]
            || details["node_report"] != *report
        {
            return Err(refused());
        }
        let mut next = self.clone();
        next.terminal_report = Some(report.clone());
        next.terminal_acknowledged = true;
        next.valid()?;
        Ok(next)
    }
}

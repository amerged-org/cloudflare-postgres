// SPDX-License-Identifier: Apache-2.0
//! Actual CSI executable and shared gate directory, independent of Pod annotations or OCI labels.
use crate::{
    containerd::services::{containers::v1 as containers, tasks::v1 as tasks},
    cri,
    pool_gate::ROOT,
    slot::{self, Settings},
    transport,
};
use std::{fs::File, os::unix::fs::MetadataExt};
use tonic::Status;
fn refused() -> Status {
    Status::failed_precondition("pool_csi_driver_custody_unconfirmed")
}
pub struct Driver {
    pub container_id: String,
    pub pod_uid: String,
    pub pid: u32,
    pub start_ticks: u64,
    pub executable_sha256: String,
    gate_device: u64,
    gate_inode: u64,
}
impl Driver {
    pub fn recheck(&self) -> Result<(), Status> {
        if slot::start_ticks(self.pid)? != self.start_ticks
            || crate::policy::digest(std::path::Path::new(&format!("/proc/{}/exe", self.pid)))?
                != self.executable_sha256
        {
            return Err(refused());
        }
        let own = File::open(ROOT)
            .map_err(|_| refused())?
            .metadata()
            .map_err(|_| refused())?;
        let driver = File::open(format!("/proc/{}/root{ROOT}", self.pid))
            .map_err(|_| refused())?
            .metadata()
            .map_err(|_| refused())?;
        if own.dev() != self.gate_device
            || own.ino() != self.gate_inode
            || driver.dev() != own.dev()
            || driver.ino() != own.ino()
            || driver.uid() != 0
            || driver.mode() & 0o7777 != 0o700
        {
            return Err(refused());
        }
        Ok(())
    }
}
pub async fn verify(
    settings: &Settings,
    image: &str,
    executable_sha256: &str,
) -> Result<Driver, Status> {
    if !image.contains("@sha256:") || executable_sha256.len() != 64 {
        return Err(refused());
    }
    let channel = transport::connect(&settings.containerd_socket).await?;
    let listed = containers::containers_client::ContainersClient::new(channel.clone())
        .list(transport::namespaced(
            containers::ListContainersRequest { filters: vec![] },
            &settings.namespace,
        )?)
        .await?
        .into_inner()
        .containers;
    if listed.len() > 10000 {
        return Err(refused());
    }
    let mut chosen = None;
    for container in listed {
        let Some(spec) = container
            .spec
            .as_ref()
            .filter(|s| s.value.len() <= 512 * 1024)
        else {
            continue;
        };
        let Ok(spec) = serde_json::from_slice::<serde_json::Value>(&spec.value) else {
            continue;
        };
        let a = &spec["annotations"];
        if a["io.kubernetes.cri.container-type"] != "container"
            || a["io.kubernetes.cri.sandbox-namespace"] != "openebs"
            || a["io.kubernetes.cri.container-name"] != "openebs-lvm-plugin"
        {
            continue;
        }
        if chosen.is_some() || a["io.kubernetes.cri.sandbox-id"] != container.sandbox {
            return Err(refused());
        }
        let task = tasks::tasks_client::TasksClient::new(channel.clone())
            .get(transport::namespaced(
                tasks::GetRequest {
                    container_id: container.id.clone(),
                    exec_id: String::new(),
                },
                &settings.namespace,
            )?)
            .await?
            .into_inner()
            .process
            .ok_or_else(refused)?;
        if task.status != 2 || task.pid == 0 {
            return Err(refused());
        }
        let status = cri::runtime_service_client::RuntimeServiceClient::new(channel.clone())
            .container_status(cri::ContainerStatusRequest {
                container_id: container.id.clone(),
                verbose: false,
            })
            .await?
            .into_inner()
            .status
            .ok_or_else(refused)?;
        if status.id != container.id
            || status.state != 1
            || status.image.as_ref().is_none_or(|configured| {
                !crate::pool_custody::image_matches(&configured.image, &status.image_ref, image)
            })
        {
            return Err(refused());
        }
        let own = File::open(ROOT)
            .map_err(|_| refused())?
            .metadata()
            .map_err(|_| refused())?;
        let driver = Driver {
            container_id: container.id,
            pod_uid: a["io.kubernetes.cri.sandbox-uid"]
                .as_str()
                .filter(|uid| pgcf_native_protocol::valid_pattern("uuid", uid))
                .ok_or_else(refused)?
                .to_owned(),
            pid: task.pid,
            start_ticks: slot::start_ticks(task.pid)?,
            executable_sha256: executable_sha256.to_owned(),
            gate_device: own.dev(),
            gate_inode: own.ino(),
        };
        driver.recheck()?;
        chosen = Some(driver);
    }
    chosen.ok_or_else(refused)
}

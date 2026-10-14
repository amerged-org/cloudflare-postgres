// SPDX-License-Identifier: Apache-2.0
//! Fixed qualification denial calls. No caller-supplied endpoint, context, secret or target path.
use crate::{
    csi,
    pool_driver::Driver,
    pool_gate::{GateRoot, ROOT, Record},
};
use std::{path::Path, time::Duration};
use tonic::{
    Status,
    transport::{Channel, Endpoint},
};
fn refused() -> Status {
    Status::failed_precondition("pool_csi_denial_unconfirmed")
}
const SOCKET: &str = "/var/lib/kubelet/plugins/local.csi.openebs.io/csi.sock";
#[derive(Clone, serde::Serialize)]
pub struct Denial {
    pub operation: &'static str,
    pub grpc_status: u32,
    pub message: &'static str,
}
async fn channel(driver: &Driver) -> Result<Channel, Status> {
    driver.recheck()?;
    let pid = driver.pid;
    Endpoint::from_static("http://[::]:50051")
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(5))
        .connect_with_connector(tower::service_fn(move |_| async move {
            let stream = tokio::net::UnixStream::connect(Path::new(SOCKET)).await?;
            let peer = stream.peer_cred()?;
            if peer.uid() != 0 || peer.pid().and_then(|pid| u32::try_from(pid).ok()) != Some(pid) {
                return Err(std::io::Error::other("pool_csi_peer_unconfirmed"));
            }
            Ok::<_, std::io::Error>(hyper_util::rt::TokioIo::new(stream))
        }))
        .await
        .map_err(|_| refused())
}
fn fenced(record: &Record, driver: &Driver) -> Result<(), Status> {
    record.bytes()?;
    driver.recheck()?;
    if !GateRoot::open(Path::new(ROOT))?.record_matches(record)? {
        return Err(refused());
    }
    Ok(())
}
fn denial<T>(
    result: Result<tonic::Response<T>, Status>,
    operation: &'static str,
) -> Result<Denial, Status> {
    match result {
        Err(error)
            if error.code() == tonic::Code::FailedPrecondition
                && error.message() == "pool_creator_fence_denied" =>
        {
            Ok(Denial {
                operation,
                grpc_status: 9,
                message: "pool_creator_fence_denied",
            })
        }
        _ => Err(refused()),
    }
}
pub async fn publish(record: &Record, driver: &Driver, raw_block: bool) -> Result<Denial, Status> {
    fenced(record, driver)?;
    let capability = csi::VolumeCapability {
        access_mode: Some(csi::volume_capability::AccessMode { mode: 1 }),
        access_type: Some(if raw_block {
            csi::volume_capability::AccessType::Block(csi::volume_capability::BlockVolume {})
        } else {
            csi::volume_capability::AccessType::Mount(csi::volume_capability::MountVolume {
                fs_type: "ext4".to_owned(),
                mount_flags: vec![],
                ..Default::default()
            })
        }),
    };
    let request = csi::NodePublishVolumeRequest {
        volume_id: record.volume_handle.clone(),
        target_path: format!("{ROOT}/probe-{}", record.scope_sha256),
        volume_capability: Some(capability),
        readonly: true,
        ..Default::default()
    };
    let reply = csi::node_client::NodeClient::new(channel(driver).await?)
        .max_decoding_message_size(65536)
        .node_publish_volume(request)
        .await;
    fenced(record, driver)?;
    denial(reply, "node_publish")
}
pub async fn expand(record: &Record, driver: &Driver) -> Result<Denial, Status> {
    fenced(record, driver)?;
    let request = csi::NodeExpandVolumeRequest {
        volume_id: record.volume_handle.clone(),
        volume_path: format!("{ROOT}/probe-{}", record.scope_sha256),
        capacity_range: Some(csi::CapacityRange {
            required_bytes: 1,
            limit_bytes: 1,
        }),
        ..Default::default()
    };
    let reply = csi::node_client::NodeClient::new(channel(driver).await?)
        .max_decoding_message_size(65536)
        .node_expand_volume(request)
        .await;
    fenced(record, driver)?;
    denial(reply, "node_expand")
}

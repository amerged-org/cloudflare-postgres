// SPDX-License-Identifier: Apache-2.0
use crate::{containerd::task::v3, ttrpc};
use hyper_util::rt::TokioIo;
use prost::Message;
use std::{path::Path, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixStream,
};
use tonic::{
    Request, Status,
    transport::{Channel, Endpoint},
};

pub fn namespaced<T>(value: T, namespace: &str) -> Result<Request<T>, Status> {
    let mut request = Request::new(value);
    request.metadata_mut().insert(
        "containerd-namespace",
        namespace
            .parse()
            .map_err(|_| Status::invalid_argument("namespace_invalid"))?,
    );
    Ok(request)
}
pub async fn connect(path: &Path) -> Result<Channel, Status> {
    let path = path.to_owned();
    Endpoint::from_static("http://[::]:50051")
        .connect_timeout(Duration::from_secs(3))
        .connect_with_connector(tower::service_fn(move |_| {
            let path = path.clone();
            async move { UnixStream::connect(path).await.map(TokioIo::new) }
        }))
        .await
        .map_err(|_| Status::unavailable("containerd_connection_failed"))
}

/// The pinned upstream ttrpc framing: length/stream/type/flags, then protobuf Request.
/// This small client needs only Connect/Shutdown; tenant tasks use containerd's ordinary TaskService.
pub async fn shim_call<M: Message, R: Message + Default>(
    address: &str,
    method: &str,
    request: M,
    namespace: &str,
) -> Result<R, Status> {
    let path = address
        .strip_prefix("ttrpc+unix://")
        .ok_or_else(|| Status::failed_precondition("shim_endpoint_invalid"))?;
    let request = ttrpc::Request {
        service: "containerd.task.v3.Task".into(),
        method: method.into(),
        payload: request.encode_to_vec(),
        timeout_nano: 3_000_000_000,
        metadata: vec![ttrpc::KeyValue {
            key: "containerd-namespace".into(),
            value: namespace.into(),
        }],
    };
    let payload = request.encode_to_vec();
    let result = tokio::time::timeout(Duration::from_secs(3), async {
        let mut socket = UnixStream::connect(path).await?;
        let mut header = [0_u8; 10];
        header[..4].copy_from_slice(&(payload.len() as u32).to_be_bytes());
        header[4..8].copy_from_slice(&1_u32.to_be_bytes());
        header[8] = 1; // request
        socket.write_all(&header).await?;
        socket.write_all(&payload).await?;
        socket.read_exact(&mut header).await?;
        let length = u32::from_be_bytes(header[..4].try_into().unwrap()) as usize;
        if header[4..8] != 1_u32.to_be_bytes() || header[8] != 2 || length > 1024 * 1024 {
            return Err(std::io::Error::other("shim_response_invalid"));
        }
        let mut body = vec![0; length];
        socket.read_exact(&mut body).await?;
        Ok::<_, std::io::Error>(body)
    })
    .await
    .map_err(|_| Status::deadline_exceeded("shim_request_timeout"))?
    .map_err(|_| Status::unavailable("shim_request_failed"))?;
    let response = ttrpc::Response::decode(result.as_slice())
        .map_err(|_| Status::data_loss("shim_response_decode_failed"))?;
    if let Some(status) = response.status
        && status.code != 0
    {
        return Err(Status::new(
            tonic::Code::from_i32(status.code),
            "shim_request_refused",
        ));
    }
    R::decode(response.payload.as_slice())
        .map_err(|_| Status::data_loss("shim_payload_decode_failed"))
}
pub async fn shim_pid(address: &str, namespace: &str) -> Result<u32, Status> {
    let response: v3::ConnectResponse = shim_call(
        address,
        "Connect",
        v3::ConnectRequest { id: String::new() },
        namespace,
    )
    .await?;
    if response.shim_pid == 0 {
        return Err(Status::failed_precondition("shim_not_running"));
    }
    Ok(response.shim_pid)
}

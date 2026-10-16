// SPDX-License-Identifier: Apache-2.0
#[cfg(not(target_os = "linux"))]
compile_error!("pgcf-sandbox-controller requires Linux namespace and runc APIs");
#[cfg(target_os = "linux")]
fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    if args.len() == 3 && args[1] == "--cri-host-context" {
        match pgcf_sandbox_controller::host_context::launch(
            std::path::Path::new(&args[2]),
            &args[2..],
        ) {
            Ok(code) => std::process::exit(code),
            Err(error) => {
                eprintln!("{}", error.message());
                std::process::exit(1);
            }
        }
    }
    if let Err(error) = pgcf_sandbox_controller::host_context::seal_inherited_handles() {
        eprintln!("{}", error.message());
        std::process::exit(1);
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("controller_runtime_unavailable");
    runtime.block_on(serve());
}
#[cfg(target_os = "linux")]
async fn serve() {
    use pgcf_sandbox_controller::{
        containerd::services::sandbox::v1::controller_server::ControllerServer,
        controller::SandboxController, slot::Settings,
    };
    use std::os::unix::fs::PermissionsExt;
    let result = async {
        let args: Vec<_> = std::env::args().collect();
        if args.len()==2&&args[1]=="--version" {println!("{}",serde_json::json!({"program":"pgcf-sandbox-controller","version":env!("CARGO_PKG_VERSION"),"sourceRevision":option_env!("PGCF_SOURCE_REVISION").filter(|value|value.len()==40&&value.bytes().all(|b|b.is_ascii_hexdigit())),"rustVersion":option_env!("PGCF_RUST_VERSION"),"versionsLockSha256":option_env!("PGCF_VERSIONS_LOCK_SHA256"),"cargoLockSha256":option_env!("PGCF_CARGO_LOCK_SHA256"),"containerdApiVersion":"2.3.6"}));return Ok(());}
        if args.len() != 2 {
            return Err(tonic::Status::invalid_argument("settings_file_required"));
        }
        let bytes = std::fs::read(&args[1])
            .map_err(|_| tonic::Status::invalid_argument("settings_unavailable"))?;
        if bytes.len() > 16384 {
            return Err(tonic::Status::invalid_argument("settings_too_large"));
        }
        let settings: Settings = serde_json::from_slice(&bytes)
            .map_err(|_| tonic::Status::invalid_argument("settings_invalid"))?;
        let client=pgcf_sandbox_controller::policy::Client::new(settings.cloudflare.clone().ok_or_else(||tonic::Status::failed_precondition("Cloudflare_pool_authority_required"))?)?;
        if let Some(trust)=client.local().storage_authority.clone() {
            pgcf_sandbox_controller::storage::Guard::new(trust,client.local().node_uid.clone(),u64::from(client.local().material_revision))?;
        }
        let socket = settings.socket.clone();
        let initial_settings=settings.clone();
        let controller = SandboxController::prepare(settings).await?;
        if socket.exists(){use std::os::unix::fs::{FileTypeExt,MetadataExt};let metadata=std::fs::symlink_metadata(&socket).map_err(|_|tonic::Status::failed_precondition("controller_socket_identity_unavailable"))?;if !metadata.file_type().is_socket()||metadata.uid()!=unsafe{libc::geteuid()}{return Err(tonic::Status::failed_precondition("controller_socket_identity_invalid"));}std::fs::remove_file(&socket).map_err(|_|tonic::Status::failed_precondition("controller_socket_cleanup_failed"))?;}
        let listener = tokio::net::UnixListener::bind(&socket)
            .map_err(|_| tonic::Status::unavailable("controller_socket_unavailable"))?;
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| tonic::Status::internal("controller_socket_permissions_failed"))?;
        let (config_sender,config_updates)=tokio::sync::watch::channel(client.clone());
        let config_task=tokio::spawn(pgcf_sandbox_controller::configuration::run(args[1].clone().into(),initial_settings,controller.clone(),config_sender));
        let mut storage_task=client.local().storage_authority.clone().map(|trust|tokio::spawn(pgcf_sandbox_controller::storage::watch(controller.clone(),client.clone(),trust,config_updates.clone())));
        let reclaim_task=tokio::spawn(pgcf_sandbox_controller::reclaim_inventory::run(controller.clone(),client.clone(),config_updates.clone()));
        let policy_task=tokio::spawn(controller.clone().run_policy(client,config_updates));
        let service=tonic::transport::Server::builder()
            .add_service(ControllerServer::new(controller).max_decoding_message_size(512 * 1024))
            .serve_with_incoming_shutdown(
                tokio_stream::wrappers::UnixListenerStream::new(listener),
                async {
                    let _ = tokio::signal::ctrl_c().await;
                },
            )
            ;
        tokio::pin!(service);
        let result=if let Some(task)=storage_task.as_mut(){
            tokio::select!{result=&mut service=>result.map_err(|_|tonic::Status::internal("controller_service_failed")),_ = task=>Err(tonic::Status::internal("storage_supervisor_stopped"))}
        }else{service.await.map_err(|_|tonic::Status::internal("controller_service_failed"))};
        config_task.abort();policy_task.abort();reclaim_task.abort();if let Some(task)=storage_task {task.abort();}result
    }
    .await;
    if let Err(error) = result {
        eprintln!("{}", error.message());
        std::process::exit(1);
    }
}

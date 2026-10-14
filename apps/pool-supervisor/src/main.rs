// SPDX-License-Identifier: Apache-2.0
use pgcf_pool_supervisor::{Error, archiver, server};
use std::{
    fs,
    io::{Read, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
};

fn install(target: &Path, directories: &[String]) -> Result<(), Error> {
    let source = std::env::current_exe().map_err(|_| Error("pool_executable_unavailable"))?;
    let mut input = fs::File::open(source).map_err(|_| Error("pool_executable_unavailable"))?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o555)
        .custom_flags(libc::O_NOFOLLOW)
        .open(target)
        .map_err(|_| Error("pool_install_refused"))?;
    let mut buffer = [0; 65536];
    loop {
        let count = input
            .read(&mut buffer)
            .map_err(|_| Error("pool_install_failed"))?;
        if count == 0 {
            break;
        }
        output
            .write_all(&buffer[..count])
            .map_err(|_| Error("pool_install_failed"))?;
    }
    output
        .set_permissions(fs::Permissions::from_mode(0o555))
        .map_err(|_| Error("pool_install_failed"))?;
    output
        .sync_all()
        .map_err(|_| Error("pool_install_failed"))?;
    for directory in directories {
        pgcf_pool_supervisor::private::directory(Path::new(directory))?;
    }
    Ok(())
}

fn main() {
    let args: Vec<_> = std::env::args().collect();
    if args.len() == 2 && args[1] == "isolation-probe" {
        match pgcf_pool_supervisor::isolation::probe() {
            Ok(value) => println!("{value}"),
            Err(error) => {
                eprintln!("{}", error.0);
                std::process::exit(1);
            }
        }
        return;
    }
    if args.len() == 2 && args[1] == "readonly-control" {
        if let Err(error) = pgcf_pool_supervisor::data::readonly_helper() {
            eprintln!("{}", error.0);
            std::process::exit(1);
        }
        return;
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("pool_runtime_unavailable");
    runtime.block_on(run());
}
async fn run() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let result = async {
        let args: Vec<_> = std::env::args().collect();
        match args.get(1).map(String::as_str) {
            Some("--version") if args.len() == 2 => {
                let source=build_identity(option_env!("PGCF_SOURCE_REVISION"),40)?;
                let compiler=option_env!("PGCF_RUST_VERSION").filter(|value|!value.is_empty()).ok_or(Error("pool_build_metadata_missing"))?;
                let cargo=build_identity(option_env!("PGCF_CARGO_LOCK_SHA256"),64)?;
                let versions=build_identity(option_env!("PGCF_VERSIONS_LOCK_SHA256"),64)?;
                let protocol=build_identity(option_env!("PGCF_PROTOCOL_SHA256"),64)?;
                let pool=build_identity(option_env!("PGCF_POOL_CONTRACT_SHA256"),64)?;
                let qualification=build_identity(option_env!("PGCF_QUALIFICATION_CONTRACT_SHA256"),64)?;
                println!("{}", serde_json::json!({"program":"pgcf-pool-supervisor","version":env!("CARGO_PKG_VERSION"),"sourceRevision":source,"rustVersion":compiler,"cargoLockSha256":cargo,"versionsLockSha256":versions,"protocolSha256":protocol,"poolContractSha256":pool,"qualificationContractSha256":qualification}));
                Ok(())
            }
            Some("install") if (3..=6).contains(&args.len()) => install(Path::new(&args[2]), &args[3..]),
            Some("serve") if args.len() == 2 => {
                if std::env::var("PGCF_POOL_ENABLED").as_deref() != Ok("1") { return Err(Error("pool_feature_disabled")); }
                if unsafe { libc::getpid() } != 1 || unsafe { libc::geteuid() } != 26 { return Err(Error("pool_pid1_identity_required")); }
                server::serve().await
            }
            Some("archiver") if args.len() == 2 => {
                if std::env::var("PGCF_POOL_ENABLED").as_deref() != Ok("1") { return Err(Error("pool_feature_disabled")); }
                if unsafe { libc::geteuid() } != 26 { return Err(Error("pool_uid_required")); }
                archiver::serve().await
            }
            Some("wal-archive") if args.len() == 3 => archiver::wal(&args[2]).await,
            _ => Err(Error("pool_command_invalid")),
        }
    }.await;
    if let Err(error) = result {
        eprintln!("{}", error.0);
        std::process::exit(1);
    }
}
fn build_identity(value: Option<&'static str>, length: usize) -> Result<&'static str, Error> {
    value
        .filter(|value| {
            value.len() == length
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        .ok_or(Error("pool_build_metadata_missing"))
}

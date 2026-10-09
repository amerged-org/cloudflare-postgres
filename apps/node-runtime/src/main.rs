#[cfg(not(target_os = "linux"))]
compile_error!("pgcf-node-runtime requires Linux namespaces and descriptor credentials");

#[cfg(target_os = "linux")]
fn main() {
    use pgcf_node_runtime::{linux, protocol};
    use std::{path::Path, time::Duration};
    let args: Vec<_> = std::env::args().collect();
    if args.len() == 2 && args[1] == "--version" {
        fn field(value: Option<&str>) -> String {
            value
                .filter(|s| {
                    s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b".-_".contains(&b))
                })
                .map_or_else(|| "null".into(), |s| format!("\"{s}\""))
        }
        println!(
            "{{\"program\":\"pgcf-node-runtime\",\"version\":\"{}\",\"protocol\":1,\"sourceRevision\":{},\"rustVersion\":{},\"versionsLockSha256\":{},\"cargoLockSha256\":{}}}",
            env!("CARGO_PKG_VERSION"),
            field(option_env!("PGCF_SOURCE_REVISION").filter(|s| s.len() == 40)),
            field(option_env!("PGCF_RUST_VERSION")),
            field(option_env!("PGCF_VERSIONS_LOCK_SHA256")),
            field(option_env!("PGCF_CARGO_LOCK_SHA256"))
        );
        return;
    }
    let result = (|| {
        if args.len() != 5 {
            return Err("usage: pgcf-node-runtime SOCKET_PATH SLOT_ID CONTROLLER_UID LIFETIME_MS");
        }
        let slot = protocol::parse_slot_id(&args[2]).map_err(|_| "slot_id_invalid")?;
        let uid = args[3]
            .parse::<u32>()
            .map_err(|_| "controller_uid_invalid")?;
        let milliseconds = args[4]
            .parse::<u64>()
            .map_err(|_| "slot_lifetime_invalid")?;
        linux::run_slot(
            Path::new(&args[1]),
            slot,
            uid,
            Duration::from_millis(milliseconds),
        )
        .map_err(|error| error.0)
    })();
    if let Err(code) = result {
        eprintln!("{code}");
        std::process::exit(1);
    }
}

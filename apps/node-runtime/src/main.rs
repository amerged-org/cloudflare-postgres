#[cfg(not(target_os = "linux"))]
compile_error!("pgcf-node-runtime requires Linux namespaces and descriptor credentials");

#[cfg(target_os = "linux")]
fn main() {
    use pgcf_node_runtime::{linux, protocol};
    use std::{path::Path, time::Duration};
    let args: Vec<_> = std::env::args().collect();
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

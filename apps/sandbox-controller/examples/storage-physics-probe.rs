// SPDX-License-Identifier: Apache-2.0
//! Operator-only mechanism probe for an isolated owned LV, never CF authorization acceptance.
//! Ephemeral test trust identifies exactly one Node/VG/LV; the operator separately fences the
//! real Cluster/boot/driver Pod and owns every mutation. No device path or ioctl is supplied.
use pgcf_native_protocol::storage::StorageTrust;
use pgcf_sandbox_controller::storage_dm;
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    io::Read,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Command {
    Suspend,
    Resume,
    Absent,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    command: Command,
    keys: BTreeMap<String, String>,
    keys_sha256: String,
    token: String,
    node_uid: String,
    volume_group_uuid: String,
    lv_uuid: String,
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().len() != 1 {
        return Err("stdin-only owned storage mechanism probe".into());
    }
    let mut bytes = Vec::new();
    std::io::stdin().take(32769).read_to_end(&mut bytes)?;
    if bytes.len() > 32768 {
        return Err("probe input exceeds bound".into());
    }
    let input: Input = serde_json::from_slice(&bytes)?;
    let trust = StorageTrust::parse(&serde_json::to_string(&input.keys)?, &input.keys_sha256)?;
    let now = u64::try_from(SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis())?;
    let scope = match input.command {
        Command::Resume => trust.verify(&input.token, now)?,
        Command::Suspend | Command::Absent => trust.verify_for_protection(&input.token)?,
    };
    if scope.claims().node_uid != input.node_uid
        || scope.claims().volume_group_uuid != input.volume_group_uuid
        || scope.claims().lv_uuid != input.lv_uuid
    {
        return Err("probe signed owned physical identity changed".into());
    }
    let (command, confirmed) = match input.command {
        Command::Suspend => {
            storage_dm::suspend(&scope)?;
            ("suspend", true)
        }
        Command::Resume => {
            storage_dm::resume(&scope)?;
            ("resume", true)
        }
        Command::Absent => ("absent", storage_dm::absent(&scope)?),
    };
    println!(
        "{}",
        serde_json::json!({"purpose":"isolated_storage_mechanism_proof","command":command,"confirmed":confirmed,"node_uid":input.node_uid,"volume_group_uuid":input.volume_group_uuid,"lv_uuid":input.lv_uuid,"cf_authorization_acceptance":false})
    );
    Ok(())
}

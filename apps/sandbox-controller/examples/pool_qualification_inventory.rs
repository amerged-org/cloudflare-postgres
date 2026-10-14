// SPDX-License-Identifier: Apache-2.0
//! Owned local LVM metadata proof, not a Cloudflare qualification report.
#[path = "../src/pool_qualification_physical.rs"]
mod physical;
fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    assert_eq!(args.len(), 8);
    let bytes = std::fs::read(&args[1]).unwrap();
    assert!(bytes.len() <= 1048576);
    let report = serde_json::from_slice(&bytes).unwrap();
    let count = physical::snapshot_count(&report, &args[2], &args[3], &args[4], &args[5], &args[6])
        .unwrap();
    assert_eq!(count, args[7].parse::<u64>().unwrap());
    println!("actual_physical_snapshot_count={count}");
}

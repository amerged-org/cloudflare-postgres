// SPDX-License-Identifier: Apache-2.0
//! Explicit isolated ordinary-file IO experiment. This is not an all-BIO rate proof.
#[derive(Debug, PartialEq, Eq)]
struct Counters {
    wbytes: u64,
    wios: u64,
}
fn counters(raw: &str, device: &str) -> Result<Counters, &'static str> {
    let rows = raw
        .lines()
        .filter(|line| line.split_whitespace().next() == Some(device))
        .collect::<Vec<_>>();
    if rows.len() != 1 {
        return Err("actual device row missing or ambiguous");
    }
    let field = |key: &str| {
        let values = rows[0]
            .split_whitespace()
            .filter_map(|value| value.strip_prefix(key))
            .collect::<Vec<_>>();
        if values.len() != 1 {
            return Err("actual counter missing or ambiguous");
        }
        values[0]
            .parse::<u64>()
            .map_err(|_| "actual counter invalid")
    };
    Ok(Counters {
        wbytes: field("wbytes=")?,
        wios: field("wios=")?,
    })
}
use pgcf_sandbox_controller::pool_io::{Process, SharedBudget};
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::{
        fd::AsRawFd,
        unix::{
            fs::{MetadataExt, OpenOptionsExt},
            process::CommandExt,
        },
    },
    path::{Path, PathBuf},
    process::{Child, ChildStdout, Command, Stdio},
    time::{Duration, Instant},
};
const BLOCK: usize = 4096;
const WORKER_BYTES: usize = 4 * 1024 * 1024;
const BPS: u64 = 1024 * 1024;
const IOPS: u64 = 256;
fn dedicated_uncapped(raw: &str, device: &str) -> bool {
    let rows = raw
        .lines()
        .filter(|row| row.split_whitespace().next() == Some(device))
        .collect::<Vec<_>>();
    rows.is_empty()
        || (rows.len() == 1
            && rows[0]
                .split_whitespace()
                .filter(|v| v.starts_with("wbps="))
                .collect::<Vec<_>>()
                == ["wbps=max"]
            && rows[0]
                .split_whitespace()
                .filter(|v| v.starts_with("wiops="))
                .collect::<Vec<_>>()
                == ["wiops=max"])
}
fn read_counters(path: &Path, device: u64) -> Counters {
    counters(
        &fs::read_to_string(path.join("io.stat")).unwrap(),
        &format!("{}:{}", libc::major(device), libc::minor(device)),
    )
    .expect("actual device wbytes/wios row missing or ambiguous")
}
fn read_limits(paths: &[PathBuf]) -> Vec<(u64, String, Option<String>)> {
    paths
        .iter()
        .map(|p| {
            let raw = match fs::read_to_string(p.join("io.max")) {
                Ok(value) => Some(value),
                Err(error)
                    if p == Path::new("/sys/fs/cgroup")
                        && error.kind() == std::io::ErrorKind::NotFound =>
                {
                    None
                }
                Err(error) => panic!("inherited io.max unavailable: {error}"),
            };
            (fs::metadata(p).unwrap().ino(), p.display().to_string(), raw)
        })
        .collect()
}
#[repr(C)]
#[derive(Clone, Copy)]
struct Extent {
    logical: u64,
    physical: u64,
    length: u64,
    reserved64: [u64; 2],
    flags: u32,
    reserved: [u32; 3],
}
#[repr(C)]
struct Fiemap {
    start: u64,
    length: u64,
    flags: u32,
    mapped: u32,
    count: u32,
    reserved: u32,
    extents: [Extent; 128],
}
fn file_identity(path: &Path) -> Value {
    let file = fs::File::open(path).unwrap();
    let meta = file.metadata().unwrap();
    assert!(meta.is_file());
    assert_eq!(meta.len(), (WORKER_BYTES * 2) as u64);
    let mut map: Fiemap = unsafe { std::mem::zeroed() };
    map.length = u64::MAX;
    map.flags = 1;
    map.count = 128;
    assert_eq!(
        unsafe { libc::ioctl(file.as_raw_fd(), 0xc020660b_u32 as _, &mut map) },
        0,
        "actual FIEMAP unavailable"
    );
    assert!(
        map.mapped > 0 && map.mapped < 128,
        "bounded physical extent inventory missing"
    );
    let mut end = 0;
    let extents = map.extents[..map.mapped as usize]
        .iter()
        .map(|e| {
            assert_eq!(e.logical, end, "scratch extents have a hole");
            assert!(e.physical > 0 && e.length > 0);
            assert_eq!(
                e.flags & (2 | 4 | 8 | 128 | 512 | 1024 | 2048),
                0,
                "scratch extents are not ordinary initialized data"
            );
            end = e.logical + e.length;
            json!({"logical":e.logical,"physical":e.physical,"length":e.length,"flags":e.flags})
        })
        .collect::<Vec<_>>();
    assert!(end >= meta.len());
    json!({"inode":meta.ino(),"device_major":libc::major(meta.dev()),"device_minor":libc::minor(meta.dev()),"size_bytes":meta.len(),"extents":extents})
}
struct Worker {
    child: Child,
    output: BufReader<ChildStdout>,
}
impl Worker {
    fn reply(&mut self) -> Value {
        let fd = self.output.get_ref().as_raw_fd();
        let mut poll = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        assert_eq!(
            unsafe { libc::poll(&mut poll, 1, 30_000) },
            1,
            "bounded worker completion missing"
        );
        let mut line = String::new();
        assert!(self.output.read_line(&mut line).unwrap() > 0);
        assert!(line.len() < 65536);
        serde_json::from_str(&line).expect("actual worker reply invalid")
    }
    fn command(&mut self, phase: &str) {
        writeln!(self.child.stdin.as_mut().unwrap(), "{phase}").unwrap();
    }
}
fn writer(path: &str, offset: i64) {
    assert!(offset == 0 || offset == WORKER_BYTES as i64);
    unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) };
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_DIRECT | libc::O_NOFOLLOW)
        .open(path)
        .unwrap();
    assert!(file.metadata().unwrap().is_file());
    let mut buffer = std::ptr::null_mut();
    assert_eq!(
        unsafe { libc::posix_memalign(&mut buffer, BLOCK, BLOCK) },
        0
    );
    unsafe { std::ptr::write_bytes(buffer.cast::<u8>(), 0x61, BLOCK) };
    println!("{}", json!({"ready":true,"pid":std::process::id()}));
    std::io::stdout().flush().unwrap();
    for line in std::io::stdin().lock().lines() {
        let phase = line.unwrap();
        if phase == "quit" {
            break;
        }
        assert!(matches!(phase.as_str(), "warmup" | "baseline" | "capped"));
        let start = Instant::now();
        let mut bytes = 0;
        let mut error = None;
        for n in 0..WORKER_BYTES / BLOCK {
            let result = unsafe {
                libc::pwrite(file.as_raw_fd(), buffer, BLOCK, offset + (n * BLOCK) as i64)
            };
            if result != BLOCK as isize {
                error = Some(std::io::Error::last_os_error().raw_os_error().unwrap_or(-1));
                break;
            }
            bytes += result as usize;
        }
        let sync = unsafe { libc::fsync(file.as_raw_fd()) };
        let sync_errno = if sync == 0 {
            0
        } else {
            std::io::Error::last_os_error().raw_os_error().unwrap_or(-1)
        };
        println!(
            "{}",
            json!({"phase":phase,"pid":std::process::id(),"bytes":bytes,"write_errno":error,"fsync_errno":sync_errno,"elapsed_ns":start.elapsed().as_nanos()})
        );
        std::io::stdout().flush().unwrap();
        if error.is_some() || sync_errno != 0 {
            break;
        }
    }
    unsafe { libc::free(buffer) };
}
struct Experiment<'a> {
    processes: &'a [Process],
    budget: &'a SharedBudget,
    leaves: &'a [PathBuf],
    group: &'a Path,
    device: u64,
    inherited: &'a [PathBuf],
    limits: &'a [(u64, String, Option<String>)],
}
fn phase(name: &str, workers: &mut [Worker], experiment: &Experiment<'_>) -> Value {
    let Experiment {
        processes,
        budget,
        leaves,
        group,
        device,
        inherited,
        limits,
    } = *experiment;
    let dedicated_limit = fs::read_to_string(group.join("io.max")).unwrap();
    assert_eq!(read_limits(inherited), limits);
    for process in processes {
        process.recheck().unwrap();
    }
    budget.recheck().unwrap();
    let before = leaves
        .iter()
        .map(PathBuf::as_path)
        .chain(std::iter::once(group))
        .map(|p| read_counters(p, device))
        .collect::<Vec<_>>();
    let start = Instant::now();
    for worker in workers.iter_mut() {
        worker.command(name);
    }
    let completions = workers.iter_mut().map(|w| w.reply()).collect::<Vec<_>>();
    let elapsed = start.elapsed().as_nanos();
    for result in &completions {
        assert_eq!(result["phase"], name);
        assert_eq!(result["bytes"], WORKER_BYTES);
        assert!(result["write_errno"].is_null());
        assert_eq!(result["fsync_errno"], 0);
    }
    // io.stat is asynchronously aggregated; wait only for positive actual completion counters.
    let deadline = Instant::now() + Duration::from_secs(2);
    let after = loop {
        let rows = leaves
            .iter()
            .map(PathBuf::as_path)
            .chain(std::iter::once(group))
            .map(|p| read_counters(p, device))
            .collect::<Vec<_>>();
        if rows.iter().zip(&before).enumerate().all(|(i, (a, b))| {
            a.wbytes.checked_sub(b.wbytes).is_some_and(|v| {
                v >= if i == 2 {
                    (WORKER_BYTES * 2) as u64
                } else {
                    WORKER_BYTES as u64
                }
            }) && a.wios > b.wios
        }) {
            break rows;
        }
        assert!(
            Instant::now() < deadline,
            "actual same-device accounting did not cover completed ordinary work"
        );
        std::thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(
        fs::read_to_string(group.join("io.max")).unwrap(),
        dedicated_limit
    );
    assert_eq!(read_limits(inherited), limits);
    for process in processes {
        process.recheck().unwrap();
    }
    budget.recheck().unwrap();
    json!({"phase":name,"dedicated_io_max":dedicated_limit,"elapsed_ns":elapsed,"completed_bytes":WORKER_BYTES*2,"completions":completions,"groups":leaves.iter().map(PathBuf::as_path).chain(std::iter::once(group)).zip(before.iter().zip(&after)).map(|(p,(b,a))|json!({"cgroup_inode":fs::metadata(p).unwrap().ino(),"before":{"wbytes":b.wbytes,"wios":b.wios},"after":{"wbytes":a.wbytes,"wios":a.wios}})).collect::<Vec<_>>()})
}
fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    if args.len() == 4 && args[1] == "--writer" {
        writer(&args[2], args[3].parse().unwrap());
        return;
    }
    assert_eq!(args.len(), 8);
    assert_eq!(args[1], "--owned-fixture");
    let path = PathBuf::from(&args[2]);
    assert!(path.starts_with("/tmp") && path.ends_with("scratch/ordinary-io.bin"));
    assert!(
        path.parent()
            .unwrap()
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("pgcf-paired-io-")
    );
    assert!(args[3].starts_with("/dev/mapper/pgcf_paired_io_") && args[3].ends_with("-io"));
    let device_proof = pgcf_sandbox_controller::pool_device::Device::verify(
        &args[4],
        &args[5],
        "io",
        pgcf_sandbox_controller::pool_device::Backend::Thin {
            pool_uuid: args[6].clone(),
            thin_id: args[7].parse().unwrap(),
        },
    )
    .unwrap();
    let file = fs::OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .mode(0o600)
        .open(&path)
        .unwrap();
    assert_eq!(file.metadata().unwrap().dev(), device_proof.device());
    assert_eq!(
        unsafe { libc::fallocate(file.as_raw_fd(), 0, 0, (WORKER_BYTES * 2) as i64) },
        0
    );
    file.sync_all().unwrap();
    let device = file.metadata().unwrap().dev();
    drop(file);
    let pod = fs::read_to_string("/proc/sys/kernel/random/uuid")
        .unwrap()
        .trim()
        .to_owned();
    let root = Path::new("/sys/fs/cgroup").join(format!("pgcf-paired-io-{pod}"));
    let kubepods = root.join("kubepods");
    let group = kubepods.join(format!("pod{pod}"));
    let mut workers = Vec::<Worker>::new();
    let mut leaves = Vec::new();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        for parent in [&root, &kubepods, &group] {
            fs::create_dir(parent).unwrap();
            fs::write(parent.join("cgroup.subtree_control"), "+io").unwrap();
        }
        for (i, id) in ["a".repeat(64), "b".repeat(64)].iter().enumerate() {
            let leaf = group.join(id);
            fs::create_dir(&leaf).unwrap();
            leaves.push(leaf.clone());
            let procs = leaf.join("cgroup.procs");
            let mut cmd = Command::new(std::env::current_exe().unwrap());
            cmd.arg("--writer")
                .arg(&path)
                .arg((i * WORKER_BYTES).to_string())
                .stdin(Stdio::piped())
                .stdout(Stdio::piped());
            unsafe {
                cmd.pre_exec(move || {
                    fs::write(&procs, std::process::id().to_string())?;
                    Ok(())
                });
            }
            let mut child = cmd.spawn().unwrap();
            let output = BufReader::new(child.stdout.take().unwrap());
            let mut worker = Worker { child, output };
            assert_eq!(worker.reply()["ready"], true);
            workers.push(worker);
        }
        let processes = workers
            .iter()
            .zip(["a".repeat(64), "b".repeat(64)])
            .map(|(w, id)| Process::capture(w.child.id(), &pod, &id).unwrap())
            .collect::<Vec<_>>();
        let budget = SharedBudget::capture(&processes).unwrap();
        let mut inherited = leaves.clone();
        let mut parent = group.parent();
        while let Some(p) = parent {
            if p.starts_with("/sys/fs/cgroup") {
                inherited.push(p.to_path_buf());
                if p == Path::new("/sys/fs/cgroup") {
                    break;
                }
            }
            parent = p.parent();
        }
        // No inherited io.max is rewritten. Only this fresh dedicated shared group is changed.
        let limits = read_limits(&inherited);
        fs::write(
            group.join("io.max"),
            format!(
                "{}:{} wbps=max wiops=max\n",
                libc::major(device),
                libc::minor(device)
            ),
        )
        .unwrap();
        for w in &mut workers {
            w.command("warmup");
        }
        for w in &mut workers {
            let done = w.reply();
            assert_eq!(done["bytes"], WORKER_BYTES);
            assert!(done["write_errno"].is_null());
            assert_eq!(done["fsync_errno"], 0);
        }
        let until = Instant::now() + Duration::from_secs(2);
        loop {
            if leaves.iter().chain(std::iter::once(&group)).all(|p| {
                counters(
                    &fs::read_to_string(p.join("io.stat")).unwrap(),
                    &format!("{}:{}", libc::major(device), libc::minor(device)),
                )
                .is_ok_and(|v| v.wbytes > 0 && v.wios > 0)
            }) {
                break;
            }
            assert!(
                Instant::now() < until,
                "warmup did not establish real counters"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        let baseline_limit = fs::read_to_string(group.join("io.max")).unwrap();
        let device_key = format!("{}:{}", libc::major(device), libc::minor(device));
        assert!(
            dedicated_uncapped(&baseline_limit, &device_key),
            "dedicated scratch group remains capped"
        );
        let identity = file_identity(&path);
        let key = format!("{}:{}", libc::major(device), libc::minor(device));
        for (_, _, raw) in &limits {
            for row in raw
                .iter()
                .flat_map(|v| v.lines())
                .filter(|row| row.split_whitespace().next() == Some(&key))
            {
                for (name, cap) in [("wbps=", BPS), ("wiops=", IOPS)] {
                    let values = row
                        .split_whitespace()
                        .filter_map(|v| v.strip_prefix(name))
                        .collect::<Vec<_>>();
                    assert_eq!(values.len(), 1, "inherited device limit ambiguous");
                    if values[0] != "max" {
                        assert!(
                            values[0].parse::<u64>().unwrap() > cap,
                            "dedicated experiment cap is not stricter than inherited cap"
                        );
                    }
                }
            }
        }
        let experiment = Experiment {
            processes: &processes,
            budget: &budget,
            leaves: &leaves,
            group: &group,
            device,
            inherited: &inherited,
            limits: &limits,
        };
        let baseline = phase("baseline", &mut workers, &experiment);
        assert_eq!(file_identity(&path), identity);
        budget.set_io(device, BPS, IOPS).unwrap();
        assert!(budget.io_matches(device, BPS, IOPS).unwrap());
        let capped = phase("capped", &mut workers, &experiment);
        assert_eq!(file_identity(&path), identity);
        assert!(budget.io_matches(device, BPS, IOPS).unwrap());
        let base = baseline["elapsed_ns"].as_u64().unwrap();
        let cap = capped["elapsed_ns"].as_u64().unwrap();
        assert!(
            base > 0 && cap >= base.checked_mul(2).unwrap(),
            "same-work cap did not produce >=2x observed slowdown"
        );
        println!(
            "{}",
            json!({"engineering_acceptance_only":true,"all_bio_hard_cap_proven":false,"kernel_version":fs::read_to_string("/proc/sys/kernel/osrelease").unwrap().trim(),"ordinary_scratch":identity,"workers":processes.iter().map(|p|json!({"pid":p.pid,"start_ticks":p.start_ticks,"pid_namespace_device":p.pid_namespace.device,"pid_namespace_inode":p.pid_namespace.inode,"cgroup_inode":p.cgroup_inode,"fixture_worker_group_component":p.container_id})).collect::<Vec<_>>(),"shared_pod_cgroup_inode":budget.pod_cgroup_inode,"preserved_limits_before":limits,"preserved_limits_after":read_limits(&inherited),"inherited_limits_unchanged":true,"dedicated_cap":{"write_bytes_per_second":BPS,"write_iops_per_second":IOPS},"baseline":baseline,"capped":capped,"observed_slowdown":cap as f64/base as f64})
        );
    }));
    let clean_exit = if result.is_ok() {
        for w in &mut workers {
            w.command("quit");
        }
        let mut all = true;
        for worker in &mut workers {
            all &= worker.child.wait().unwrap().success();
        }
        all
    } else {
        for w in &mut workers {
            let _ = w.child.kill();
            let _ = w.child.wait();
        }
        false
    };
    for leaf in leaves.iter().rev() {
        if leaf.exists() {
            fs::write(leaf.join("cgroup.kill"), "1").unwrap();
            let until = Instant::now() + Duration::from_secs(2);
            while fs::read_to_string(leaf.join("cgroup.events"))
                .unwrap()
                .lines()
                .any(|l| l == "populated 1")
            {
                assert!(Instant::now() < until);
                std::thread::sleep(Duration::from_millis(10));
            }
            fs::remove_dir(leaf).unwrap();
        }
    }
    for parent in [&group, &kubepods, &root] {
        if parent.exists() {
            fs::remove_dir(parent).unwrap();
        }
    }
    fs::remove_file(&path).unwrap();
    fs::File::open(path.parent().unwrap())
        .unwrap()
        .sync_all()
        .unwrap();
    println!(
        "{}",
        json!({"owned_workers_reaped":true,"owned_workers_clean_exit":clean_exit,"owned_cgroups_removed":!root.exists(),"owned_scratch_unlinked":!path.exists()})
    );
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
    assert!(clean_exit);
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn kernel_omits_unlimited_io_max_row_but_not_accounting() {
        assert!(dedicated_uncapped("", "253:7"));
        assert!(!dedicated_uncapped("253:7 wbps=1048576 wiops=256", "253:7"));
        assert!(counters("", "253:7").is_err());
    }
    #[test]
    fn missing_kernel_counter_rows_are_not_observed_zero() {
        assert!(counters("", "253:7").is_err());
        assert!(counters("253:7 rbytes=0 wios=1", "253:7").is_err());
        assert!(counters("253:7 wbytes=4096", "253:7").is_err());
    }
    #[test]
    fn exact_device_counter_row_is_required() {
        assert_eq!(
            counters("253:7 wbytes=4096 wios=1 rbytes=0", "253:7"),
            Ok(Counters {
                wbytes: 4096,
                wios: 1
            })
        );
        assert_eq!(
            counters("253:7 wbytes=0 wios=0", "253:7"),
            Ok(Counters { wbytes: 0, wios: 0 })
        );
        assert!(counters("253:8 wbytes=4096 wios=1", "253:7").is_err());
        assert!(
            counters(
                "253:7 wbytes=4096 wios=1\n253:7 wbytes=4096 wios=1",
                "253:7"
            )
            .is_err()
        );
    }
}

// SPDX-License-Identifier: Apache-2.0
//! Explicit owned Docker fixture. Never invoked by the product server or ordinary unit tests.
use pgcf_sandbox_controller::pool_io::{Process, SharedBudget};
use std::{
    fs,
    io::Write,
    os::unix::process::CommandExt,
    path::Path,
    process::Command,
    time::{Duration, Instant},
};

fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    if args.len() == 2 && args[1] == "--resident" {
        std::thread::sleep(Duration::from_secs(60));
        return;
    }
    if args.len() == 4 && args[1] == "--writer" {
        unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) };
        let device = std::ffi::CString::new(args[2].as_str()).unwrap();
        let fd = unsafe {
            libc::open(
                device.as_ptr(),
                libc::O_WRONLY | libc::O_DIRECT | libc::O_CLOEXEC,
            )
        };
        assert!(fd >= 0);
        let mut buffer = std::ptr::null_mut();
        assert_eq!(unsafe { libc::posix_memalign(&mut buffer, 4096, 4096) }, 0);
        unsafe { std::ptr::write_bytes(buffer.cast::<u8>(), 0x61, 4096) };
        let mut resident = if args[3] == "0" {
            Some(
                Command::new(std::env::current_exe().unwrap())
                    .arg("--resident")
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .spawn()
                    .unwrap(),
            )
        } else {
            None
        };
        println!("writer_ready");
        std::io::stdout().flush().unwrap();
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).unwrap();
        assert_eq!(line.trim(), "write_owned_fixture");
        let offset = args[3].parse::<i64>().unwrap();
        for n in 0..1024 {
            assert_eq!(
                unsafe { libc::pwrite(fd, buffer, 4096, offset + n * 4096) },
                4096
            )
        }
        assert_eq!(unsafe { libc::fsync(fd) }, 0);
        unsafe {
            libc::free(buffer);
            libc::close(fd)
        };
        std::io::stdin().read_line(&mut line).unwrap();
        if let Some(child) = resident.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        return;
    }
    assert_eq!(args.len(), 7);
    assert_eq!(args[1], "--owned-fixture");
    assert!(args[2].starts_with("/dev/mapper/pgcf_a8_") && args[2].ends_with("-io"));
    let device_proof = pgcf_sandbox_controller::pool_device::Device::verify(
        &args[3],
        &args[4],
        "io",
        pgcf_sandbox_controller::pool_device::Backend::Thin {
            pool_uuid: args[5].clone(),
            thin_id: args[6].parse().unwrap(),
        },
    )
    .unwrap();
    assert_eq!(device_proof.open_count().unwrap(), 0);
    let pod = fs::read_to_string("/proc/sys/kernel/random/uuid")
        .unwrap()
        .trim()
        .to_owned();
    let root = std::path::PathBuf::from("/sys/fs/cgroup").join(format!("pgcf-a8-{pod}"));
    fs::create_dir(&root).unwrap();
    let kubepods = root.join("kubepods");
    let group = kubepods.join(format!("pod{pod}"));
    let mut children = Vec::new();
    let mut leaves = Vec::new();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        for parent in [&root, &kubepods, &group] {
            if !parent.exists() {
                fs::create_dir(parent).unwrap()
            }
            fs::write(parent.join("cgroup.subtree_control"), "+io +memory +cpu").unwrap();
        }
        for (i, id) in ["a".repeat(64), "b".repeat(64)].iter().enumerate() {
            let leaf = group.join(id);
            fs::create_dir(&leaf).unwrap();
            leaves.push(leaf.clone());
            let procs = leaf.join("cgroup.procs");
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--writer",
                    args[2].as_str(),
                    &(i * 8 * 1024 * 1024).to_string(),
                ])
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped());
            unsafe {
                command.pre_exec(move || {
                    fs::write(&procs, std::process::id().to_string())?;
                    Ok(())
                });
            }
            let mut child = command.spawn().unwrap();
            use std::io::BufRead;
            let mut reader = std::io::BufReader::new(child.stdout.take().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            assert_eq!(line.trim(), "writer_ready");
            children.push(child);
        }
        let stat = fs::metadata(&args[2]).unwrap();
        use std::os::unix::fs::MetadataExt;
        let device = stat.rdev();
        assert_eq!(device, device_proof.device());
        let processes = children
            .iter()
            .zip(["a".repeat(64), "b".repeat(64)])
            .map(|(child, id)| Process::capture(child.id(), &pod, &id).unwrap())
            .collect::<Vec<_>>();
        let budget = SharedBudget::capture(&processes).unwrap();
        let bps = 1024 * 1024;
        let iops = 1024;
        for p in &processes {
            p.set_io(device, bps, iops).unwrap()
        }
        budget.set_io(device, bps, iops).unwrap();
        assert!(budget.io_matches(device, bps, iops).unwrap());
        let raw = fs::read_to_string(group.join("io.stat")).unwrap();
        println!("actual_owned_initial_io_stat={raw:?}");
        let before = budget.write_bytes(device).unwrap().unwrap_or(0);
        let start = Instant::now();
        for child in &mut children {
            child
                .stdin
                .as_mut()
                .unwrap()
                .write_all(b"write_owned_fixture\n")
                .unwrap()
        }
        let deadline = start + Duration::from_secs(30);
        loop {
            let actual = budget.write_bytes(device).unwrap().unwrap_or(0);
            if actual.saturating_sub(before) >= 8 * 1024 * 1024 {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "actual shared device IO accounting never reached owned bytes"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        let elapsed = start.elapsed();
        assert!(
            elapsed >= Duration::from_secs(6),
            "shared ancestor did not bound aggregate real writes"
        );
        for p in &processes {
            assert!(p.io_matches(device, bps, iops).unwrap());
            p.idle_counters().unwrap();
            p.recheck().unwrap()
        }
        println!(
            "actual_thin_shared_pod_ancestor_io_verified=true actual_two_writers_bytes={} actual_elapsed_milliseconds={}",
            budget.write_bytes(device).unwrap().unwrap() - before,
            elapsed.as_millis()
        );
        if std::env::var("PGCF_POOL_IO_OBSERVATION").as_deref() == Ok("1") {
            // Only this explicit owned fixture exposes a bounded observer window. Product code
            // never invokes it. Every tuple below is measured from the live processes/kernel.
            let value = serde_json::json!({"v":1,"pod_uid":pod,"device_major":libc::major(device),"device_minor":libc::minor(device),"write_bytes_per_second":bps,"write_iops_per_second":iops,"shared_pod_cgroup_inode":budget.pod_cgroup_inode,"shared_pod_cgroup_path":group,"cgroups":processes.iter().map(|p|serde_json::json!({"container_id":p.container_id,"pid":p.pid,"start_ticks":p.start_ticks,"pid_namespace":p.pid_namespace.inode,"cgroup_inode":p.cgroup_inode,"path":p.directory_path()})).collect::<Vec<_>>()});
            use std::os::unix::fs::OpenOptionsExt;
            let path = "/tmp/pgcf-a8-io/observation.json";
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(path)
                .unwrap();
            file.write_all(&serde_json::to_vec(&value).unwrap())
                .unwrap();
            file.sync_all().unwrap();
            drop(file);
            let until = Instant::now() + Duration::from_secs(60);
            while !Path::new("/tmp/pgcf-a8-io/observer-done").exists() {
                assert!(Instant::now() < until, "bounded owned observer expired");
                std::thread::sleep(Duration::from_millis(10));
            }
            for p in &processes {
                p.recheck().unwrap();
                assert!(p.io_matches(device, bps, iops).unwrap());
            }
            assert!(budget.io_matches(device, bps, iops).unwrap());
            fs::remove_file(path).unwrap();
            fs::remove_file("/tmp/pgcf-a8-io/observer-done").unwrap();
        }
        children[0].kill().unwrap();
        children[0].wait().unwrap();
        assert!(processes[0].recheck().is_err());
        assert!(
            processes[0].populated().unwrap(),
            "actual descendant must survive its original parent"
        );
        let captured =
            pgcf_sandbox_controller::pool_io::CapturedGroup::restore(&processes[0].group_record())
                .unwrap();
        assert!(captured.populated().unwrap());
        let mut wrong_inode = processes[0].group_record();
        wrong_inode.cgroup_inode += 1;
        assert!(pgcf_sandbox_controller::pool_io::CapturedGroup::restore(&wrong_inode).is_err());
        captured.stop().unwrap();
        let until = Instant::now() + Duration::from_secs(2);
        while processes[0].populated().unwrap() {
            assert!(Instant::now() < until);
            std::thread::sleep(Duration::from_millis(10));
        }
        // A captured directory FD does not substitute for a still-existing original leaf.
        // Exercise actual cgroup removal while both Process and CapturedGroup retain their FDs.
        let original = processes[0].group_record();
        fs::remove_dir(&leaves[0]).unwrap();
        assert!(captured.recheck().is_err());
        assert!(pgcf_sandbox_controller::pool_io::CapturedGroup::restore(&original).is_err());
        fs::create_dir(&leaves[0]).unwrap();
        assert_ne!(
            fs::metadata(&leaves[0]).unwrap().ino(),
            original.cgroup_inode
        );
        assert!(pgcf_sandbox_controller::pool_io::CapturedGroup::restore(&original).is_err());
        println!(
            "actual_empty_leaf_deleted_with_captured_fds=true recreated_leaf_inode_changed=true original_inode_reuse_refused=true"
        );
        println!(
            "actual_original_cgroup_descendants_stopped_after_parent_exit=true actual_durable_inode_group_restored=true wrong_inode_refused=true"
        );
        println!("actual_recycled_or_dead_process_refused=true");
    }));
    for child in &mut children {
        let _ = child.kill();
        let _ = child.wait();
    }
    for leaf in leaves.iter().rev() {
        fs::write(leaf.join("cgroup.kill"), "1").unwrap();
        let until = Instant::now() + Duration::from_secs(2);
        while fs::read_to_string(leaf.join("cgroup.events"))
            .unwrap()
            .lines()
            .any(|line| line == "populated 1")
        {
            assert!(Instant::now() < until);
            std::thread::sleep(Duration::from_millis(10));
        }
        fs::remove_dir(leaf).unwrap()
    }
    for parent in [&group, &kubepods, &root] {
        if parent.exists() {
            fs::remove_dir(parent).unwrap()
        }
    }
    println!("owned_cgroup_normal_cleanup=true");
    if let Err(error) = result {
        std::panic::resume_unwind(error)
    }
    assert!(!Path::new(&root).exists());
}

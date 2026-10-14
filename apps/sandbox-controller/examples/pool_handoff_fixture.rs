// SPDX-License-Identifier: Apache-2.0
//! Owned kernel experiment only. This does not establish CRI/container-teardown custody.
use pgcf_sandbox_controller::pool_io::{CapturedGroup, Process};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

fn wait(child: &mut Child) -> std::process::ExitStatus {
    let end = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        assert!(Instant::now() < end, "owned process did not exit");
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn line(child: &mut Child) -> String {
    let output = child.stdout.take().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        let mut reader = BufReader::new(output);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let _ = tx.send(line);
    });
    let value = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    reader.join().unwrap();
    value
}
fn original_namespace(leaf: &Path) {
    assert_eq!(
        unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) },
        0
    );
    assert_eq!(unsafe { libc::unshare(libc::CLONE_NEWPID) }, 0);
    let pid = unsafe { libc::fork() };
    assert!(pid >= 0);
    if pid > 0 {
        let mut status = 0;
        assert_eq!(unsafe { libc::waitpid(pid, &mut status, 0) }, pid);
        assert!(libc::WIFSIGNALED(status));
        assert_eq!(libc::WTERMSIG(status), libc::SIGKILL);
        return;
    }
    assert_eq!(std::process::id(), 1);
    assert_eq!(
        unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) },
        0
    );
    fs::write(leaf.join("cgroup.procs"), "1").unwrap();
    let mut fds = [0; 2];
    assert_eq!(unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) }, 0);
    let descendant = unsafe { libc::fork() };
    assert!(descendant >= 0);
    if descendant == 0 {
        unsafe {
            libc::close(fds[0]);
        }
        assert_eq!(unsafe { libc::write(fds[1], b"r".as_ptr().cast(), 1) }, 1);
        unsafe {
            libc::close(fds[1]);
        }
        loop {
            unsafe {
                libc::pause();
            }
        }
    }
    unsafe {
        libc::close(fds[1]);
    }
    let mut ready = [0; 1];
    assert_eq!(
        unsafe { libc::read(fds[0], ready.as_mut_ptr().cast(), 1) },
        1
    );
    unsafe {
        libc::close(fds[0]);
    }
    let status = fs::read_to_string("/proc/self/status").unwrap();
    let host_pid = status
        .lines()
        .find_map(|line| line.strip_prefix("NSpid:"))
        .unwrap()
        .split_whitespace()
        .next()
        .unwrap()
        .parse::<u32>()
        .unwrap();
    assert_ne!(host_pid, 1);
    println!("{host_pid}");
    std::io::stdout().flush().unwrap();
    loop {
        unsafe {
            libc::pause();
        }
    }
}
fn worker(record: &Path) {
    assert_eq!(
        unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) },
        0
    );
    let record = serde_json::from_slice(&fs::read(record).unwrap()).unwrap();
    let group = CapturedGroup::restore(&record).unwrap();
    // The original namespace still has both real tasks at this point.
    assert!(group.only_worker().is_err());
    println!("joined_original_live_leaf");
    std::io::stdout().flush().unwrap();
    let mut command = String::new();
    std::io::stdin().read_line(&mut command).unwrap();
    assert_eq!(command.trim(), "confirm_original_tasks_gone");
    group.only_worker().unwrap();
    fs::write(record_path(&record), b"sole_actual_worker").unwrap();
    // Parent uses actual cgroup.kill as a separate negative/control case.
    let mut byte = [0];
    let _ = std::io::stdin().read(&mut byte);
}
fn record_path(record: &pgcf_sandbox_controller::pool_io::GroupRecord) -> PathBuf {
    std::env::temp_dir()
        .join(format!("pgcf-handoff-{}", record.pod_uid))
        .join("sole")
}
struct Owned {
    root: PathBuf,
    group: PathBuf,
    leaf: PathBuf,
    files: PathBuf,
    children: Vec<Child>,
}
impl Drop for Owned {
    fn drop(&mut self) {
        if self.leaf.exists() {
            fs::write(self.leaf.join("cgroup.kill"), "1").unwrap();
        }
        for child in &mut self.children {
            let _ = child.kill();
            let _ = child.wait();
        }
        if self.leaf.exists() {
            let end = Instant::now() + Duration::from_secs(5);
            while fs::read_to_string(self.leaf.join("cgroup.events"))
                .unwrap()
                .lines()
                .any(|l| l == "populated 1")
            {
                assert!(Instant::now() < end, "owned cgroup still populated");
                std::thread::sleep(Duration::from_millis(5));
            }
            fs::remove_dir(&self.leaf).unwrap();
        }
        fs::remove_dir(&self.group).unwrap();
        fs::remove_dir(self.root.join("kubepods")).unwrap();
        fs::remove_dir(&self.root).unwrap();
        fs::remove_dir_all(&self.files).unwrap();
        println!("owned_handoff_cgroups_processes_files_cleaned=true");
    }
}
fn main() {
    let args = std::env::args_os().collect::<Vec<_>>();
    if args.len() == 3 && args[1] == "--namespace" {
        original_namespace(Path::new(&args[2]));
        return;
    }
    if args.len() == 3 && args[1] == "--worker" {
        worker(Path::new(&args[2]));
        return;
    }
    assert_eq!(args.len(), 2);
    assert_eq!(args[1], "--owned-kernel-fixture");
    assert_eq!(unsafe { libc::geteuid() }, 0);
    let pod = fs::read_to_string("/proc/sys/kernel/random/uuid")
        .unwrap()
        .trim()
        .to_owned();
    let cid = "c".repeat(64);
    let root = PathBuf::from("/sys/fs/cgroup").join(format!("pgcf-handoff-{pod}"));
    let group = root.join("kubepods").join(format!("pod{pod}"));
    let leaf = group.join(&cid);
    fs::create_dir_all(&leaf).unwrap();
    let files = std::env::temp_dir().join(format!("pgcf-handoff-{pod}"));
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    fs::DirBuilder::new().mode(0o700).create(&files).unwrap();
    let mut owned = Owned {
        root,
        group,
        leaf,
        files,
        children: vec![],
    };
    let executable = std::env::current_exe().unwrap();
    owned.children.push(
        Command::new(&executable)
            .arg("--namespace")
            .arg(&owned.leaf)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let pid = line(&mut owned.children[0]).trim().parse::<u32>().unwrap();
    let original = Process::capture(pid, &pod, &cid).unwrap();
    let record = original.group_record();
    let captured = CapturedGroup::restore(&record).unwrap();
    let record_file = owned.files.join("record.json");
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&record_file)
        .unwrap();
    file.write_all(&serde_json::to_vec(&record).unwrap())
        .unwrap();
    file.sync_all().unwrap();
    drop(file);
    let procs = owned.leaf.join("cgroup.procs");
    let mut command = Command::new(&executable);
    command
        .arg("--worker")
        .arg(&record_file)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    unsafe {
        command.pre_exec(move || {
            fs::write(&procs, std::process::id().to_string())?;
            Ok(())
        });
    }
    owned.children.push(command.spawn().unwrap());
    assert_eq!(
        line(&mut owned.children[1]).trim(),
        "joined_original_live_leaf"
    );
    let current = Process::capture(owned.children[1].id(), &pod, &cid).unwrap();
    assert_eq!(current.cgroup_inode, original.cgroup_inode);
    assert_ne!(current.pid_namespace, original.pid_namespace);
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    assert!(fd >= 0);
    let pidfd = unsafe { OwnedFd::from_raw_fd(fd as i32) };
    original.recheck().unwrap();
    assert_eq!(
        unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                pidfd.as_raw_fd(),
                libc::SIGKILL,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            )
        },
        0
    );
    assert!(wait(&mut owned.children[0]).success());
    assert!(original.recheck().is_err());
    current.recheck().unwrap();
    captured.recheck().unwrap();
    owned.children[1]
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"confirm_original_tasks_gone\n")
        .unwrap();
    let end = Instant::now() + Duration::from_secs(5);
    while !record_path(&record).exists() {
        assert!(
            Instant::now() < end,
            "actual original-task closure unconfirmed"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        fs::remove_dir(&owned.leaf).unwrap_err().raw_os_error(),
        Some(libc::EBUSY)
    );
    println!(
        "actual_pid_namespace_init_and_descendants_stopped=true host_worker_survived_in_original_inode=true exact_sole_worker_measured=true"
    );
    captured.stop().unwrap();
    assert!(!wait(&mut owned.children[1]).success());
    assert!(!captured.populated().unwrap());
    println!(
        "actual_cgroup_kill_still_stops_cleanup_worker=true cri_teardown_custody_unproved=true"
    );
}

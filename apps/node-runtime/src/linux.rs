//! Linux-only prepared namespace holder. No Kubernetes readiness is emitted here.

use crate::protocol::{self, Assignment, NamespaceIdentity};
use std::fs::File;
use std::io;
use std::mem::{self, MaybeUninit};
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::Path;
use std::time::{Duration, Instant};

#[derive(Debug)]
pub struct RuntimeError(pub &'static str);
impl std::fmt::Display for RuntimeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for RuntimeError {}
type Result<T> = std::result::Result<T, RuntimeError>;

fn syscall_ok(value: libc::c_int, code: &'static str) -> Result<()> {
    if value == -1 {
        Err(RuntimeError(code))
    } else {
        Ok(())
    }
}

pub fn namespace_identity(fd: BorrowedFd<'_>) -> Result<NamespaceIdentity> {
    let mut stat = MaybeUninit::<libc::stat>::uninit();
    // SAFETY: fstat initializes this correctly sized output on success.
    syscall_ok(
        unsafe { libc::fstat(fd.as_raw_fd(), stat.as_mut_ptr()) },
        "namespace_stat_failed",
    )?;
    // SAFETY: successful fstat initialized stat.
    let stat = unsafe { stat.assume_init() };
    Ok(NamespaceIdentity {
        device: stat.st_dev,
        inode: stat.st_ino,
    })
}

pub fn network_namespace_identity(fd: BorrowedFd<'_>) -> Result<NamespaceIdentity> {
    // NS_GET_NSTYPE is _IO(0xb7, 0x3), from Linux uapi/linux/nsfs.h.
    // SAFETY: this ioctl has no pointer argument and only inspects the provided FD.
    let kind = unsafe { libc::ioctl(fd.as_raw_fd(), 0xb703) };
    if kind != libc::CLONE_NEWNET {
        return Err(RuntimeError("not_network_namespace"));
    }
    namespace_identity(fd)
}

fn current_namespace(kind: &str) -> Result<NamespaceIdentity> {
    let file = File::open(format!("/proc/self/ns/{kind}"))
        .map_err(|_| RuntimeError("own_namespace_open_failed"))?;
    namespace_identity(file.as_fd())
}

fn monotonic_ns() -> Result<u128> {
    let mut time = MaybeUninit::<libc::timespec>::uninit();
    // SAFETY: clock_gettime initializes the correctly sized output.
    syscall_ok(
        unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, time.as_mut_ptr()) },
        "clock_failed",
    )?;
    // SAFETY: successful clock_gettime initialized time.
    let time = unsafe { time.assume_init() };
    Ok(time.tv_sec as u128 * 1_000_000_000 + time.tv_nsec as u128)
}

fn poll_readable(fd: BorrowedFd<'_>, deadline: Instant) -> Result<()> {
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or(RuntimeError("slot_expired"))?;
        let millis = remaining.as_millis().clamp(1, i32::MAX as u128) as i32;
        let mut poll = libc::pollfd {
            fd: fd.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: poll receives exactly one valid initialized pollfd.
        let ret = unsafe { libc::poll(&mut poll, 1, millis) };
        if ret == -1 && io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
            continue;
        }
        if ret == -1 {
            return Err(RuntimeError("socket_poll_failed"));
        }
        if ret == 0 {
            return Err(RuntimeError("slot_expired"));
        }
        if poll.revents & libc::POLLIN != 0 {
            return Ok(());
        }
        return Err(RuntimeError("assignment_channel_closed"));
    }
}

fn peer_is_authorized(fd: BorrowedFd<'_>, expected_uid: u32) -> Result<()> {
    let mut peer = MaybeUninit::<libc::ucred>::uninit();
    let mut length = mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: getsockopt initializes ucred and its length for this connected local socket.
    syscall_ok(
        unsafe {
            libc::getsockopt(
                fd.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                peer.as_mut_ptr().cast(),
                &mut length,
            )
        },
        "peer_credentials_failed",
    )?;
    if length as usize != mem::size_of::<libc::ucred>() {
        return Err(RuntimeError("peer_credentials_failed"));
    }
    // SAFETY: successful getsockopt returned a complete ucred.
    if unsafe { peer.assume_init() }.uid != expected_uid {
        return Err(RuntimeError("peer_not_authorized"));
    }
    Ok(())
}

// libc uses different cmsg_len integer types on GNU and musl Linux.
#[allow(clippy::unnecessary_cast)]
fn receive_message(fd: BorrowedFd<'_>) -> Result<(Vec<u8>, OwnedFd)> {
    let mut wire = [0_u8; protocol::MAX_MESSAGE_BYTES + 1];
    let mut iov = libc::iovec {
        iov_base: wire.as_mut_ptr().cast(),
        iov_len: wire.len(),
    };
    // usize alignment is sufficient for cmsghdr; capacity bounds ancillary allocation.
    let mut control = [0_usize; 16];
    // SAFETY: zero is the empty initialized state of msghdr.
    let mut message: libc::msghdr = unsafe { mem::zeroed() };
    message.msg_iov = &mut iov;
    message.msg_iovlen = 1;
    message.msg_control = control.as_mut_ptr().cast();
    message.msg_controllen = mem::size_of_val(&control) as _;
    // SAFETY: all msghdr buffers are valid, bounded, and live for this call.
    let length = unsafe {
        libc::recvmsg(
            fd.as_raw_fd(),
            &mut message,
            libc::MSG_CMSG_CLOEXEC | libc::MSG_DONTWAIT,
        )
    };
    if length < 0 {
        return Err(RuntimeError("assignment_receive_failed"));
    }
    let mut received = Vec::<OwnedFd>::new();
    let mut unexpected = false;
    // Consume every received FD before checking message errors so RAII closes them on rejection.
    // SAFETY: CMSG iteration stays within the kernel-returned ancillary buffer.
    unsafe {
        let mut header = libc::CMSG_FIRSTHDR(&message);
        while !header.is_null() {
            let h = &*header;
            if h.cmsg_level == libc::SOL_SOCKET && h.cmsg_type == libc::SCM_RIGHTS {
                let base = libc::CMSG_LEN(0) as usize;
                let ancillary_len = h.cmsg_len as usize;
                if ancillary_len < base
                    || !(ancillary_len - base).is_multiple_of(mem::size_of::<libc::c_int>())
                {
                    unexpected = true;
                } else {
                    let count = (ancillary_len - base) / mem::size_of::<libc::c_int>();
                    let data = libc::CMSG_DATA(header).cast::<libc::c_int>();
                    for i in 0..count {
                        received.push(OwnedFd::from_raw_fd(*data.add(i)));
                    }
                }
            } else {
                unexpected = true;
            }
            header = libc::CMSG_NXTHDR(&message, header);
        }
    }
    if length == 0 {
        return Err(RuntimeError("assignment_receive_failed"));
    }
    if message.msg_flags & (libc::MSG_TRUNC | libc::MSG_CTRUNC) != 0
        || length as usize > protocol::MAX_MESSAGE_BYTES
    {
        return Err(RuntimeError("assignment_truncated"));
    }
    if unexpected || received.len() != 1 {
        return Err(RuntimeError("assignment_requires_one_fd"));
    }
    Ok((
        wire[..length as usize].to_vec(),
        received.pop().expect("one FD checked"),
    ))
}

fn bind_listener(path: &Path) -> Result<OwnedFd> {
    let parent = path.parent().ok_or(RuntimeError("socket_parent_invalid"))?;
    let metadata =
        std::fs::symlink_metadata(parent).map_err(|_| RuntimeError("socket_parent_invalid"))?;
    // SAFETY: geteuid has no preconditions.
    if !metadata.is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o777 != 0o700
    {
        return Err(RuntimeError("socket_parent_not_private"));
    }
    let bytes = path.as_os_str().as_encoded_bytes();
    // SAFETY: zero initializes sockaddr_un and all of its path bytes.
    let mut address: libc::sockaddr_un = unsafe { mem::zeroed() };
    if !path.is_absolute() || bytes.contains(&0) || bytes.len() >= address.sun_path.len() {
        return Err(RuntimeError("socket_path_invalid"));
    }
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    for (to, from) in address.sun_path.iter_mut().zip(bytes) {
        *to = *from as libc::c_char;
    }
    // SAFETY: socket has no pointer arguments; a successful FD becomes uniquely owned.
    let raw = unsafe {
        libc::socket(
            libc::AF_UNIX,
            libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK,
            0,
        )
    };
    if raw == -1 {
        return Err(RuntimeError("socket_create_failed"));
    }
    // SAFETY: raw is a new successful socket FD.
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    // bind never unlinks an existing path. A prior slot is not silently replaced.
    // SAFETY: address is a complete initialized sockaddr_un of the declared size.
    syscall_ok(
        unsafe {
            libc::bind(
                fd.as_raw_fd(),
                (&address as *const libc::sockaddr_un).cast(),
                mem::size_of_val(&address) as libc::socklen_t,
            )
        },
        "socket_bind_failed",
    )?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|_| RuntimeError("socket_permissions_failed"))?;
    // SAFETY: fd is a bound sequence-packet socket.
    syscall_ok(
        unsafe { libc::listen(fd.as_raw_fd(), 1) },
        "socket_listen_failed",
    )?;
    Ok(fd)
}

#[repr(C)]
struct CapHeader {
    version: u32,
    pid: libc::c_int,
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CapData {
    effective: u32,
    permitted: u32,
    inheritable: u32,
}

fn drop_capabilities() -> Result<()> {
    // Clear ambient and bounding sets while CAP_SETPCAP is still present.
    // SAFETY: these prctl operations take only integer arguments.
    syscall_ok(
        unsafe {
            libc::prctl(
                libc::PR_CAP_AMBIENT,
                libc::PR_CAP_AMBIENT_CLEAR_ALL,
                0,
                0,
                0,
            )
        },
        "ambient_capability_drop_failed",
    )?;
    for cap in 0..64 {
        // SAFETY: this reads only the current process's capability bounding set.
        let present = unsafe { libc::prctl(libc::PR_CAPBSET_READ, cap, 0, 0, 0) };
        if present == -1 && io::Error::last_os_error().raw_os_error() == Some(libc::EINVAL) {
            break;
        }
        if present == -1 {
            return Err(RuntimeError("bounding_capability_read_failed"));
        }
        if present == 1 {
            // SAFETY: this irreversibly removes only the current process's capability.
            syscall_ok(
                unsafe { libc::prctl(libc::PR_CAPBSET_DROP, cap, 0, 0, 0) },
                "bounding_capability_drop_failed",
            )?;
        }
    }
    let header = CapHeader {
        version: 0x2008_0522,
        pid: 0,
    }; // Linux capability API v3.
    let empty = [CapData::default(); 2];
    // SAFETY: Linux capability v3 uses one header and two correctly laid-out data words.
    if unsafe { libc::syscall(libc::SYS_capset, &header, empty.as_ptr()) } == -1 {
        return Err(RuntimeError("capability_drop_failed"));
    }
    // SAFETY: this permanently disables privilege gains for the current process.
    syscall_ok(
        unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) },
        "no_new_privileges_failed",
    )?;
    let mut observed = [CapData::default(); 2];
    // SAFETY: capget initializes both words for the current process.
    if unsafe { libc::syscall(libc::SYS_capget, &header, observed.as_mut_ptr()) } == -1 {
        return Err(RuntimeError("capability_readback_failed"));
    }
    if observed.iter().any(|c| c.effective != 0 || c.permitted != 0 || c.inheritable != 0)
        // SAFETY: this reads the current process's no-new-privileges flag.
        || unsafe { libc::prctl(libc::PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) } != 1
    {
        return Err(RuntimeError("privilege_drop_not_observed"));
    }
    Ok(())
}

extern "C" fn terminate(_: libc::c_int) {
    // SAFETY: _exit is async-signal-safe and this process owns no tenant runtime.
    unsafe { libc::_exit(0) }
}

/// Prepare genuinely private namespaces, accept one authenticated descriptor assignment, then
/// hold the assigned namespaces without privileges. The supervisor destroys this process.
pub fn run_slot(
    socket: &Path,
    slot_id: [u8; 16],
    controller_uid: u32,
    lifetime: Duration,
) -> Result<()> {
    if lifetime.is_zero() || lifetime > Duration::from_secs(300) {
        return Err(RuntimeError("slot_lifetime_invalid"));
    }
    if slot_id == [0; 16] {
        return Err(RuntimeError("slot_id_invalid"));
    }
    let tasks = std::fs::read_dir("/proc/self/task")
        .map_err(|_| RuntimeError("thread_inventory_failed"))?;
    if tasks.take(2).count() != 1 {
        return Err(RuntimeError("single_thread_required"));
    }
    let expires = Instant::now() + lifetime;
    let original = [
        current_namespace("net")?,
        current_namespace("ipc")?,
        current_namespace("uts")?,
    ];
    // SAFETY: this single-threaded binary unshares only its own namespaces before listening.
    syscall_ok(
        unsafe { libc::unshare(libc::CLONE_NEWNET | libc::CLONE_NEWIPC | libc::CLONE_NEWUTS) },
        "namespace_prepare_failed",
    )?;
    let prepared = [
        current_namespace("net")?,
        current_namespace("ipc")?,
        current_namespace("uts")?,
    ];
    if original
        .iter()
        .zip(prepared)
        .any(|(before, after)| *before == after)
    {
        return Err(RuntimeError("namespace_isolation_not_observed"));
    }
    // SAFETY: sigaction receives a correctly initialized signal action and mask.
    let mut action: libc::sigaction = unsafe { mem::zeroed() };
    action.sa_sigaction = terminate as *const () as usize;
    unsafe {
        libc::sigemptyset(&mut action.sa_mask);
    }
    syscall_ok(
        unsafe { libc::sigaction(libc::SIGTERM, &action, std::ptr::null_mut()) },
        "termination_handler_failed",
    )?;
    let listener = bind_listener(socket)?;
    let hex: String = slot_id.iter().map(|b| format!("{b:02x}")).collect();
    println!(
        "{{\"version\":1,\"event\":\"prepared\",\"slot_id\":\"{hex}\",\"pid_namespace_local\":{},\"prepared_at_monotonic_ns\":{},\"network_inode\":{},\"ipc_inode\":{},\"uts_inode\":{}}}",
        std::process::id(),
        monotonic_ns()?,
        prepared[0].inode,
        prepared[1].inode,
        prepared[2].inode
    );
    poll_readable(listener.as_fd(), expires)?;
    // SAFETY: accept4 returns a new owned connected local socket or an error.
    let raw = unsafe {
        libc::accept4(
            listener.as_raw_fd(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK,
        )
    };
    if raw == -1 {
        return Err(RuntimeError("assignment_accept_failed"));
    }
    // SAFETY: successful accept4 returned a new unique FD.
    let connection = unsafe { OwnedFd::from_raw_fd(raw) };
    drop(listener); // Exactly one attempt, including malformed or unauthorized attempts.
    peer_is_authorized(connection.as_fd(), controller_uid)?;
    poll_readable(
        connection.as_fd(),
        expires.min(Instant::now() + Duration::from_secs(1)),
    )?;
    let (wire, network_fd) = receive_message(connection.as_fd())?;
    let Assignment {
        network, hostname, ..
    } = protocol::decode(&wire, &slot_id)
        .map_err(|_| RuntimeError("assignment_message_invalid"))?;
    if network_namespace_identity(network_fd.as_fd())? != network || network == prepared[0] {
        return Err(RuntimeError("namespace_binding_mismatch"));
    }
    if Instant::now() >= expires {
        return Err(RuntimeError("slot_expired"));
    }
    // SAFETY: validated NSFS network FD remains owned and open for the whole transition.
    syscall_ok(
        unsafe { libc::setns(network_fd.as_raw_fd(), libc::CLONE_NEWNET) },
        "network_assignment_failed",
    )?;
    drop(network_fd);
    if current_namespace("net")? != network {
        return Err(RuntimeError("network_assignment_not_observed"));
    }
    // SAFETY: hostname is bounded ASCII and affects the helper's private UTS namespace only.
    syscall_ok(
        unsafe { libc::sethostname(hostname.as_ptr().cast(), hostname.len()) },
        "hostname_assignment_failed",
    )?;
    drop_capabilities()?;
    // No second request is accepted, even if acknowledgement delivery becomes uncertain.
    let ack = b"assigned\n";
    // SAFETY: ack is valid for its full length; MSG_NOSIGNAL prevents a lost caller killing us.
    let sent = unsafe {
        libc::send(
            connection.as_raw_fd(),
            ack.as_ptr().cast(),
            ack.len(),
            libc::MSG_NOSIGNAL,
        )
    };
    if sent != ack.len() as isize {
        return Err(RuntimeError("assignment_acknowledgement_failed"));
    }
    drop(connection);
    println!(
        "{{\"version\":1,\"event\":\"assigned\",\"slot_id\":\"{hex}\",\"pid_namespace_local\":{},\"network_inode\":{},\"capabilities_dropped\":true,\"no_new_privileges\":true}}",
        std::process::id(),
        network.inode
    );
    loop {
        // SAFETY: all capabilities and assignment channels are gone; only termination remains.
        unsafe {
            libc::pause();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixStream;

    #[test]
    fn real_namespace_fd_is_distinguished_from_regular_fd_and_other_namespace() {
        let network = File::open("/proc/self/ns/net").unwrap();
        assert!(network_namespace_identity(network.as_fd()).is_ok());
        for path in ["/dev/null", "/proc/self/ns/uts"] {
            assert_eq!(
                network_namespace_identity(File::open(path).unwrap().as_fd())
                    .unwrap_err()
                    .0,
                "not_network_namespace"
            );
        }
    }

    #[test]
    fn connected_kernel_peer_credentials_reject_another_uid() {
        let (one, _) = UnixStream::pair().unwrap();
        // SAFETY: geteuid has no preconditions.
        let uid = unsafe { libc::geteuid() };
        assert!(peer_is_authorized(one.as_fd(), uid).is_ok());
        assert_eq!(
            peer_is_authorized(one.as_fd(), uid.wrapping_add(1))
                .unwrap_err()
                .0,
            "peer_not_authorized"
        );
    }
    fn rejected_rights_leave_no_pipe_writer(wire: &[u8], descriptor_count: usize) {
        let mut sockets = [0; 2];
        let mut pipe = [0; 2];
        // SAFETY: socketpair/pipe2 initialize two correctly sized output descriptors each.
        assert_eq!(
            unsafe {
                libc::socketpair(
                    libc::AF_UNIX,
                    libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC,
                    0,
                    sockets.as_mut_ptr(),
                )
            },
            0
        );
        assert_eq!(
            unsafe { libc::pipe2(pipe.as_mut_ptr(), libc::O_CLOEXEC | libc::O_NONBLOCK) },
            0
        );
        // SAFETY: every raw descriptor was newly returned and has exactly one owner here.
        let (sender, receiver, read, writer) = unsafe {
            (
                OwnedFd::from_raw_fd(sockets[0]),
                OwnedFd::from_raw_fd(sockets[1]),
                OwnedFd::from_raw_fd(pipe[0]),
                OwnedFd::from_raw_fd(pipe[1]),
            )
        };
        let mut iov = libc::iovec {
            iov_base: wire.as_ptr() as *mut _,
            iov_len: wire.len(),
        };
        let control_bytes =
            unsafe { libc::CMSG_SPACE((descriptor_count * mem::size_of::<libc::c_int>()) as u32) }
                as usize;
        let mut control = vec![0_usize; control_bytes.div_ceil(mem::size_of::<usize>())];
        let mut message: libc::msghdr = unsafe { mem::zeroed() };
        message.msg_iov = &mut iov;
        message.msg_iovlen = 1;
        message.msg_control = control.as_mut_ptr().cast();
        message.msg_controllen = control_bytes as _;
        // SAFETY: CMSG_SPACE allocated sufficient aligned storage for every descriptor.
        unsafe {
            let header = libc::CMSG_FIRSTHDR(&message);
            (*header).cmsg_level = libc::SOL_SOCKET;
            (*header).cmsg_type = libc::SCM_RIGHTS;
            (*header).cmsg_len =
                libc::CMSG_LEN((descriptor_count * mem::size_of::<libc::c_int>()) as u32) as _;
            let data = libc::CMSG_DATA(header).cast::<libc::c_int>();
            for index in 0..descriptor_count {
                *data.add(index) = writer.as_raw_fd();
            }
            assert_eq!(
                libc::sendmsg(sender.as_raw_fd(), &message, libc::MSG_NOSIGNAL),
                wire.len() as isize
            );
        }
        drop(writer);
        assert!(receive_message(receiver.as_fd()).is_err());
        let mut byte = 0_u8;
        // EOF proves that every receiver-side writer copy was closed. A leaked FD gives EAGAIN.
        assert_eq!(
            unsafe { libc::read(read.as_raw_fd(), (&mut byte as *mut u8).cast(), 1) },
            0,
            "rejected ancillary descriptors leaked a pipe writer"
        );
    }

    #[test]
    fn zero_byte_rights_packet_is_rejected_without_leaking_descriptors() {
        rejected_rights_leave_no_pipe_writer(&[], 1);
    }

    #[test]
    fn extra_and_truncated_rights_are_closed_on_rejection() {
        rejected_rights_leave_no_pipe_writer(b"invalid", 2);
        rejected_rights_leave_no_pipe_writer(&[0; protocol::MAX_MESSAGE_BYTES + 10], 1);
        rejected_rights_leave_no_pipe_writer(b"invalid", 40);
    }
}

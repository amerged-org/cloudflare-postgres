// SPDX-License-Identifier: Apache-2.0
use pgcf_pool_supervisor::agent_frame::receive;
use serde_json::json;
use std::{
    ffi::CString,
    io::Write,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::net::UnixStream,
    },
    time::{Duration, Instant},
};

fn descriptor() -> OwnedFd {
    let path = CString::new("/").unwrap();
    let fd = unsafe {
        libc::openat(
            libc::AT_FDCWD,
            path.as_ptr(),
            libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    assert!(fd >= 0);
    unsafe { OwnedFd::from_raw_fd(fd) }
}

#[test]
fn actual_socket_drip_cannot_extend_the_aggregate_receive_deadline() {
    let (mut writer, reader) = UnixStream::pair().unwrap();
    let sender = std::thread::spawn(move || {
        writer.write_all(b"{").unwrap();
        std::thread::sleep(Duration::from_secs(4));
        let _ = writer.write_all(b" ");
        std::thread::sleep(Duration::from_secs(4));
    });
    let began = Instant::now();
    assert!(receive(&reader).is_err());
    let elapsed = began.elapsed();
    sender.join().unwrap();
    assert!(
        elapsed < Duration::from_secs(6),
        "frame deadline drifted: {elapsed:?}"
    );
}
fn send(socket: &UnixStream, fds: &[&OwnedFd]) {
    let bytes = b"{\"signal\":{\"command\":\"inspect_readonly\"}}";
    let mut vector = libc::iovec {
        iov_base: bytes.as_ptr().cast_mut().cast(),
        iov_len: bytes.len(),
    };
    let mut control = [0usize; 8];
    let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
    message.msg_iov = &mut vector;
    message.msg_iovlen = 1;
    if !fds.is_empty() {
        message.msg_control = control.as_mut_ptr().cast();
        message.msg_controllen =
            unsafe { libc::CMSG_SPACE((fds.len() * std::mem::size_of::<i32>()) as u32) } as _;
        let header = unsafe { libc::CMSG_FIRSTHDR(&message) };
        unsafe {
            (*header).cmsg_level = libc::SOL_SOCKET;
            (*header).cmsg_type = libc::SCM_RIGHTS;
            (*header).cmsg_len =
                libc::CMSG_LEN((fds.len() * std::mem::size_of::<i32>()) as u32) as _;
            let data = libc::CMSG_DATA(header).cast::<i32>();
            for (index, fd) in fds.iter().enumerate() {
                data.add(index).write(fd.as_raw_fd());
            }
        }
    }
    assert_eq!(
        unsafe { libc::sendmsg(socket.as_raw_fd(), &message, libc::MSG_NOSIGNAL) },
        bytes.len() as isize
    );
    socket.shutdown(std::net::Shutdown::Write).unwrap();
}
#[test]
fn actual_rights_are_owned_cloexec_and_extra_descriptors_are_refused() {
    let fd = descriptor();
    let other = descriptor();
    for count in 0..=2 {
        let (left, right) = UnixStream::pair().unwrap();
        send(&left, &[&fd, &other][..count]);
        let frame = receive(&right);
        if count == 2 {
            assert!(frame.is_err());
            continue;
        }
        let (body, received) = frame.unwrap();
        assert_eq!(body, json!({"signal":{"command":"inspect_readonly"}}));
        assert_eq!(received.is_some(), count == 1);
        if let Some(received) = received {
            let raw = received.as_raw_fd();
            assert_ne!(
                unsafe { libc::fcntl(raw, libc::F_GETFD) } & libc::FD_CLOEXEC,
                0
            );
            drop(received);
            assert_eq!(unsafe { libc::fcntl(raw, libc::F_GETFD) }, -1);
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::EBADF)
            );
        }
    }
}

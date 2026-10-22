// SPDX-License-Identifier: Apache-2.0
//! The listening socket a service manager hands over (the protocol of `sd_listen_fds`, which
//! systemd.socket describes). A socket unit keeps the socket open while the gateway is replaced,
//! so a connection that arrives between the old process and the new one waits in the socket's
//! queue and the new process accepts it, instead of being refused. A gateway started without a
//! manager's socket binds its own.
use std::{
    io,
    net::TcpListener,
    os::fd::{FromRawFd, RawFd},
};

/// The first descriptor a service manager passes (`SD_LISTEN_FDS_START`).
const FIRST_DESCRIPTOR: RawFd = 3;

/// The listening socket the service manager passed to this process, or none if it passed none.
pub fn inherited() -> io::Result<Option<TcpListener>> {
    inherit(
        std::env::var("LISTEN_PID").ok().as_deref(),
        std::env::var("LISTEN_FDS").ok().as_deref(),
        std::process::id(),
        FIRST_DESCRIPTOR,
    )
}

/// [`inherited`] for the two variables, the process ID and the descriptor it is given. The
/// descriptor is touched only if the manager named this process: the variables are inherited by
/// children, which must not take over the socket of their parent.
fn inherit(
    pid: Option<&str>,
    count: Option<&str>,
    own: u32,
    descriptor: RawFd,
) -> io::Result<Option<TcpListener>> {
    let Some(pid) = pid else {
        return Ok(None);
    };
    if pid.parse() != Ok(own) {
        return Ok(None);
    }
    if count != Some("1") {
        return Err(io::Error::other(
            "the gateway takes exactly one socket from the service manager",
        ));
    }
    // SAFETY: the manager named this process in LISTEN_PID, so it passed the descriptor to it and
    // nothing else in the process owns it.
    let listener = unsafe { TcpListener::from_raw_fd(descriptor) };
    // The gateway serves cloudflared on loopback only, whatever the socket unit says.
    if !listener.local_addr()?.ip().is_loopback() {
        return Err(io::Error::other(
            "the socket of the service manager is not on loopback",
        ));
    }
    listener.set_nonblocking(true)?;
    Ok(Some(listener))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Read, net::TcpStream, os::fd::IntoRawFd};

    fn socket(address: &str) -> (RawFd, u16) {
        let listener = TcpListener::bind(address).unwrap();
        let port = listener.local_addr().unwrap().port();
        (listener.into_raw_fd(), port)
    }

    #[test]
    fn a_socket_the_manager_passed_to_this_process_is_taken_and_serves() {
        let (descriptor, port) = socket("127.0.0.1:0");
        let listener = inherit(Some("42"), Some("1"), 42, descriptor)
            .unwrap()
            .expect("the manager named this process");
        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let accepted = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(5))
                }
                Err(error) => panic!("{error}"),
            }
        };
        drop(accepted);
        let mut byte = [0; 1];
        assert_eq!(client.read(&mut byte).unwrap(), 0);
    }

    #[test]
    fn nothing_is_taken_without_the_variables_or_for_another_process() {
        let (descriptor, _) = socket("127.0.0.1:0");
        assert!(inherit(None, Some("1"), 42, descriptor).unwrap().is_none());
        // A child of the process the manager meant: the variables are its parent's.
        assert!(
            inherit(Some("41"), Some("1"), 42, descriptor)
                .unwrap()
                .is_none()
        );
        assert!(
            inherit(Some("not a pid"), Some("1"), 42, descriptor)
                .unwrap()
                .is_none()
        );
        // The descriptor was not touched, so it can still be taken by whoever it is meant for.
        assert!(
            inherit(Some("42"), Some("1"), 42, descriptor)
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn a_socket_that_is_not_exactly_one_loopback_listener_is_refused() {
        let (descriptor, _) = socket("127.0.0.1:0");
        assert!(inherit(Some("42"), Some("2"), 42, descriptor).is_err());
        assert!(inherit(Some("42"), None, 42, descriptor).is_err());
        let (open, _) = socket("0.0.0.0:0");
        assert!(inherit(Some("42"), Some("1"), 42, open).is_err());
        let file = std::fs::File::open("/dev/null").unwrap().into_raw_fd();
        assert!(inherit(Some("42"), Some("1"), 42, file).is_err());
    }
}

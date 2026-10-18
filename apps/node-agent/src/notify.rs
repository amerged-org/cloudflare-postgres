// SPDX-License-Identifier: Apache-2.0
//! `sd_notify(3)`: how a `Type=notify` unit tells systemd that it is ready. systemd names a datagram
//! socket in `NOTIFY_SOCKET`; the state is one datagram to it.
use std::{ffi::OsStr, io, os::unix::net::UnixDatagram};

/// Sends `state` (`READY=1`) to the socket systemd named, if it named one.
pub fn notify(state: &str) -> io::Result<()> {
    match std::env::var_os("NOTIFY_SOCKET") {
        Some(address) if !address.is_empty() => notify_to(&address, state),
        _ => Ok(()),
    }
}

/// Sends `state` to `address`: a path, or an abstract socket when it starts with `@`.
pub fn notify_to(address: &OsStr, state: &str) -> io::Result<()> {
    let socket = UnixDatagram::unbound()?;
    #[cfg(target_os = "linux")]
    if let Some(name) = std::os::unix::ffi::OsStrExt::as_bytes(address).strip_prefix(b"@") {
        use std::os::linux::net::SocketAddrExt;
        let address = std::os::unix::net::SocketAddr::from_abstract_name(name)?;
        socket.send_to_addr(state.as_bytes(), &address)?;
        return Ok(());
    }
    socket.send_to(state.as_bytes(), address)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn receive(socket: &UnixDatagram) -> String {
        let mut buffer = [0u8; 64];
        let length = socket.recv(&mut buffer).unwrap();
        String::from_utf8(buffer[..length].to_vec()).unwrap()
    }

    #[test]
    fn the_state_arrives_as_one_datagram_at_a_path() {
        let directory = crate::link::test_server::tempdir();
        let path = directory.join("notify");
        let listener = UnixDatagram::bind(&path).unwrap();
        notify_to(path.as_os_str(), "READY=1").unwrap();
        assert_eq!(receive(&listener), "READY=1");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn an_at_sign_names_an_abstract_socket() {
        use std::os::linux::net::SocketAddrExt;
        let name = format!("pgcf-notify-{}", std::process::id());
        let address = std::os::unix::net::SocketAddr::from_abstract_name(name.as_bytes()).unwrap();
        let listener = UnixDatagram::bind_addr(&address).unwrap();
        notify_to(OsStr::new(&format!("@{name}")), "READY=1").unwrap();
        assert_eq!(receive(&listener), "READY=1");
    }

    #[test]
    fn a_socket_nobody_listens_on_is_an_error_and_no_socket_at_all_is_not() {
        let directory = crate::link::test_server::tempdir();
        assert!(notify_to(directory.join("gone").as_os_str(), "READY=1").is_err());
        // The test process has no NOTIFY_SOCKET; a unit that systemd does not supervise runs on.
        if std::env::var_os("NOTIFY_SOCKET").is_none() {
            assert!(notify("READY=1").is_ok());
        }
    }
}

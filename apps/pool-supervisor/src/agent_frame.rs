// SPDX-License-Identifier: Apache-2.0
//! Bounded root-peer JSON frame; only inspection can consume its single owned directory FD.
use crate::Error;
use serde_json::Value;
use std::{
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::net::UnixStream,
    },
    time::{Duration, Instant},
};

pub fn receive(socket: &UnixStream) -> Result<(Value, Option<OwnedFd>), Error> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut bytes = Vec::new();
    let mut descriptors = Vec::new();
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or(Error("pool_agent_frame_unavailable"))?;
        socket
            .set_read_timeout(Some(remaining))
            .map_err(|_| Error("pool_agent_frame_unavailable"))?;
        let mut buffer = [0u8; 8192];
        let mut control = [0usize; 8];
        let mut vector = libc::iovec {
            iov_base: buffer.as_mut_ptr().cast(),
            iov_len: buffer.len(),
        };
        let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
        message.msg_iov = &mut vector;
        message.msg_iovlen = 1;
        message.msg_control = control.as_mut_ptr().cast();
        message.msg_controllen = std::mem::size_of_val(&control) as _;
        let count =
            unsafe { libc::recvmsg(socket.as_raw_fd(), &mut message, libc::MSG_CMSG_CLOEXEC) };
        if count < 0 {
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(Error("pool_agent_frame_unavailable"));
        }
        let mut valid = true;
        let mut header = unsafe { libc::CMSG_FIRSTHDR(&message) };
        while !header.is_null() {
            let length = unsafe { (*header).cmsg_len as usize };
            let base = unsafe { libc::CMSG_LEN(0) as usize };
            if length < base || length > message.msg_controllen as usize {
                valid = false;
                break;
            }
            if unsafe { (*header).cmsg_level } == libc::SOL_SOCKET
                && unsafe { (*header).cmsg_type } == libc::SCM_RIGHTS
            {
                let payload = length - base;
                if payload % std::mem::size_of::<i32>() != 0 {
                    valid = false;
                }
                let data = unsafe { libc::CMSG_DATA(header).cast::<i32>() };
                for index in 0..payload / std::mem::size_of::<i32>() {
                    let fd = unsafe { data.add(index).read_unaligned() };
                    if fd < 0 {
                        valid = false;
                    } else {
                        // Own every returned right before refusing the envelope; no leaked references.
                        descriptors.push(unsafe { OwnedFd::from_raw_fd(fd) });
                    }
                }
            } else {
                valid = false;
            }
            header = unsafe { libc::CMSG_NXTHDR(&message, header) };
        }
        if !valid
            || message.msg_flags & (libc::MSG_CTRUNC | libc::MSG_TRUNC) != 0
            || descriptors.len() > 1
        {
            return Err(Error("pool_agent_descriptors_refused"));
        }
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..count as usize]);
        if bytes.len() > 128 * 1024 {
            return Err(Error("pool_request_oversized"));
        }
    }
    let body = serde_json::from_slice(&bytes).map_err(|_| Error("pool_request_invalid"))?;
    Ok((body, descriptors.pop()))
}

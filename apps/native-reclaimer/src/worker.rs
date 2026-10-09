// SPDX-License-Identifier: Apache-2.0
//! One bounded kernel call. A revoked intent stops future calls, not a syscall already in progress.
use crate::Error;
use std::{fs::File, os::fd::AsRawFd};
pub struct Worker {
    pid: libc::pid_t,
}
#[derive(Clone, Copy, Debug)]
pub enum Outcome {
    Requested,
    Partial,
    Unknown,
}
impl Worker {
    pub fn start(file: File, bytes: u64) -> Result<Self, Error> {
        if unsafe { libc::geteuid() } != 65532 || unsafe { libc::getegid() } != 65532 {
            return Err("reclaimer must be unprivileged UID/GID65532".into());
        }
        let command = format!("{bytes} swappiness=max");
        let data = command.as_bytes();
        #[cfg(target_arch = "x86_64")]
        let arch = 0xc000003e;
        #[cfg(target_arch = "aarch64")]
        let arch = 0xc00000b7;
        let filter = [
            libc::sock_filter {
                code: 0x20,
                jt: 0,
                jf: 0,
                k: 4,
            },
            libc::sock_filter {
                code: 0x15,
                jt: 1,
                jf: 0,
                k: arch,
            },
            libc::sock_filter {
                code: 0x06,
                jt: 0,
                jf: 0,
                k: 0x80000000,
            },
            libc::sock_filter {
                code: 0x20,
                jt: 0,
                jf: 0,
                k: 0,
            },
            libc::sock_filter {
                code: 0x15,
                jt: 6,
                jf: 0,
                k: libc::SYS_exit as u32,
            },
            libc::sock_filter {
                code: 0x15,
                jt: 5,
                jf: 0,
                k: libc::SYS_exit_group as u32,
            },
            libc::sock_filter {
                code: 0x15,
                jt: 0,
                jf: 5,
                k: libc::SYS_write as u32,
            },
            libc::sock_filter {
                code: 0x20,
                jt: 0,
                jf: 0,
                k: 16,
            },
            libc::sock_filter {
                code: 0x15,
                jt: 2,
                jf: 0,
                k: 3,
            },
            libc::sock_filter {
                code: 0x06,
                jt: 0,
                jf: 0,
                k: 0x80000000,
            },
            libc::sock_filter {
                code: 0x06,
                jt: 0,
                jf: 0,
                k: 0x80000000,
            },
            libc::sock_filter {
                code: 0x06,
                jt: 0,
                jf: 0,
                k: 0x7fff0000,
            },
            libc::sock_filter {
                code: 0x06,
                jt: 0,
                jf: 0,
                k: 0x80000000,
            },
        ];
        let pid = unsafe { libc::fork() };
        if pid < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        if pid == 0 {
            unsafe {
                // Everything below is async-signal-safe; no allocation, logging or destructors after fork.
                if libc::dup2(file.as_raw_fd(), 3) < 0 {
                    libc::_exit(77);
                }
                if libc::syscall(libc::SYS_close_range, 4u32, u32::MAX, 0u32) < 0 {
                    libc::_exit(78);
                }
                if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                    libc::_exit(79);
                }
                let mut program = libc::sock_fprog {
                    len: filter.len() as u16,
                    filter: filter.as_ptr() as *mut libc::sock_filter,
                };
                if libc::prctl(
                    libc::PR_SET_SECCOMP,
                    libc::SECCOMP_MODE_FILTER,
                    &mut program,
                    0usize,
                    0usize,
                ) != 0
                {
                    libc::_exit(80);
                }
                let result = libc::write(3, data.as_ptr().cast(), data.len());
                libc::_exit(if result == data.len() as isize {
                    0
                } else if result < 0 && *libc::__errno_location() == libc::EAGAIN {
                    75
                } else {
                    76
                });
            }
        }
        Ok(Self { pid })
    }
    pub fn poll(&mut self) -> Result<Option<Outcome>, Error> {
        let mut status = 0;
        let result = unsafe { libc::waitpid(self.pid, &mut status, libc::WNOHANG) };
        if result < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        if result == 0 {
            return Ok(None);
        }
        Ok(Some(if libc::WIFEXITED(status) {
            match libc::WEXITSTATUS(status) {
                0 => Outcome::Requested,
                75 => Outcome::Partial,
                _ => Outcome::Unknown,
            }
        } else {
            Outcome::Unknown
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Read,
        os::{fd::FromRawFd, unix::process::CommandExt},
    };
    fn kernel_enforcement_available() -> bool {
        let instruction = libc::sock_filter {
            code: 0x06,
            jt: 0,
            jf: 0,
            k: 0x7fff0000,
        };
        let pid = unsafe { libc::fork() };
        assert!(pid >= 0);
        if pid == 0 {
            unsafe {
                let program = libc::sock_fprog {
                    len: 1,
                    filter: &instruction as *const _ as *mut _,
                };
                let available = libc::syscall(libc::SYS_close_range, 4u32, u32::MAX, 0u32) == 0
                    && libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0
                    && libc::prctl(
                        libc::PR_SET_SECCOMP,
                        libc::SECCOMP_MODE_FILTER,
                        &program,
                        0usize,
                        0usize,
                    ) == 0;
                libc::_exit(if available { 0 } else { 1 });
            }
        }
        let mut status = 0;
        assert_eq!(unsafe { libc::waitpid(pid, &mut status, 0) }, pid);
        libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == 0
    }
    #[test]
    fn unprivileged_worker_performs_one_scoped_write_with_seccomp() {
        let uid = unsafe { libc::geteuid() };
        if uid == 0 {
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "worker::tests::unprivileged_worker_performs_one_scoped_write_with_seccomp",
                ])
                .uid(65532)
                .gid(65532)
                .status()
                .unwrap();
            assert!(status.success());
            return;
        }
        let mut fds = [0; 2];
        assert_eq!(unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) }, 0);
        let mut input = unsafe { File::from_raw_fd(fds[0]) };
        let output = unsafe { File::from_raw_fd(fds[1]) };
        if uid != 65532 {
            assert!(Worker::start(output, 4096).is_err());
            return;
        }
        let enforcement = kernel_enforcement_available();
        let worker = Worker::start(output, 4096).unwrap();
        let mut received = String::new();
        input.read_to_string(&mut received).unwrap();
        let mut status = 0;
        assert_eq!(
            unsafe { libc::waitpid(worker.pid, &mut status, 0) },
            worker.pid
        );
        assert!(
            libc::WIFEXITED(status),
            "unexpected kernel worker wait status:{status}"
        );
        if enforcement {
            assert_eq!(libc::WEXITSTATUS(status), 0, "kernel worker stage failed");
            assert_eq!(received, "4096 swappiness=max");
        } else {
            assert!(
                [78, 79, 80].contains(&libc::WEXITSTATUS(status)),
                "unexpected refused kernel stage:{}",
                libc::WEXITSTATUS(status)
            );
            assert!(
                received.is_empty(),
                "unprotected kernel write must never occur"
            );
        }
    }
}

// SPDX-License-Identifier: Apache-2.0
include!(concat!(env!("OUT_DIR"), "/_.rs"));
// Upstream protobuf comments are retained verbatim; their list indentation is not first-party Rust documentation.
#[allow(clippy::doc_lazy_continuation)]
pub mod containerd {
    pub mod types {
        tonic::include_proto!("containerd.types");
    }
    pub mod v1 {
        pub mod types {
            tonic::include_proto!("containerd.v1.types");
        }
    }
    pub mod services {
        pub mod sandbox {
            pub mod v1 {
                tonic::include_proto!("containerd.services.sandbox.v1");
            }
        }
        pub mod containers {
            pub mod v1 {
                tonic::include_proto!("containerd.services.containers.v1");
            }
        }
        pub mod tasks {
            pub mod v1 {
                tonic::include_proto!("containerd.services.tasks.v1");
            }
        }
    }
    pub mod runtime {
        pub mod bootstrap {
            pub mod v1 {
                tonic::include_proto!("containerd.runtime.bootstrap.v1");
            }
        }
    }
    pub mod task {
        pub mod v3 {
            tonic::include_proto!("containerd.task.v3");
        }
    }
}
#[allow(clippy::doc_lazy_continuation)]
pub mod cri {
    tonic::include_proto!("runtime.v1");
}
pub mod csi {
    tonic::include_proto!("csi.v1");
}
pub mod ttrpc {
    tonic::include_proto!("ttrpc");
}
#[cfg(target_os = "linux")]
pub mod cgroup;
#[cfg(target_os = "linux")]
pub mod configuration;
#[cfg(target_os = "linux")]
pub mod controller;
#[cfg(target_os = "linux")]
pub mod host_context;
#[cfg(target_os = "linux")]
pub mod host_proc;
pub mod policy;
#[cfg(target_os = "linux")]
pub mod pool_attestation;
#[cfg(target_os = "linux")]
mod pool_child;
#[cfg(target_os = "linux")]
pub mod pool_csi;
#[cfg(target_os = "linux")]
pub mod pool_custody;
#[cfg(target_os = "linux")]
pub mod pool_device;
#[cfg(target_os = "linux")]
pub mod pool_driver;
#[cfg(target_os = "linux")]
pub mod pool_gate;
#[cfg(target_os = "linux")]
pub mod pool_guard;
#[cfg(target_os = "linux")]
pub mod pool_inspector;
#[cfg(target_os = "linux")]
pub mod pool_inventory;
#[cfg(target_os = "linux")]
pub mod pool_io;
#[cfg(target_os = "linux")]
pub mod pool_journal;
#[cfg(target_os = "linux")]
pub mod pool_mount;
#[cfg(target_os = "linux")]
pub mod pool_namespaces;
#[cfg(target_os = "linux")]
pub mod pool_permission;
#[cfg(target_os = "linux")]
pub mod pool_pregrant;
#[cfg(target_os = "linux")]
pub mod pool_qualification;
#[cfg(target_os = "linux")]
pub mod pool_read_worker;
#[cfg(target_os = "linux")]
pub mod pool_readonly;
#[cfg(target_os = "linux")]
pub mod pool_recovery;
#[cfg(target_os = "linux")]
pub mod pool_runtime;
#[cfg(target_os = "linux")]
pub mod pool_signal;
#[cfg(target_os = "linux")]
pub mod pool_worker;
#[cfg(target_os = "linux")]
pub mod reclaim_inventory;
#[cfg(target_os = "linux")]
mod sandbox_files;
#[cfg(target_os = "linux")]
pub mod slot;
#[cfg(target_os = "linux")]
pub mod storage;
#[cfg(target_os = "linux")]
pub mod storage_dm;
#[cfg(target_os = "linux")]
pub mod transport;

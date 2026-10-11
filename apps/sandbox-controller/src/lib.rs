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

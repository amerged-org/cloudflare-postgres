// SPDX-License-Identifier: Apache-2.0
fn main() -> Result<(), Box<dyn std::error::Error>> {
    tonic_prost_build::configure()
        .build_server(true)
        .build_transport(false)
        .disable_comments(["."])
        .compile_protos(
            &[
                "proto/services/sandbox/v1/sandbox.proto",
                "proto/services/containers/v1/containers.proto",
                "proto/services/tasks/v1/tasks.proto",
                "proto/runtime/bootstrap/v1/bootstrap.proto",
                "proto/runtime/task/v3/shim.proto",
                "proto/ttrpc.proto",
            ],
            &["proto"],
        )?;
    tonic_prost_build::configure()
        .build_client(true)
        .build_server(false)
        .disable_comments(["."])
        .compile_protos(&["proto/cri.proto"], &["proto"])?;
    println!("cargo:rerun-if-changed=proto");
    Ok(())
}

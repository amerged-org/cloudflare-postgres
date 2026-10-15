// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { runCommand } from "../src/bootstrap.ts";
import versions from "../../../infra/platform/versions.lock.json" with { type: "json" };

test("real pool device custody, descriptor mount, busy refusal and crash-durable gate", async () => {
  const repo = resolve(import.meta.dirname, "../../..");
  await mkdir(join(repo, ".local"), { recursive: true, mode: 0o700 });
  const privateRoot = await mkdtemp(join(repo, ".local", "pool-kernel-"));
  await chmod(privateRoot, 0o700);
  const source = join(privateRoot, "source");
  const output = join(privateRoot, "output");
  await mkdir(output, { mode: 0o700 });
  const container = `pgcf-pool-kernel-${randomUUID()}`;
  const fixture = "apps/sandbox-controller/tests/fixtures/pool-kernel";
  const sourceHash = createHash("sha256").update(repo);
  const selected = [
    "apps/sandbox-controller/src/pool_mount.rs",
    "apps/sandbox-controller/src/pool_gate.rs",
    "apps/sandbox-controller/src/pool_device.rs",
    "apps/sandbox-controller/src/pool_namespaces.rs",
    "apps/sandbox-controller/src/pool_journal.rs",
    `${fixture}/Cargo.toml`,
    `${fixture}/Cargo.lock`,
    `${fixture}/src/main.rs`,
  ];
  const invoke = (args: string[], timeout = 60000) =>
    runCommand({
      executable: "docker",
      args,
      timeout_ms: timeout,
      signal: new AbortController().signal,
      env: process.env,
    });
  let started = false;
  let cleanup = false;
  let passed = false;
  try {
    // Copy only these public source files; no workspace credentials enter a compiler context.
    for (const name of selected) {
      const target = join(source, name);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(join(repo, name), target);
      sourceHash.update(name).update(await readFile(target));
      await chmod(target, 0o600);
    }
    await copyFile(
      join(repo, fixture, "fixture.sh"),
      join(output, "fixture.sh"),
    );
    await chmod(join(output, "fixture.sh"), 0o600);
    const architecture = await invoke([
      "info",
      "--format",
      "{{.Architecture}}",
    ]);
    assert.equal(
      architecture.exit_code,
      0,
      "Docker architecture read failed; output withheld",
    );
    const native = architecture.stdout.trim();
    assert.ok(
      ["aarch64", "x86_64"].includes(native),
      "unsupported fixture architecture",
    );
    const platform = native === "aarch64" ? "linux/arm64" : "linux/amd64";
    const cargoTarget = `/target/${sourceHash.digest("hex").slice(0, 24)}`;
    const built = await invoke(
      [
        "run",
        "--rm",
        "--platform",
        platform,
        "--mount",
        `type=bind,source=${source},target=/source,readonly`,
        "--mount",
        `type=bind,source=${output},target=/out`,
        "--mount",
        "type=volume,source=pgcf-pool-kernel-test-registry,target=/usr/local/cargo/registry",
        "--mount",
        "type=volume,source=pgcf-pool-kernel-test-target,target=/target",
        "--workdir",
        `/source/${fixture}`,
        "--env",
        "RUSTUP_TOOLCHAIN=1.99.0",
        "--env",
        `CARGO_TARGET_DIR=${cargoTarget}`,
        "--env",
        "CARGO_PROFILE_DEV_DEBUG=0",
        "--env",
        "CARGO_PROFILE_TEST_DEBUG=0",
        "--env",
        "CARGO_INCREMENTAL=0",
        versions.nativeRuntime.testBuilderImage,
        "sh",
        "-ec",
        `exec 2>&1; apk add --no-cache musl-dev; cargo build --locked; cp ${cargoTarget}/debug/pgcf-pool-kernel-fixture /out/pgcf-pool-kernel-fixture; chmod 0700 /out/pgcf-pool-kernel-fixture`,
      ],
      180000,
    );
    await writeFile(join(output, "builder.log"), built.stdout, { mode: 0o600 });
    assert.equal(
      built.exit_code,
      0,
      "pinned source fixture compilation failed; output withheld",
    );
    started = true;
    const actual = await invoke([
      "run",
      "--name",
      container,
      "--platform",
      "linux/amd64",
      "--network",
      "none",
      "--privileged",
      "--mount",
      `type=bind,source=${output},target=/fixture,readonly`,
      "--mount",
      "type=bind,source=/lib/modules,target=/lib/modules,readonly",
      "--entrypoint",
      "/bin/sh",
      "ghcr.io/amerged-org/pgcf-regional:lvm-thin-sha-be30d08d420b@sha256:10d5aee4fba5416ee68e2a49ab0d560df495c3b62a58118019aad5685d4f0c87",
      "/fixture/fixture.sh",
    ]);
    cleanup = actual.stdout.includes("owned_fixture_normal_cleanup=true");
    await writeFile(join(output, "diagnostic.log"), actual.stdout, {
      mode: 0o600,
    });
    assert.equal(
      actual.exit_code,
      0,
      `real kernel fixture failed; private diagnostic at ${join(output, "diagnostic.log")}`,
    );
    assert.ok(
      actual.stdout.includes(
        "queued_publish_refused=true real_agent_sigkill_denial_survived=true",
      ),
    );
    assert.ok(actual.stdout.includes("actual_prebind_dm_open_count=0"));
    assert.ok(
      actual.stdout.includes("actual_create_exclusive_existing_errno=16"),
    );
    assert.ok(
      actual.stdout.includes(
        "actual_thin_pool_uuid_id_verified=true mismatched_thin_identity_refused=true",
      ),
    );
    assert.ok(
      actual.stdout.includes(
        "unsupported_kernel_or_noninitial_context_refused=true actual_noninitial_pid_namespace_measured=true",
      ),
    );
    assert.ok(
      actual.stdout.includes(
        "production_descriptor_attach=true real_busy_refused=true normal_unmount=true owned_content_preserved=true failed_teardown_mode_refused=true",
      ),
    );
    assert.ok(
      actual.stdout.includes("production_final_global_dm_open_count=0"),
    );
    assert.ok(
      actual.stdout.includes(
        "actual_durable_mount_reentry_no_replay=true mounted_history_retained=true",
      ),
    );
    assert.ok(
      actual.stdout.includes(
        "actual_prewake_readonly_noload_descriptor_read=true actual_write_errno=30 all_creation_refs_closed_dm0=true",
      ),
    );
    assert.ok(cleanup, "owned normal cleanup was not proved");
    passed = true;
  } finally {
    if (started && cleanup) {
      const removed = await invoke(["rm", container]);
      assert.equal(
        removed.exit_code,
        0,
        "completed fixture container cleanup failed",
      );
    }
    if (passed) await rm(privateRoot, { recursive: true, force: true });
    // An uncertain mount/cleanup retains its exact owned container and private fixture for diagnosis.
  }
});

test("real thin device writes share one measured Pod ancestor budget", async () => {
  const repo = resolve(import.meta.dirname, "../../..");
  await mkdir(join(repo, ".local"), { recursive: true, mode: 0o700 });
  const privateRoot = await mkdtemp(join(repo, ".local", "pool-io-"));
  await chmod(privateRoot, 0o700);
  const source = join(privateRoot, "source");
  const output = join(privateRoot, "output");
  await mkdir(output, { mode: 0o700 });
  const container = `pgcf-pool-io-${randomUUID()}`;
  const sourceHash = createHash("sha256").update(repo);
  const copy = async (name: string) => {
    const target = join(source, name);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(join(repo, name), target);
    sourceHash.update(name).update(await readFile(target));
    await chmod(target, 0o600);
  };
  const tree = async (directory: string, suffix: string) => {
    for (const entry of await readdir(join(repo, directory), {
      withFileTypes: true,
    })) {
      if (entry.name.startsWith(".")) continue;
      const name = join(directory, entry.name);
      if (entry.isDirectory()) await tree(name, suffix);
      else if (entry.isFile() && entry.name.endsWith(suffix)) await copy(name);
    }
  };
  const invoke = (args: string[], timeout = 60000) =>
    runCommand({
      executable: "docker",
      args,
      timeout_ms: timeout,
      signal: new AbortController().signal,
      env: process.env,
    });
  let started = false;
  let cleanup = false;
  let passed = false;
  try {
    // The workspace manifests require these members. Only public Rust/protobuf/schema inputs
    // enter the compiler; credentials, ignored diagnostics and runtime state never enter it.
    for (const name of ["Cargo.toml", "Cargo.lock"]) await copy(name);
    for (const member of [
      "apps/edge-rust",
      "apps/native-controller",
      "apps/sandbox-controller",
      "apps/node-runtime",
      "packages/native-protocol",
      "apps/native-gateway",
      "apps/native-reclaimer",
      "apps/native-bootstrap-relay",
      "apps/pool-supervisor",
    ]) {
      await copy(`${member}/Cargo.toml`);
      await tree(`${member}/src`, ".rs");
    }
    // Cargo resolves the supervisor manifest's declared fixture-gated test targets on load.
    await tree("apps/pool-supervisor/tests", ".rs");
    await copy("apps/sandbox-controller/build.rs");
    await copy("apps/sandbox-controller/examples/pool_io_fixture.rs");
    await tree("apps/sandbox-controller/proto", ".proto");
    await tree("packages/contracts/native", ".json");
    await copyFile(
      join(
        repo,
        "apps/sandbox-controller/tests/fixtures/pool-kernel/io-fixture.sh",
      ),
      join(output, "fixture.sh"),
    );
    await chmod(join(output, "fixture.sh"), 0o600);
    const architecture = await invoke([
      "info",
      "--format",
      "{{.Architecture}}",
    ]);
    assert.equal(
      architecture.exit_code,
      0,
      "Docker architecture read failed; output withheld",
    );
    assert.ok(
      ["aarch64", "x86_64"].includes(architecture.stdout.trim()),
      "unsupported fixture architecture",
    );
    const platform =
      architecture.stdout.trim() === "aarch64" ? "linux/arm64" : "linux/amd64";
    const protoc = versions.nativeRuntime.protoc.archives.find(
      (pin) => pin.os === "linux" && pin.architecture === "amd64",
    )!;
    const cargoTarget = `/target/${sourceHash.digest("hex").slice(0, 24)}`;
    const built = await invoke(
      [
        "run",
        "--rm",
        "--platform",
        platform,
        "--mount",
        `type=bind,source=${source},target=/repo,readonly`,
        "--mount",
        `type=bind,source=${output},target=/out`,
        "--mount",
        "type=volume,source=pgcf-pool-io-test-registry,target=/usr/local/cargo/registry",
        "--mount",
        "type=volume,source=pgcf-pool-io-test-target,target=/target",
        "--workdir",
        "/repo",
        "--env",
        "RUSTUP_TOOLCHAIN=1.99.0",
        "--env",
        `CARGO_TARGET_DIR=${cargoTarget}`,
        "--env",
        "CARGO_PROFILE_DEV_DEBUG=0",
        "--env",
        "CARGO_PROFILE_TEST_DEBUG=0",
        "--env",
        "CARGO_INCREMENTAL=0",
        versions.nativeRuntime.testBuilderImage,
        "sh",
        "-ec",
        `exec 2>&1; apk add --no-cache curl unzip musl-dev; mkdir /tmp/protoc; curl --fail --silent --show-error --location '${protoc.url}' --output /tmp/protoc.zip; printf '%s  %s\\n' '${protoc.sha256}' /tmp/protoc.zip | sha256sum -c -; unzip -q /tmp/protoc.zip -d /tmp/protoc; printf '%s  %s\\n' '${protoc.binarySha256}' /tmp/protoc/bin/protoc | sha256sum -c -; export PROTOC=/tmp/protoc/bin/protoc; cargo build --locked -p pgcf-sandbox-controller --example pool_io_fixture; cp ${cargoTarget}/debug/examples/pool_io_fixture /out/pool-io; chmod 0700 /out/pool-io`,
      ],
      300000,
    );
    await writeFile(join(output, "builder.log"), built.stdout, { mode: 0o600 });
    assert.equal(
      built.exit_code,
      0,
      "pinned source IO fixture compilation failed; output withheld",
    );
    started = true;
    const actual = await invoke(
      [
        "run",
        "--name",
        container,
        "--platform",
        "linux/amd64",
        "--network",
        "none",
        "--env",
        process.env.PGCF_POOL_IO_OBSERVATION === "1"
          ? "PGCF_POOL_IO_OBSERVATION=1"
          : "PGCF_POOL_IO_OBSERVATION=0",
        "--privileged",
        "--cgroupns",
        "host",
        "--mount",
        `type=bind,source=${output},target=/fixture,readonly`,
        "--mount",
        "type=bind,source=/lib/modules,target=/lib/modules,readonly",
        "--mount",
        "type=bind,source=/sys/fs/cgroup,target=/sys/fs/cgroup",
        "--entrypoint",
        "/bin/sh",
        "ghcr.io/amerged-org/pgcf-regional:lvm-thin-sha-be30d08d420b@sha256:10d5aee4fba5416ee68e2a49ab0d560df495c3b62a58118019aad5685d4f0c87",
        "/fixture/fixture.sh",
        "/fixture/pool-io",
      ],
      process.env.PGCF_POOL_IO_OBSERVATION === "1" ? 120000 : 60000,
    );
    await writeFile(join(output, "diagnostic.log"), actual.stdout, {
      mode: 0o600,
    });
    cleanup =
      actual.stdout.includes("owned_cgroup_normal_cleanup=true") &&
      actual.stdout.includes("owned_io_device_normal_cleanup=true");
    assert.equal(
      actual.exit_code,
      0,
      `real IO fixture failed; private diagnostic at ${join(output, "diagnostic.log")}`,
    );
    assert.ok(
      actual.stdout.includes(
        "actual_thin_shared_pod_ancestor_io_verified=true actual_two_writers_bytes=8388608",
      ),
    );
    assert.ok(
      actual.stdout.includes("actual_recycled_or_dead_process_refused=true"),
    );
    assert.ok(
      actual.stdout.includes(
        "actual_original_cgroup_descendants_stopped_after_parent_exit=true",
      ),
    );
    assert.ok(cleanup, "owned normal IO cleanup was not proved");
    passed = true;
  } finally {
    if (started && cleanup) {
      const removed = await invoke(["rm", container]);
      assert.equal(
        removed.exit_code,
        0,
        "completed IO fixture container cleanup failed",
      );
    }
    if (passed) await rm(privateRoot, { recursive: true, force: true });
  }
});

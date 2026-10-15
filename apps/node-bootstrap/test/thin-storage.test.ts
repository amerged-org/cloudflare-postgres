// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import {
  BootstrapError,
  runCommand,
  type Command,
  type CommandResult,
} from "../src/bootstrap.ts";
import { ThinWorld } from "./thin-qualification.fixture.ts";
import {
  issueAgain,
  readCommand,
  thinLvmFacts,
  thinPoolCommand,
  thinIoLimit,
  thinPodCgroupPaths,
  thinWriterPods,
  thinPoolWriter,
  thinPoolProcessCgroup,
  thinPoolProcessStat,
  thinPoolPidNamespace,
  thinPoolDevice,
  thinPoolQuiesced,
  thinPoolProcesses,
  thinDeletingVolume,
  assertThinStorageHostSettings,
  thinStorageHostConfiguration,
  openThinSession,
  verifyThinNode,
} from "../src/thin-storage.ts";
import type {
  NodeThinStorageInput,
  NodeThinPoolAction,
} from "@pgcf/contracts/node-thin-storage";
import type { PoolHostCustody } from "@pgcf/contracts/postgres-pool";
const vg = "abcdef-abcd-abcd-abcd-abcd-abcd-abcdef",
  pool = "bcdefg-bcde-bcde-bcde-bcde-bcde-bcdefg";
const profile = {
  version: 1,
  driver_image: `ghcr.io/amerged-org/pgcf-regional:lvm-thin-sha-${"a".repeat(40)}@sha256:${"b".repeat(64)}`,
  initial_data_bytes: 1024 ** 3,
  growth_bytes: 1024 ** 3,
  maximum_data_bytes: 8 * 1024 ** 3,
  metadata_bytes: 128 * 1024 ** 2,
  vg_reserve_bytes: 512 * 1024 ** 2,
  data_reserve_bytes: 256 * 1024 ** 2,
  metadata_reserve_bytes: 32 * 1024 ** 2,
  startup_reserve_bytes: 128 * 1024 ** 2,
  write_bytes_per_second: 1024 ** 2,
  write_iops_per_second: 100,
  guard_seconds: 10,
  drain_seconds: 10,
  maximum_volumes: 128,
  maximum_quota_gib: 7,
};
const input = {
  lease: {
    volume_group_uuid: vg,
    node_uid: "22222222-2222-4222-8222-222222222222",
    profile,
  },
} as NodeThinStorageInput;
const keys = { cf: "A".repeat(43) },
  settings = {
    cloudflare: {
      node_id: "nod_abcdefghijklmnopqrst",
      node_uid: input.lease.node_uid,
      region_id: "us-dev",
      material_revision: 1,
      api_url: "https://api.invalid",
      agent_key_file: "/var/lib/pgcf-sandbox/agent-key",
      storage_authority: {
        keys,
        sha256: createHash("sha256").update(JSON.stringify(keys)).digest("hex"),
        legacy_database_ids: [],
      },
    },
  };
const hostInput = {
  ...input,
  lease: {
    ...input.lease,
    node_id: settings.cloudflare.node_id,
    region_id: settings.cloudflare.region_id,
    material_revision: 1,
    cluster_uid: "33333333-3333-4333-8333-333333333333",
    release_id: "guard-fixture",
    databases: [],
  },
  host_configuration: {
    status: {
      version: 1,
      node_id: settings.cloudflare.node_id,
      node_uid: input.lease.node_uid,
      region_id: settings.cloudflare.region_id,
      cluster_uid: "33333333-3333-4333-8333-333333333333",
      material_revision: 1,
      revision: 1,
      sha256: "a".repeat(64),
      release_id: "guard-fixture",
      pool_policy_revision: 1,
      profile_sha256: "b".repeat(64),
      created_at: "2026-10-09T00:00:00.000Z",
    },
    files: [
      {
        path: "/var/lib/pgcf-sandbox/settings.json",
        permissions: 384,
        content: JSON.stringify(settings),
      },
      {
        path: "/var/lib/pgcf-sandbox/agent-key",
        permissions: 384,
        content: "test-only\n",
      },
    ],
  },
  callback: {
    url: "https://api.invalid/internal/storage",
    bearer: "a".repeat(32),
  },
} as NodeThinStorageInput;
test("thin host qualification requires actual bound verifier settings even when absent files would byte-match", () => {
  assert.doesNotThrow(() => assertThinStorageHostSettings(hostInput));
  const absent = structuredClone(hostInput);
  const cfg = JSON.parse(absent.host_configuration.files[0].content);
  delete cfg.cloudflare.storage_authority;
  absent.host_configuration.files[0].content = JSON.stringify(cfg);
  assert.throws(
    () => assertThinStorageHostSettings(absent),
    /host_guard_unqualified/,
  );
  const wrong = structuredClone(hostInput);
  const changed = JSON.parse(wrong.host_configuration.files[0].content);
  changed.cloudflare.storage_authority.sha256 = "f".repeat(64);
  wrong.host_configuration.files[0].content = JSON.stringify(changed);
  assert.throws(
    () => assertThinStorageHostSettings(wrong),
    /host_guard_unqualified/,
  );
  const rebound = structuredClone(hostInput);
  rebound.lease.material_revision = 2;
  assert.throws(
    () => assertThinStorageHostSettings(rebound),
    /host_guard_unqualified/,
  );
});
test("on a STATE-loaded boot the executor proves host files with the completed patch's configuration boot; unwitnessed absence stays blocked", async () => {
  const boot = randomUUID();
  // After a boot that loaded STATE, Talos lists only the real active resource.
  const active = JSON.stringify({
    metadata: { type: "MachineConfigs.config.talos.dev", id: "v1alpha1" },
    spec: stringify({
      version: "v1alpha1",
      machine: {
        files: hostInput.host_configuration.files.map((file) => ({
          ...file,
          op: "create",
        })),
      },
    }),
  });
  const talos = async (args: string[]) =>
    args[0] === "get"
      ? active
      : hostInput.host_configuration.files.find(
          (file) => file.path === args[1],
        )!.content;
  const witnessed = (configuration_boot_id: string | null) =>
    ({
      ...hostInput,
      lease: { ...hostInput.lease, boot_id: boot, configuration_boot_id },
    }) as NodeThinStorageInput;
  assert.equal(
    await thinStorageHostConfiguration(witnessed(randomUUID()), talos),
    true,
  );
  await assert.rejects(
    thinStorageHostConfiguration(witnessed(null), talos),
    /persistence_unproved/,
  );
  await assert.rejects(
    thinStorageHostConfiguration(witnessed(boot), talos),
    /persistence_unproved/,
  );
});
test("a failed host-file read stays a transient turn failure; only a file read back with other content leaves the host guard unqualified", async () => {
  const world = new ThinWorld({
    id: "op_abcdefghijklmnopqrst",
    node_id: "nod_abcdefghij0123456789",
    region_id: "eu-dev",
    node_uid: randomUUID(),
    cluster_uid: randomUUID(),
    name: "eu1",
    provider_instance_id: "202610110001",
    address: "192.0.2.21",
  });
  const ids = world.ids,
    files = hostInput.host_configuration.files;
  // Active and persistent configuration declare both fixed files; only their physical reads vary.
  const machineconfig = ["v1alpha1", "persistent"]
    .map((id) =>
      JSON.stringify({
        metadata: { type: "MachineConfigs.config.talos.dev", id },
        spec: stringify({
          version: "v1alpha1",
          machine: { files: files.map((file) => ({ ...file, op: "create" })) },
        }),
      }),
    )
    .join("\n");
  // The real session, its read repeats and its deadline around the real node and host guard checks.
  const turn = (
    budget_ms: number,
    read: (path: string, command: Command) => Promise<CommandResult>,
  ) =>
    openThinSession(
      {
        callback: {
          url: `https://api.invalid/internal/v1/node-thin-storage/${ids.node_id}`,
          bearer: "t".repeat(43),
        },
        cluster_endpoint: `https://${ids.address}:6443/`,
        talos_admin_config: JSON.stringify({
          context: "test",
          contexts: {
            test: { ca: "test-only", crt: "test-only", key: "test-only" },
          },
        }),
        kubeconfig: JSON.stringify({
          clusters: [
            {
              cluster: {
                server: `https://${ids.address}:6443/`,
                "certificate-authority-data": "test-only",
              },
            },
          ],
          users: [
            {
              user: {
                "client-certificate-data": "test-only",
                "client-key-data": "test-only",
              },
            },
          ],
        }),
        address: ids.address,
        budget_ms,
        deadline_code: "thin_storage_turn_timeout",
        prefix: "pgcf-thin-host-files-test-",
      },
      {
        proxy: async () => ({
          url: "http://127.0.0.1:1",
          close: async () => {},
        }),
        request: async () => {
          throw new Error("unexpected_callback");
        },
        run: async (command) => {
          const args = command.args.slice(6);
          if (command.executable === "talosctl" && args[1] === "machineconfig")
            return { exit_code: 0, stdout: machineconfig };
          if (
            command.executable === "talosctl" &&
            args[0] === "read" &&
            files.some((file) => file.path === args[1])
          )
            return await read(args[1]!, command);
          return await world.command(command);
        },
      },
      (session) =>
        verifyThinNode(
          session,
          {
            node_id: ids.node_id,
            region_id: ids.region_id,
            node_uid: ids.node_uid,
            cluster_uid: ids.cluster_uid,
            name: ids.name,
            provider_instance_id: ids.provider_instance_id,
            driver_image: world.driverImage,
            host_extension_version: world.extension,
            boot_id: world.boot,
            kernel_version: world.kernel,
          },
          async () => {},
          () =>
            thinStorageHostConfiguration(hostInput, (args) =>
              session.talos(args),
            ),
        ),
    );
  const failedWith = (code: string) => (error: unknown) =>
    error instanceof BootstrapError && error.code === code;
  // A relay round trip that still fails after its repeats proves nothing about the file.
  let attempts = 0;
  await assert.rejects(
    turn(10_000, async (path) =>
      path === files[1].path
        ? (attempts++, { exit_code: 1, stdout: "" })
        : { exit_code: 0, stdout: files[0].content },
    ),
    failedWith("thin_storage_command_failed"),
  );
  assert.equal(attempts, 3);
  // Nor does the turn's own deadline cancelling real hung reads.
  await assert.rejects(
    turn(300, (_path, command) =>
      runCommand({
        ...command,
        executable: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
      }),
    ),
    failedWith("thin_storage_turn_timeout"),
  );
  // Settings read back with other content block the node even when the other read fails.
  await assert.rejects(
    turn(10_000, async (path) =>
      path === files[1].path
        ? { exit_code: 1, stdout: "" }
        : { exit_code: 0, stdout: '{"version":0}\n' },
    ),
    failedWith("thin_storage_host_guard_unqualified"),
  );
});
const action = {
  kind: "initialize",
  state: "pending",
  nonce: "op_abcdefghijklmnopqrst",
  target_data_bytes: 1024 ** 3,
  target_metadata_bytes: profile.metadata_bytes,
  expected_pool_uuid: null,
  driver_pod_uid: null,
  boot_id: null,
  dispatched_at: null,
  deadline_at: null,
} as NodeThinPoolAction;
function facts(rows: Record<string, unknown>[] = [], dm = "", before = dm) {
  return thinLvmFacts(
    JSON.stringify({
      report: [
        {
          vg: [
            {
              vg_name: "pgcf",
              vg_uuid: vg,
              vg_size: "21474836480",
              vg_free: "19327352832",
              vg_extent_size: "4194304",
              vg_permissions: "writeable",
              vg_missing_pv_count: "0",
              pv_count: "1",
            },
          ],
        },
      ],
    }),
    JSON.stringify({ report: [{ lv: rows }] }),
    dm,
    before,
  );
}
const poolRow = {
  vg_uuid: vg,
  lv_name: "pgcf_thinpool",
  lv_uuid: pool,
  lv_size: "1073741824",
  segtype: "thin-pool",
  pool_lv: "",
  lv_attr: "twi-aotz--",
  data_percent: "0.00",
  metadata_percent: "0.30",
  lv_metadata_size: "134217728",
  lv_when_full: "error",
  lv_tags: `pgcf.node.${input.lease.node_uid},pgcf.action.${action.nonce}`,
};
test("complete LVM and kernel inventory retains internal IDs and refuses unexplained active devices", () => {
  const value = facts(
    [poolRow],
    `LVM-${vg.replaceAll("-", "")}${pool.replaceAll("-", "")}-tpool`,
  );
  assert.deepEqual(value.active, [pool]);
  assert.equal(value.physical.thin_pool?.data_used_bytes_upper_bound, 107375);
  assert.throws(
    () => facts([poolRow], `LVM-${vg.replaceAll("-", "")}${"d".repeat(32)}`),
    /thin_storage_kernel_lv_unexplained/,
  );
});
test("a grown pool's hidden data LV reported once per segment is one LV; differing rows still fail closed", () => {
  // lvs prints one row per segment when a segment field (segtype) is requested; after the
  // product lvextend, the pool's data LV continues behind its metadata LVs in a second segment.
  const data = {
    vg_uuid: vg,
    lv_name: "[pgcf_thinpool_tdata]",
    lv_uuid: "Td0000-0000-0000-0000-0000-0000-000000",
    lv_size: "2147483648",
    segtype: "linear",
    pool_lv: "",
    lv_attr: "Twi-ao----",
    data_percent: "",
    metadata_percent: "",
    lv_metadata_size: "",
    lv_when_full: "",
    lv_tags: "",
  };
  const value = facts([{ ...poolRow, lv_size: "2147483648" }, data, data]);
  assert.deepEqual(
    value.volumes.map((volume) => volume.name),
    ["pgcf_thinpool", "[pgcf_thinpool_tdata]"],
  );
  assert.equal(value.physical.thick_allocated_bytes, 0);
  assert.equal(value.physical.thin_pool?.data_total_bytes, 2147483648);
  assert.throws(
    () => facts([poolRow, data, { ...data, segtype: "striped" }]),
    /thin_storage_lvs_changed/,
  );
});
test("only a device present before and after the LVM read must have an LV; one lvm-localpv is creating does not", () => {
  // dmsetup takes no VG lock: a volume activated after the first device read and committed after
  // lvs is not unexplained yet, while a device listed by both reads without an LV still fails closed.
  const foreign = `LVM-${vg.replaceAll("-", "")}${"d".repeat(32)}`,
    tpool = `LVM-${vg.replaceAll("-", "")}${pool.replaceAll("-", "")}-tpool`;
  assert.deepEqual(facts([poolRow], `${tpool}\n${foreign}`, tpool).active, [
    pool,
  ]);
  assert.throws(
    () => facts([poolRow], `${tpool}\n${foreign}`, `${tpool}\n${foreign}`),
    /thin_storage_kernel_lv_unexplained/,
  );
});
test("a read-only relay command and a transport issuance are repeated at most twice", async () => {
  const signal = new AbortController().signal;
  let calls = 0;
  const flaky = async () => ({
    exit_code: ++calls < 3 ? 1 : 0,
    stdout: String(calls),
  });
  assert.deepEqual(await readCommand(flaky, signal, 0), {
    exit_code: 0,
    stdout: "3",
  });
  calls = 0;
  const broken = async () => ({ exit_code: (calls++, 1), stdout: "" });
  assert.equal((await readCommand(broken, signal, 0)).exit_code, 1);
  assert.equal(calls, 3);
  calls = 0;
  const refusedOnce = async () => {
    if (calls++ === 0) throw new Error("thin_storage_authority_refused");
    return "transport";
  };
  assert.equal(await issueAgain(refusedOnce, signal, 0), "transport");
  calls = 0;
  await assert.rejects(
    issueAgain(
      async () => {
        calls++;
        throw new Error("thin_storage_authority_refused");
      },
      signal,
      0,
    ),
    /authority_refused/,
  );
  assert.equal(calls, 3);
});
test("a read-only native command can succeed after two real subprocess timeouts", async () => {
  const signal = new AbortController().signal;
  let attempts = 0;
  const result = await readCommand(
    () =>
      runCommand({
        executable: process.execPath,
        args:
          ++attempts < 3
            ? ["-e", "setInterval(() => {}, 1000)"]
            : ["--version"],
        timeout_ms: attempts < 3 ? 30 : 1000,
        signal,
        env: process.env,
      }),
    signal,
    0,
  );
  assert.equal(attempts, 3);
  assert.equal(result.exit_code, 0);
  assert.equal(result.stdout.trim(), process.version);
});
test("three exhausted read-only native timeouts become the existing transient command failure", async () => {
  const signal = new AbortController().signal;
  let attempts = 0;
  await assert.rejects(
    readCommand(
      () => {
        attempts++;
        return runCommand({
          executable: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000)"],
          timeout_ms: 30,
          signal,
          env: process.env,
        });
      },
      signal,
      0,
    ),
    (error: unknown) =>
      error instanceof BootstrapError &&
      error.code === "thin_storage_command_failed",
  );
  assert.equal(attempts, 3);
});
test("parent cancellation of a native read stays job_cancelled and is never retried", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const timer = setTimeout(() => controller.abort(), 30);
  try {
    await assert.rejects(
      readCommand(
        () => {
          attempts++;
          return runCommand({
            executable: process.execPath,
            args: ["-e", "setInterval(() => {}, 1000)"],
            timeout_ms: 1000,
            signal: controller.signal,
            env: process.env,
          });
        },
        controller.signal,
        0,
      ),
      (error: unknown) =>
        error instanceof BootstrapError && error.code === "job_cancelled",
    );
    assert.equal(attempts, 1);
  } finally {
    clearTimeout(timer);
  }
});
test("a native read timeout racing parent abort is preserved without retry or reclassification", async () => {
  const controller = new AbortController();
  let attempts = 0,
    original: unknown;
  await assert.rejects(
    readCommand(
      async () => {
        attempts++;
        try {
          return await runCommand({
            executable: process.execPath,
            args: ["-e", "setInterval(() => {}, 1000)"],
            timeout_ms: 30,
            signal: controller.signal,
            env: process.env,
          });
        } catch (error) {
          original = error;
          controller.abort();
          throw error;
        }
      },
      controller.signal,
      0,
    ),
    (error: unknown) =>
      error === original &&
      error instanceof BootstrapError &&
      error.code === "command_timeout",
  );
  assert.equal(attempts, 1);
});
test("a native read output-limit error is preserved and never retried", async () => {
  const signal = new AbortController().signal;
  let attempts = 0;
  await assert.rejects(
    readCommand(
      () => {
        attempts++;
        return runCommand({
          executable: process.execPath,
          args: [
            "-e",
            'process.stdout.write("x".repeat(9 * 1024 ** 2)); setInterval(() => {}, 1000)',
          ],
          timeout_ms: 1000,
          signal,
          env: process.env,
        });
      },
      signal,
      0,
    ),
    (error: unknown) =>
      error instanceof BootstrapError && error.code === "command_output_limit",
  );
  assert.equal(attempts, 1);
});
test("the session command used by mutations attempts a real write once and preserves timeout uncertainty", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pgcf-thin-mutation-test-"));
  await chmod(directory, 0o700);
  const marker = join(directory, "attempts");
  try {
    await assert.rejects(
      openThinSession(
        {
          callback: {
            url: "https://api.invalid/internal/storage",
            bearer: "test-only",
          },
          cluster_endpoint: "https://127.0.0.1:6443",
          address: "127.0.0.1",
          budget_ms: 1000,
          prefix: "pgcf-thin-mutation-session-test-",
          talos_admin_config: stringify({
            context: "test",
            contexts: {
              test: { ca: "test-only", crt: "test-only", key: "test-only" },
            },
          }),
          kubeconfig: stringify({
            clusters: [
              {
                cluster: {
                  server: "https://127.0.0.1:6443",
                  "certificate-authority-data": "test-only",
                },
              },
            ],
            users: [
              {
                user: {
                  "client-certificate-data": "test-only",
                  "client-key-data": "test-only",
                },
              },
            ],
          }),
        },
        {},
        async (session) =>
          session.command(
            "/bin/sh",
            [
              "-c",
              'umask 077; printf x >> "$1"; sleep 5',
              "mutation-test",
              marker,
            ],
            undefined,
            false,
            100,
          ),
      ),
      (error: unknown) =>
        error instanceof BootstrapError && error.code === "command_timeout",
    );
    assert.equal(await readFile(marker, "utf8"), "x");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a thin turn's own deadline cancels a real subprocess without replay, while an external timeout stays job_cancelled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pgcf-thin-turn-deadline-"));
  await chmod(directory, 0o700);
  const marker = join(directory, "attempts"),
    scope = {
      callback: {
        url: "https://api.invalid/internal/storage",
        bearer: "test-only",
      },
      cluster_endpoint: "https://kubernetes.invalid:6443",
      address: "node.invalid",
      budget_ms: 200,
      deadline_code: "thin_storage_turn_timeout" as const,
      prefix: "pgcf-thin-turn-deadline-session-",
      talos_admin_config: stringify({
        context: "test",
        contexts: {
          test: { ca: "test-only", crt: "test-only", key: "test-only" },
        },
      }),
      kubeconfig: stringify({
        clusters: [
          {
            cluster: {
              server: "https://kubernetes.invalid:6443",
              "certificate-authority-data": "test-only",
            },
          },
        ],
        users: [
          {
            user: {
              "client-certificate-data": "test-only",
              "client-key-data": "test-only",
            },
          },
        ],
      }),
    },
    command = (session: Parameters<Parameters<typeof openThinSession>[2]>[0]) =>
      session.command(
        "/bin/sh",
        ["-c", 'umask 077; printf x >> "$1"; sleep 5', "deadline-test", marker],
        undefined,
        false,
        10000,
      );
  try {
    await assert.rejects(
      openThinSession(scope, {}, command),
      (error: unknown) =>
        error instanceof BootstrapError &&
        error.code === "thin_storage_turn_timeout",
    );
    assert.equal(
      await readFile(marker, "utf8"),
      "x",
      "a timed out subprocess is never rerun",
    );
    const external = new AbortController(),
      timer = setTimeout(
        () =>
          external.abort(new DOMException("external timeout", "TimeoutError")),
        100,
      );
    try {
      await assert.rejects(
        openThinSession(
          { ...scope, budget_ms: 2000 },
          { signal: external.signal },
          command,
        ),
        (error: unknown) =>
          error instanceof BootstrapError && error.code === "job_cancelled",
      );
    } finally {
      clearTimeout(timer);
    }
    assert.equal(
      await readFile(marker, "utf8"),
      "xx",
      "external cancellation also makes one attempt",
    );
    const concurrent = new AbortController();
    await assert.rejects(
      openThinSession(
        scope,
        {
          signal: concurrent.signal,
          run: async (child) => {
            try {
              return await runCommand(child);
            } catch (error) {
              concurrent.abort();
              throw error;
            }
          },
        },
        command,
      ),
      (error: unknown) =>
        error instanceof BootstrapError && error.code === "job_cancelled",
    );
    assert.equal(await readFile(marker, "utf8"), "xxx");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a thin turn's own deadline covers a real hung HTTP callback and an abortable retry timer", async () => {
  let requests = 0;
  const server = createServer((request) => {
    requests++;
    request.resume();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const scope = {
    callback: {
      url: `http://127.0.0.1:${address.port}/internal/storage`,
      bearer: "test-only",
    },
    cluster_endpoint: "https://kubernetes.invalid:6443",
    address: "node.invalid",
    budget_ms: 200,
    deadline_code: "thin_storage_turn_timeout" as const,
    prefix: "pgcf-thin-turn-callback-deadline-",
    talos_admin_config: stringify({
      context: "test",
      contexts: {
        test: { ca: "test-only", crt: "test-only", key: "test-only" },
      },
    }),
    kubeconfig: stringify({
      clusters: [
        {
          cluster: {
            server: "https://kubernetes.invalid:6443",
            "certificate-authority-data": "test-only",
          },
        },
      ],
      users: [
        {
          user: {
            "client-certificate-data": "test-only",
            "client-key-data": "test-only",
          },
        },
      ],
    }),
  };
  try {
    await assert.rejects(
      openThinSession(scope, {}, (session) => session.call({ kind: "status" })),
      (error: unknown) =>
        error instanceof BootstrapError &&
        error.code === "thin_storage_turn_timeout",
    );
    assert.equal(requests, 1, "a callback request is not replayed on expiry");
    await assert.rejects(
      openThinSession(scope, {}, (session) =>
        delay(5000, undefined, { signal: session.signal }),
      ),
      (error: unknown) =>
        error instanceof BootstrapError &&
        error.code === "thin_storage_turn_timeout",
    );
    const refusal = new BootstrapError("thin_storage_driver_owner_changed");
    await assert.rejects(
      openThinSession(scope, {}, async () => {
        await delay(220);
        throw refusal;
      }),
      (error: unknown) => error === refusal,
      "an unrelated safety refusal is preserved even after the deadline",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test("an empty LVM pool percentage fails closed instead of reading as an unused pool", () => {
  assert.throws(
    () => facts([{ ...poolRow, data_percent: "" }]),
    /thin_storage_pool_percent_invalid/,
  );
  assert.throws(
    () => facts([{ ...poolRow, metadata_percent: "" }]),
    /thin_storage_pool_percent_invalid/,
  );
});
test("pool writes use bounded absolute sizes and never retry a dispatched unknown outcome", () => {
  const value = facts();
  // lvm2 2.03 refuses --errorwhenfull with --type thin-pool; the --thinpool form accepts it.
  assert.deepEqual(thinPoolCommand(input, value, action), [
    "lvcreate",
    "--thinpool",
    "pgcf_thinpool",
    "--size",
    `${action.target_data_bytes}B`,
    "--poolmetadatasize",
    `${action.target_metadata_bytes}B`,
    "--chunksize",
    "64K",
    "--errorwhenfull",
    "y",
    "--addtag",
    `pgcf.node.${input.lease.node_uid}`,
    "--addtag",
    `pgcf.action.${action.nonce}`,
    "pgcf",
  ]);
  assert.throws(
    () => thinPoolCommand(input, value, { ...action, state: "dispatched" }),
    /thin_storage_initialize_outcome_unknown/,
  );
  assert.throws(
    () =>
      thinPoolCommand(input, value, {
        ...action,
        target_data_bytes: 9 * 1024 ** 3,
      }),
    /thin_storage_action_scope_changed/,
  );
  assert.equal(
    thinPoolCommand(input, facts([poolRow]), {
      ...action,
      state: "dispatched",
    }),
    null,
  );
  const grow = {
    ...action,
    kind: "grow",
    expected_pool_uuid: pool,
    target_data_bytes: 2 * 1024 ** 3,
  } as NodeThinPoolAction;
  assert.deepEqual(thinPoolCommand(input, facts([poolRow]), grow), [
    "lvextend",
    "--size",
    "2147483648B",
    "pgcf/pgcf_thinpool",
  ]);
  assert.throws(
    () =>
      thinPoolCommand(input, facts([poolRow]), {
        ...grow,
        state: "dispatched",
      }),
    /thin_storage_grow_outcome_unknown/,
  );
  const largerMetadata = {
    ...input,
    lease: {
      ...input.lease,
      profile: { ...profile, metadata_bytes: 256 * 1024 ** 2 },
    },
  } as NodeThinStorageInput;
  assert.deepEqual(
    thinPoolCommand(largerMetadata, facts([poolRow]), {
      ...grow,
      target_data_bytes: 1024 ** 3,
      target_metadata_bytes: 256 * 1024 ** 2,
    }),
    ["lvextend", "--poolmetadatasize", "268435456B", "pgcf/pgcf_thinpool"],
  );
});
test("physical IO proof requires exact device and finite caps on an identity-bound Pod cgroup", () => {
  assert.deepEqual(
    thinIoLimit("253:2 rbps=max wbps=1048576 riops=max wiops=100\n", 253, 2),
    { write_bytes_per_second: 1048576, write_iops_per_second: 100 },
  );
  assert.throws(() => thinIoLimit("253:2 wbps=max wiops=100", 253, 2));
  assert.throws(() => thinIoLimit("253:3 wbps=1 wiops=1", 253, 2));
  assert.throws(() => thinPodCgroupPaths("../../pgcf"));
  assert.equal(thinPodCgroupPaths(input.lease.node_uid).length, 7);
});

test("IO accounting retains unready and terminating writers until actual terminal task or DM quiescence proof", () => {
  const pod = (
    uid: string,
    phase: string,
    ready: boolean,
    deleting = false,
  ) => ({
    metadata: {
      uid,
      labels: { "cnpg.io/podRole": "instance" },
      ...(deleting ? { deletionTimestamp: "2026-10-09T00:00:00.000Z" } : {}),
    },
    status: {
      phase,
      conditions: [{ type: "Ready", status: ready ? "True" : "False" }],
    },
  });
  const list = [
    pod("unready", "Running", false),
    pod("terminating", "Running", false, true),
    pod("pending", "Pending", false),
    pod("complete", "Succeeded", false),
    pod("failed", "Failed", false),
  ];
  assert.deepEqual(
    thinWriterPods(list).map((p) => (p.metadata as { uid: string }).uid),
    ["unready", "terminating", "pending"],
  );
});

test("pool writer custody selects one original Pod and refuses parallel CNPG or changed namespace/CIDs", () => {
  const namespaceUid = randomUUID(),
    podUid = randomUUID(),
    boot = randomUUID();
  const custody: PoolHostCustody = {
    v: 1,
    binding_id: randomUUID(),
    scope_sha256: "a".repeat(64),
    holder_revision: 1,
    holder_generation: 2,
    holder_boot_id: boot,
    state: "serving",
    pool_namespace: "pgcf-pool",
    pool_namespace_uid: namespaceUid,
    pool_pod_uid: podUid,
    container_ids: ["a".repeat(64), "b".repeat(64)],
    device: {
      volume_group_uuid: vg,
      lv_uuid: "cdefgh-cdef-cdef-cdef-cdef-cdef-cdefgh",
      thin_id: 3,
      device_major: 253,
      device_minor: 2,
    },
    cleanup_authority: null,
  };
  const namespace = { metadata: { name: "pgcf-pool", uid: namespaceUid } };
  const pod = {
    metadata: { name: "owned-pool", namespace: "pgcf-pool", uid: podUid },
    spec: { nodeName: "node-fixture" },
    status: {
      phase: "Running",
      containerStatuses: custody.container_ids.map((id, index) => ({
        name: index ? "archiver" : "postgres",
        containerID: `containerd://${id}`,
      })),
    },
  };
  assert.equal(
    thinPoolWriter(custody, [], [pod], [namespace], "node-fixture", boot)
      .pod_uid,
    podUid,
  );
  const cnpg = {
    metadata: { uid: randomUUID(), labels: { "cnpg.io/podRole": "instance" } },
    status: { phase: "Running" },
  };
  assert.throws(
    () =>
      thinPoolWriter(custody, [cnpg], [pod], [namespace], "node-fixture", boot),
    /parallel_writer/,
  );
  assert.throws(
    () =>
      thinPoolWriter(
        custody,
        [],
        [pod],
        [{ metadata: { name: "pgcf-pool", uid: randomUUID() } }],
        "node-fixture",
        boot,
      ),
    /pool_namespace_changed/,
  );
  const changed = structuredClone(pod);
  changed.status.containerStatuses[0]!.containerID = `containerd://${"c".repeat(64)}`;
  assert.throws(
    () =>
      thinPoolWriter(custody, [], [changed], [namespace], "node-fixture", boot),
    /pool_container_changed/,
  );
  assert.throws(
    () =>
      thinPoolWriter(
        custody,
        [],
        [pod],
        [namespace],
        "node-fixture",
        randomUUID(),
      ),
    /pool_boot_changed/,
  );
  assert.throws(
    () =>
      thinPoolWriter(
        { ...custody, device: null },
        [],
        [pod],
        [namespace],
        "node-fixture",
        boot,
      ),
    /pool_device_unconfirmed/,
  );
});

test("pool IO joins exact host tasks and sibling cgroup lineage rather than leaf maxima", () => {
  const pod = randomUUID(),
    a = "a".repeat(64),
    b = "b".repeat(64);
  const tasks = `NODE NAMESPACE ID IMAGE PID STATUS\nnode k8s.io └─ ${a} image@sha256:${a} 123 RUNNING\nnode k8s.io └─ ${b} image@sha256:${b} 124 RUNNING\n`;
  assert.deepEqual(thinPoolProcesses(tasks, [a, b]), [
    { container_id: a, pid: 123 },
    { container_id: b, pid: 124 },
  ]);
  const parent = `kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod${pod.replaceAll("-", "_")}.slice`;
  assert.equal(
    thinPoolProcessCgroup(`0::/${parent}/cri-containerd-${a}.scope\n`, pod, a),
    `${parent}/cri-containerd-${a}.scope`,
  );
  assert.throws(
    () =>
      thinPoolProcessCgroup(
        `0::/${parent}/cri-containerd-${b}.scope\n`,
        pod,
        a,
      ),
    /pool_process_changed/,
  );
  const fields = Array.from({ length: 20 }, () => "0");
  fields[0] = "S";
  fields[19] = "456";
  assert.equal(
    thinPoolProcessStat(`123 (name ) with spaces) ${fields.join(" ")}\n`, 123),
    456,
  );
  assert.equal(
    thinPoolPidNamespace(
      "NODE MODE UID GID SIZE LASTMOD LABEL NAME\nnode Lrwxrwxrwx 0 0 0 today - pid -> pid:[4026532222]\n",
    ),
    4026532222,
  );
  assert.throws(
    () => thinPoolProcesses(tasks + tasks.split("\n")[1] + "\n", [a, b]),
    /pool_process_changed/,
  );
});

test("pool aggregate IO is bound to the real retained VG, LV, thin ID and device", () => {
  const device = {
    volume_group_uuid: vg,
    lv_uuid: pool,
    thin_id: 7,
    device_major: 253,
    device_minor: 4,
  };
  const custody = {
    device,
  } as PoolHostCustody;
  const lv = {
    lv_uuid: pool,
    thin_id: "7",
    lv_kernel_major: "253",
    lv_kernel_minor: "4",
  };
  assert.deepEqual(thinPoolDevice(custody, vg, lv), { major: 253, minor: 4 });
  for (const changed of [
    { ...lv, thin_id: "8" },
    { ...lv, lv_uuid: vg },
    { ...lv, lv_kernel_minor: "5" },
  ])
    assert.throws(
      () => thinPoolDevice(custody, vg, changed),
      /thin_storage_pool_device_changed/,
    );
  assert.throws(
    () => thinPoolDevice(custody, pool, lv),
    /thin_storage_pool_device_changed/,
  );
  assert.throws(
    () => thinPoolDevice({ ...custody, device: null }, vg, lv),
    /thin_storage_pool_device_unconfirmed/,
  );
});

test("stopped pool cleanup preserves exact suspended physical inventory without an IO grant", () => {
  const boot = randomUUID();
  const custody = {
    holder_boot_id: boot,
    state: "detaching",
    device: null,
  } as PoolHostCustody;
  const receipt = {
    storage_generation: 1,
    storage_uid: randomUUID(),
    namespace_uid: randomUUID(),
    cluster_uid: randomUUID(),
    node_uid: randomUUID(),
    volume_group_uuid: vg,
    pool_uuid: pool,
    volume_handle: `pvc-${randomUUID()}`,
    lv_uuid: "cdefgh-cdef-cdef-cdef-cdef-cdef-cdefgh",
    pvc_uid: randomUUID(),
    pv_uid: randomUUID(),
  };
  const lv = {
    lv_name: receipt.volume_handle,
    lv_uuid: receipt.lv_uuid,
    segtype: "thin",
    pool_lv: "pgcf_thinpool",
    lv_attr: "Vwi-sotz--",
  };
  const observed = {
    ...receipt,
    database_id: "abcdefghijklmnopqrst",
    generation: 2,
    storage_class: "class",
    volume_attributes_class: "class",
    quiesced: true,
    io: [],
  };
  const physical = {
    vg_uuid: vg,
    pool_uuid: pool,
    active: [receipt.lv_uuid],
    rows: [lv],
  };
  assert.equal(
    thinPoolQuiesced(custody, boot, receipt, physical, observed),
    true,
  );
  assert.equal(
    thinPoolQuiesced(
      custody,
      boot,
      receipt,
      { ...physical, rows: [{ ...lv, lv_attr: "Vwi-aotz--" }] },
      observed,
    ),
    false,
  );
  assert.equal(
    thinPoolQuiesced(
      { ...custody, state: "serving" },
      boot,
      receipt,
      physical,
      observed,
    ),
    false,
  );
  assert.throws(
    () => thinPoolQuiesced(custody, randomUUID(), receipt, physical, observed),
    /thin_storage_pool_boot_changed/,
  );
  assert.throws(
    () =>
      thinPoolQuiesced(custody, boot, receipt, physical, {
        ...observed,
        lv_uuid: vg,
      }),
    /thin_storage_pool_receipt_changed/,
  );
  assert.throws(
    () =>
      thinPoolQuiesced(
        custody,
        boot,
        receipt,
        { ...physical, active: [] },
        observed,
      ),
    /thin_storage_pool_receipt_changed/,
  );
  assert.deepEqual(observed.io, []);
});

test("a fixed growth command survives concurrent thin usage but still refuses changed UUID or VG headroom", () => {
  const grow = {
    ...action,
    kind: "grow" as const,
    expected_pool_uuid: pool,
    target_data_bytes: 2 * 1024 ** 3,
  };
  const before = facts([poolRow]);
  const during = facts([
    { ...poolRow, data_percent: "50.00", metadata_percent: "0.50" },
  ]);
  assert.deepEqual(
    thinPoolCommand(input, before, grow),
    thinPoolCommand(input, during, grow),
  );
  assert.throws(
    () =>
      thinPoolCommand(
        input,
        { ...during, pool_uuid: "defghi-defg-defg-defg-defg-defg-defghi" },
        grow,
      ),
    /thin_storage_pool_identity_changed/,
  );
  assert.throws(
    () => thinPoolCommand(input, { ...during, free: 0 }, grow),
    /thin_storage_growth_unqualified/,
  );
});

test("only a genuine current delete retains its sealed LV after Kube resource removal", () => {
  const receipt = {
    storage_generation: 1,
    storage_uid: "11111111-1111-4111-8111-111111111111",
    namespace_uid: "22222222-2222-4222-8222-222222222222",
    cluster_uid: "33333333-3333-4333-8333-333333333333",
    node_uid: input.lease.node_uid,
    volume_group_uuid: vg,
    pool_uuid: pool,
    volume_handle: "pvc-44444444-4444-4444-8444-444444444444",
    lv_uuid: "cdefgh-cdef-cdef-cdef-cdef-cdef-cdefgh",
    pvc_uid: "44444444-4444-4444-8444-444444444444",
    pv_uid: "55555555-5555-4555-8555-555555555555",
  };
  const policy = {
    backend: "lvm-thin-v1",
    storage_class: "pgcf-lvm-thin-v1-" + "a".repeat(16),
    volume_attributes_class: "pgcf-lvm-thin-v1-" + "a".repeat(16),
    profile_revision: 1,
    profile_sha256: "a".repeat(64),
    node_uid: receipt.node_uid,
    volume_group_uuid: vg,
    pool_uuid: pool,
    startup_reserve_bytes: profile.startup_reserve_bytes,
    write_bytes_per_second: profile.write_bytes_per_second,
    write_iops_per_second: profile.write_iops_per_second,
    guard_seconds: 10,
    drain_seconds: 10,
  } as const;
  const db = {
    id: "abcdefghijklmnopqrst",
    generation: 2,
    storage_generation: 1,
    desired_state: "deleted",
    archive_path: "s3://test/database",
    power_operation: null,
    stop_operation: {
      operation_id: "op_abcdefghijklmnopqrst",
      kind: "database.delete",
      generation: 2,
    },
    storage: policy,
    volume: receipt,
    startup: null,
  } as const;
  const actual = facts([
    poolRow,
    {
      vg_uuid: vg,
      lv_name: receipt.volume_handle,
      lv_uuid: receipt.lv_uuid,
      lv_size: String(5 * 1024 ** 3),
      segtype: "thin",
      pool_lv: "pgcf_thinpool",
      lv_attr: "Vwi-s-tz--",
      data_percent: "1.00",
      metadata_percent: "",
      lv_metadata_size: "",
      lv_when_full: "",
      lv_tags: "",
    },
  ]);
  const scope = { ...input.lease, name: "actual-node" };
  assert.equal(
    thinDeletingVolume(scope, db, actual, {})?.lv_uuid,
    receipt.lv_uuid,
  );
  assert.equal(
    thinDeletingVolume(scope, { ...db, stop_operation: null }, actual, {}),
    null,
  );
  assert.equal(
    thinDeletingVolume(scope, { ...db, desired_state: "running" }, actual, {}),
    null,
  );
  assert.throws(
    () =>
      thinDeletingVolume(
        scope,
        db,
        { ...actual, pool_uuid: "defghi-defg-defg-defg-defg-defg-defghi" },
        {},
      ),
    /retained_delete_identity_changed/,
  );
  assert.throws(
    () =>
      thinDeletingVolume(scope, db, actual, {
        namespace: { metadata: { uid: "replacement" } },
      }),
    /retained_delete_identity_changed/,
  );
});

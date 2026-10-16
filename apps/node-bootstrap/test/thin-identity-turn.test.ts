// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import type {
  NodeThinStorageInput,
  NodeThinStorageReport,
} from "@pgcf/contracts/node-thin-storage";
import { BootstrapError } from "../src/bootstrap.ts";
import {
  openThinSession,
  readThinIdentityCycle,
  runThinStorage,
} from "../src/thin-storage.ts";
import golden from "./thin-identity-turn.golden.json" with { type: "json" };
import {
  identityTurn,
  identityWorld,
  uuid,
  type IdentityWorld,
  type RelayCommand,
} from "./thin-identity.fixture.ts";

/** The report's three clock fields are stated by the lease and the turn; everything else is fixed. */
function normalized(
  report: NodeThinStorageReport,
  input: NodeThinStorageInput,
) {
  const value = structuredClone(report);
  assert.equal(value.authority.observed_at, input.lease.issued_at);
  assert.equal(value.authority.expires_at, input.lease.expires_at);
  assert.ok(Date.parse(value.authority.captured_at) <= Date.now());
  value.authority.observed_at = "<lease issued_at>";
  value.authority.expires_at = "<lease expires_at>";
  value.authority.captured_at = "<turn time>";
  return value;
}
const failedWith = (code: string) => (error: unknown) =>
  error instanceof BootstrapError && error.code === code;
/** The seven cluster-wide lists of the inventory, as kubectl is asked for them. */
const inventoryList = (command: RelayCommand) =>
  command.executable === "kubectl" &&
  command.args[0] === "get" &&
  (command.args.includes("--all-namespaces") ||
    command.args[1] === "pv" ||
    command.args[1] === "namespaces" ||
    (command.args[1] === "configmaps" && command.args.includes("pgcf-system")));
const lvmReads = (world: IdentityWorld) =>
  world.relay.filter((command) =>
    command.programs.some((program) => program.startsWith("lvs ")),
  );

test("an identity turn reports every fact of the node, its volumes and its writers", async () => {
  const world = identityWorld();
  const { report, input } = await identityTurn(world);
  // Two Pods of one writer, a sleeper's protection marker, a start without io.max and a retained
  // delete: the report is the same document however the reads that produce it are issued.
  assert.deepEqual(normalized(report, input), golden);
});

// A turn costs sequential relay connections: one wave of identity, Kubernetes and Talos reads, the
// driver read (kubectl exec gets the Pod, then upgrades), the inventory wave with its witness, and
// the closing driver read.
const MAX_ROUNDS = 6,
  MAX_COMMANDS = 22;
test("an identity turn needs at most 6 sequential relay connections and 22 commands, whatever its volume count", async () => {
  const small = identityWorld(),
    large = identityWorld(8);
  await identityTurn(small);
  await identityTurn(large);
  for (const world of [small, large]) {
    assert.ok(
      world.rounds <= MAX_ROUNDS,
      `${world.rounds} sequential relay connections`,
    );
    assert.ok(world.commands <= MAX_COMMANDS, `${world.commands} commands`);
  }
  assert.equal(large.rounds, small.rounds);
  assert.equal(large.commands, small.commands);
});

// One script argument can be 128 KiB at most (MAX_ARG_STRLEN), and each writer Pod adds about 1.3 KiB.
test("a node with many writer Pods reads their io.max in several driver reads, none beyond the argument limit, in the same sequential connections", async () => {
  const world = identityWorld(120);
  const { report } = await identityTurn(world);
  const reads = world.relay.filter((command) => command.args[0] === "exec");
  assert.ok(reads.length >= 3, `${reads.length} driver reads`);
  for (const read of reads)
    for (const arg of read.args)
      assert.ok(arg.length < 100_000, `a ${arg.length} byte argument`);
  assert.ok(world.rounds <= MAX_ROUNDS, `${world.rounds} connections`);
  // Every Pod with a cgroup is read: the writer's two and the 120 more.
  assert.equal(
    report.authority.volumes.flatMap((volume) => volume.io).length,
    122,
  );
});

test("the qualification's executor cycle reads like a turn, in the same sequential connections, and writes nothing", async () => {
  const world = identityWorld(),
    input = world.input();
  await openThinSession(
    {
      callback: input.callback,
      cluster_endpoint: input.cluster_endpoint,
      talos_admin_config: input.talos_admin_config,
      kubeconfig: input.kubeconfig,
      address: input.lease.address,
      budget_ms: 60_000,
      prefix: "pgcf-thin-cycle-test-",
    },
    {
      run: (command) => world.command(command),
      proxy: async () => ({ url: "http://127.0.0.1:1", close: async () => {} }),
    },
    (session) =>
      readThinIdentityCycle(
        session,
        {
          node_id: input.lease.node_id,
          region_id: input.lease.region_id,
          node_uid: input.lease.node_uid,
          cluster_uid: input.lease.cluster_uid,
          name: input.lease.name,
          provider_instance_id: input.lease.provider_instance_id,
          driver_image: input.lease.profile.driver_image,
          host_extension_version: input.host_extension.version,
          boot_id: input.lease.boot_id,
          kernel_version: input.lease.kernel_version,
        },
        async () => {},
      ),
  );
  assert.ok(world.rounds <= MAX_ROUNDS, `${world.rounds} connections`);
  assert.ok(world.commands <= MAX_COMMANDS, `${world.commands} commands`);
  assert.ok(
    world.relay.every((command) =>
      ["get", "read", "exec"].includes(command.args[0]!),
    ),
  );
});

test("the LVM reports bracket the cluster inventory and every writer's io.max is read before the closing report", async () => {
  const world = identityWorld();
  await identityTurn(world);
  const reads = lvmReads(world);
  assert.equal(reads.length, 2);
  const lists = world.relay.filter(inventoryList);
  assert.equal(lists.length, 7);
  for (const list of lists) {
    assert.ok(reads[0]!.ended < list.started, "the opening report comes first");
    assert.ok(list.ended < reads[1]!.started, "the closing report comes last");
  }
  // The programs of the driver in the order they ran: each io.max before the closing lvs.
  const ran = world.relay
    .filter((command) => command.programs.length)
    .sort((a, b) => a.ended - b.ended)
    .flatMap((command) => command.programs);
  const closing = ran.lastIndexOf(
    ran.filter((p) => p.startsWith("lvs ")).at(-1)!,
  );
  const limits = ran.flatMap((program, index) =>
    program.includes("io.max") ? [index] : [],
  );
  assert.equal(limits.length, 2, "one io.max per Pod that has a cgroup");
  assert.ok(limits.every((index) => index < closing));
});

test("the driver's shell scripts run only the read-only programs of the identity read", async () => {
  const world = identityWorld();
  await identityTurn(world);
  const programs = world.relay.flatMap((command) => command.programs);
  assert.ok(programs.length > 0);
  const allowed = new Set([
    "cat",
    "dmsetup",
    "lvs",
    "sha256sum",
    "thin_check",
    "vgs",
  ]);
  assert.ok(programs.every((program) => allowed.has(program.split(" ")[0]!)));
  assert.ok(
    programs
      .filter((program) => program.startsWith("dmsetup "))
      .every((program) => program.startsWith("dmsetup info --columns")),
  );
});

test("a changed driver binary leaves the node unqualified", async () => {
  const world = identityWorld();
  world.outputs.set(
    "sha256sum",
    `${"0".repeat(64)}  /usr/local/bin/lvm-driver\n${"0".repeat(64)}  /sbin/lvm\n${"0".repeat(64)}  /usr/sbin/pdata_tools\n`,
  );
  await assert.rejects(
    identityTurn(world),
    failedWith("thin_storage_driver_unqualified"),
  );
});

test("a logical volume created during the turn is an inventory that changed, not a proof", async () => {
  const world = identityWorld();
  world.afterScript = (count) => {
    if (count === 1)
      world.addLv({
        name: "pvc-99999999-9999-4999-8999-999999999999",
        uuid: "NewLvx-1234-1234-1234-1234-1234-NewLvx",
        segtype: "thin",
        pool: "pgcf_thinpool",
        size: 5 * 1024 ** 3,
        tags: [],
      });
  };
  await assert.rejects(
    identityTurn(world),
    failedWith("thin_storage_inventory_changed"),
  );
});

test("an established writer without a readable io.max blocks the proof, a held start does not", async () => {
  const world = identityWorld();
  // Only the writer's Pods lose their cgroups; the held start never had one.
  world.cgroups.clear();
  await assert.rejects(
    identityTurn(world),
    failedWith("thin_storage_io_limit_missing"),
  );
});

test("a driver tool that exits non-zero is a failed command after its repeats", async () => {
  const world = identityWorld();
  world.failing.add("lvs");
  await assert.rejects(
    identityTurn(world),
    failedWith("thin_storage_command_failed"),
  );
});

test("a node that rebooted during the turn is a changed driver identity", async () => {
  const world = identityWorld();
  world.afterScript = (count) => {
    if (count === 1) Object.assign(world, { boot: uuid(0xb1) });
  };
  await assert.rejects(
    identityTurn(world),
    failedWith("thin_storage_driver_identity_changed"),
  );
});

/** One turn of the world under a cancel the test controls: `status` and `report` answer those calls
 * (as fetch does, a call whose signal aborts fails), `close` runs while the session is cleaned up. */
async function cancellableTurn(
  world: IdentityWorld,
  cancel: AbortController,
  hooks: {
    status?: (current: object) => object;
    report?: () => Promise<void>;
    close?: () => Promise<void>;
  } = {},
) {
  const input = world.input(),
    reports: unknown[] = [];
  const request: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const answer = async () => {
      if (body.kind === "status") {
        const current = {
          operation_id: input.lease.operation_id,
          revision: input.lease.revision,
          node_uid: input.lease.node_uid,
          release_id: input.lease.release_id,
          spec_sha256: input.lease.spec_sha256,
          assignment_revision: input.lease.assignment_revision,
          region_revision: input.lease.region_revision,
        };
        return Response.json(hooks.status?.(current) ?? current);
      }
      if (body.kind === "report") {
        await hooks.report?.();
        reports.push(body.report);
      }
      return Response.json({ accepted: true });
    };
    const response = await answer();
    init?.signal?.throwIfAborted();
    return response;
  };
  const outcome = runThinStorage(input, {
    run: (command) => world.command(command),
    request,
    proxy: async () => ({
      url: "http://127.0.0.1:1",
      close: hooks.close ?? (async () => {}),
    }),
    signal: cancel.signal,
  });
  return { outcome, reports };
}

test("a cancelled turn ends as cancelled, whatever its interrupted read raised", async () => {
  const world = identityWorld(),
    cancel = new AbortController();
  const { outcome, reports } = await cancellableTurn(world, cancel, {
    status: (current) => {
      cancel.abort();
      return current;
    },
  });
  await assert.rejects(outcome, failedWith("thin_storage_turn_cancelled"));
  assert.deepEqual(reports, []);
});

test("a failure the turn raised before a cancel keeps its own code, even when the cancel arrives during cleanup", async () => {
  const world = identityWorld(),
    cancel = new AbortController();
  const { outcome } = await cancellableTurn(world, cancel, {
    status: (current) => ({ ...current, revision: 99 }),
    close: async () => {
      cancel.abort();
      await new Promise((resolve) => setTimeout(resolve, 200));
    },
  });
  await assert.rejects(outcome, failedWith("thin_storage_lease_changed"));
});

test("a read that finished before a cancel keeps the failure it proves", async () => {
  const world = identityWorld(),
    cancel = new AbortController();
  world.outputs.set(
    "sha256sum",
    `${"0".repeat(64)}  /usr/local/bin/lvm-driver\n${"0".repeat(64)}  /sbin/lvm\n${"0".repeat(64)}  /usr/sbin/pdata_tools\n`,
  );
  // The cancel arrives as the first driver read returns; that read proves a changed driver.
  world.afterScript = (count) => {
    if (count === 1) cancel.abort();
  };
  const { outcome } = await cancellableTurn(world, cancel);
  await assert.rejects(outcome, failedWith("thin_storage_driver_unqualified"));
});

test("a cancel before the report is sent ends the turn without it", async () => {
  const world = identityWorld(),
    cancel = new AbortController();
  // The last driver read is the closing one: the cancel arrives as it returns.
  world.afterScript = (count) => {
    if (count === 2) cancel.abort();
  };
  const { outcome, reports } = await cancellableTurn(world, cancel);
  await assert.rejects(outcome, failedWith("thin_storage_turn_cancelled"));
  assert.deepEqual(reports, []);
});

test("the report is the turn's point of no return: a cancel during it waits for Cloudflare's answer", async () => {
  const world = identityWorld(),
    cancel = new AbortController();
  const { outcome, reports } = await cancellableTurn(world, cancel, {
    report: async () => {
      cancel.abort();
      await new Promise((resolve) => setImmediate(resolve));
    },
  });
  assert.deepEqual(await outcome, { accepted: true });
  assert.equal(reports.length, 1);
});

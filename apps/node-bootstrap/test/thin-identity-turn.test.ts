// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import type {
  NodeThinStorageInput,
  NodeThinStorageReport,
} from "@pgcf/contracts/node-thin-storage";
import { BootstrapError } from "../src/bootstrap.ts";
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

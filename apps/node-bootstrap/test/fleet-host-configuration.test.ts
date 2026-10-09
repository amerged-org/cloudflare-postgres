// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { parseAllDocuments, stringify } from "yaml";
import {
  mergeHostConfiguration,
  readHostConfiguration,
  applyHostConfiguration,
  hostConfigurationMatches,
} from "../src/fleet-host-configuration.ts";
import { NodeHostConfigurationPrivate } from "@pgcf/contracts/node-host-configuration";
import { randomUUID } from "node:crypto";
import { canonical, digest } from "../src/bootstrap.ts";
const files = NodeHostConfigurationPrivate.shape.files.parse([
  {
    path: "/var/lib/pgcf-sandbox/settings.json",
    permissions: 384,
    content: '{"version":1}\n',
  },
  {
    path: "/var/lib/pgcf-sandbox/agent-key",
    permissions: 384,
    content: "test-only-key\n",
  },
]);
const host = NodeHostConfigurationPrivate.parse({
  files,
  status: {
    version: 1,
    node_id: "nod_abcdefghijklmnopqrst",
    node_uid: randomUUID(),
    region_id: "test",
    cluster_uid: randomUUID(),
    material_revision: 1,
    revision: 1,
    release_id: "test",
    pool_policy_revision: 1,
    profile_sha256: "a".repeat(64),
    sha256: digest(canonical(files)),
    created_at: new Date().toISOString(),
  },
});
const source = [
  {
    version: "v1alpha1",
    machine: {
      files: [
        {
          path: "/var/lib/other",
          content: "preserved",
          permissions: 420,
          op: "create",
        },
      ],
      network: { hostname: "retained" },
    },
    cluster: { secret: "test-only-retained" },
  },
  { apiVersion: "v1alpha1", kind: "LinkConfig", name: "eth0", mtu: 1500 },
];
const raw = (values: unknown[], id = "v1alpha1") =>
  JSON.stringify({
    metadata: { type: "MachineConfigs.config.talos.dev", id },
    spec: values.map((v) => stringify(v)).join("---\n"),
  });
test("fixed host files preserve all unrelated multidoc configuration and are proved from active and persistent resources", async () => {
  const merged = mergeHostConfiguration(raw(source), host),
    values = parseAllDocuments(merged).map((v) => v.toJSON());
  assert.deepEqual(values[1], source[1]);
  assert.deepEqual(values[0].cluster, source[0]!.cluster);
  assert.deepEqual(values[0].machine.network, source[0]!.machine!.network);
  assert.deepEqual(values[0].machine.files[0], source[0]!.machine!.files[0]);
  assert.equal(values[0].machine.files.length, 3);
  assert.equal(hostConfigurationMatches(raw(values), "v1alpha1", host), true);
  const observed = await readHostConfiguration(
    { talos: async (args) => raw(values, args[2]!) },
    host,
  );
  assert.equal(observed.matches, true);
  const repeated = parseAllDocuments(
    mergeHostConfiguration(raw(values), host),
  ).map((v) => v.toJSON());
  assert.deepEqual(repeated, values);
});
test("changed full configuration before dispatch refuses the only supported apply", async () => {
  let writes = 0,
    changed = false;
  const commands = {
    talos: async (args: string[]) => {
      if (args[0] === "apply-config") {
        writes++;
        throw Error("lost_reply");
      }
      return raw(
        changed
          ? [...source, { kind: "changed", apiVersion: "v1alpha1" }]
          : source,
        args[2]!,
      );
    },
  };
  const before = await readHostConfiguration(commands, host);
  changed = true;
  await assert.rejects(
    applyHostConfiguration(commands, host, before),
    /patch_host_configuration_changed_before_write/,
  );
  assert.equal(writes, 0);
  changed = false;
  await applyHostConfiguration(commands, host, before);
  assert.equal(writes, 1);
});

test("a selected thin release appends only the missing dm_thin_pool config and requires actual loaded state", async () => {
  const merged = mergeHostConfiguration(raw(source), host, true),
    values = parseAllDocuments(merged).map((v) => v.toJSON());
  assert.deepEqual(values.slice(1, -1), source.slice(1));
  assert.deepEqual(values.at(-1), {
    apiVersion: "v1alpha1",
    kind: "KernelModuleConfig",
    name: "dm_thin_pool",
  });
  const withParameters = [
    ...values.slice(0, -1),
    { ...values.at(-1), parameters: ["retained=1"] },
  ];
  const repeated = parseAllDocuments(
    mergeHostConfiguration(raw(withParameters), host, true),
  ).map((v) => v.toJSON());
  assert.deepEqual(repeated, withParameters);
  let loaded = false,
    writes = 0;
  const commands = {
    talos: async (args: string[]) => {
      if (args[0] === "apply-config") {
        writes++;
        return "";
      }
      return args[0] === "read"
        ? loaded
          ? "dm_thin_pool 123 0 - Live 0x0\n"
          : ""
        : raw(values, args[2]!);
    },
  };
  const pending = await readHostConfiguration(commands, host, undefined, true);
  assert.equal(pending.matches, false);
  await applyHostConfiguration(commands, host, pending);
  assert.equal(
    writes,
    0,
    "confirmed configuration must not replay while the module controller is pending",
  );
  loaded = true;
  assert.equal(
    (await readHostConfiguration(commands, host, undefined, true)).matches,
    true,
  );
});

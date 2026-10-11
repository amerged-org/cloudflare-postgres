// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { parseAllDocuments, stringify } from "yaml";
import {
  mergeHostConfiguration,
  readHostConfiguration,
  readMachineConfiguration,
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
const configList = (values: unknown[]) =>
  [raw(values), raw(values, "persistent")].join("\n");
test("new fixed /var files use boot-safe create; a declaration requiring nonexistent files is not configured", () => {
  // Talos1.14.2 WriteUserFiles checks existence for overwrite before writing.
  // create permits both first boot and updating an existing /var file.
  const values = parseAllDocuments(
    mergeHostConfiguration(raw(source), host),
  ).map((value) => value.toJSON());
  const fixed = values[0].machine.files.filter((file: { path: string }) =>
    host.files.some((expected) => expected.path === file.path),
  );
  assert.equal(fixed.length, 2);
  assert.ok(fixed.every((file: { op: string }) => file.op === "create"));
  assert.deepEqual(values[0].machine.network, source[0]!.machine!.network);
  assert.deepEqual(values[0].cluster, source[0]!.cluster);
  assert.deepEqual(values[0].machine.files[0], source[0]!.machine!.files[0]);
  assert.deepEqual(values[1], source[1]);
  assert.equal(hostConfigurationMatches(raw(values), "v1alpha1", host), true);
  const overwrite = structuredClone(values);
  for (const file of overwrite[0].machine.files)
    if (host.files.some((expected) => expected.path === file.path))
      file.op = "overwrite";
  assert.equal(
    hostConfigurationMatches(raw(overwrite), "v1alpha1", host),
    false,
    "persistent configuration must recreate the two fixed files after a reboot",
  );
});
test("admitted host configuration removes only persisted bootstrap quarantine even when host files already match", async () => {
  const declared = parseAllDocuments(
    mergeHostConfiguration(raw(source), host),
  ).map((document) => document.toJSON());
  const node = {
    apiVersion: "v1alpha1",
    kind: "KubeNodeConfig",
    labels: { retained: "label" },
    taints: {
      "pgcf.io/quarantine": "bootstrap:NoSchedule",
      "customer.example/retained": "owned:NoSchedule",
    },
  };
  let current = [...declared, node],
    writes = 0;
  const commands = {
    talos: async (args: string[], stdin?: string) => {
      if (args[0] === "apply-config") {
        writes++;
        assert.ok(args.includes("--mode=no-reboot"));
        current = parseAllDocuments(stdin!).map((document) =>
          document.toJSON(),
        );
        throw Error("lost_apply_response");
      }
      return configList(current);
    },
  };
  const before = await readHostConfiguration(
    commands,
    host,
    undefined,
    false,
    undefined,
    false,
    true,
  );
  assert.equal(
    before.configured,
    false,
    "matching host files cannot skip persisted quarantine",
  );
  await applyHostConfiguration(commands, host, before, true);
  const after = await readHostConfiguration(
    commands,
    host,
    undefined,
    false,
    undefined,
    false,
    true,
  );
  assert.equal(after.configured, true);
  assert.deepEqual(current.slice(0, -1), declared);
  assert.deepEqual(current.at(-1), {
    ...node,
    taints: { "customer.example/retained": "owned:NoSchedule" },
  });
  await applyHostConfiguration(commands, host, after, true);
  assert.equal(writes, 1);
  const held = [...declared, node];
  assert.deepEqual(
    parseAllDocuments(mergeHostConfiguration(raw(held), host)).map((document) =>
      document.toJSON(),
    ),
    held,
    "pre-admission input preserves quarantine",
  );
  assert.throws(
    () =>
      mergeHostConfiguration(
        raw([
          ...declared,
          {
            ...node,
            taints: {
              ...node.taints,
              "pgcf.io/quarantine": "foreign:NoSchedule",
            },
          },
        ]),
        host,
        false,
        true,
      ),
    /quarantine_taint_mismatch/,
  );
  assert.throws(
    () => mergeHostConfiguration(raw([...held, node]), host, false, true),
    /configuration_resource_invalid/,
  );
});
test("a persisted new declaration cannot prove unchanged old physical host files", async () => {
  const declared = parseAllDocuments(
    mergeHostConfiguration(raw(source), host),
  ).map((document) => document.toJSON());
  const commands = {
    talos: async (args: string[]) => {
      if (args[0] === "get") return configList(declared);
      assert.equal(args[0], "read");
      return args[1] === host.files[0]!.path
        ? '{"version":0}\n'
        : host.files[1]!.content;
    },
  };
  const observed = await readHostConfiguration(
    commands,
    host,
    undefined,
    false,
    undefined,
    true,
  );
  assert.equal(observed.configured, true);
  assert.equal(observed.matches, false);
});
test("a state-loaded changed boot has only the real active resource; unwitnessed absence and divergent resources remain blocked", async () => {
  const boot = { boot_id: randomUUID(), configuration_boot_id: randomUUID() };
  const commands = {
    talos: async (args: string[]) => {
      assert.deepEqual(args, ["get", "machineconfig", "--output=json"]);
      return raw(source);
    },
  };
  const observed = await readMachineConfiguration(commands, boot);
  assert.equal(observed.active, raw(source));
  assert.equal(observed.persistent, undefined);
  assert.equal(observed.state_loaded?.boot_id, boot.boot_id);
  assert.equal(
    observed.state_loaded?.configuration_boot_id,
    boot.configuration_boot_id,
  );
  await assert.rejects(
    readMachineConfiguration(commands),
    /persistence_unproved/,
  );
  await assert.rejects(
    readMachineConfiguration(commands, {
      ...boot,
      configuration_boot_id: boot.boot_id,
    }),
    /persistence_unproved/,
  );
  await assert.rejects(
    readMachineConfiguration(
      {
        talos: async () =>
          [
            raw(source),
            raw(
              [...source, { kind: "changed", apiVersion: "v1alpha1" }],
              "persistent",
            ),
          ].join("\n"),
      },
      boot,
    ),
    /active_persistent_diverged/,
  );
  await assert.rejects(
    readMachineConfiguration(
      {
        talos: async () => {
          throw Error("transport_failure");
        },
      },
      boot,
    ),
    /transport_failure/,
  );
  await assert.rejects(
    readMachineConfiguration(commands, {
      ...boot,
      configuration_sha256: "f".repeat(64),
    }),
    /persistence_unproved/,
  );
});
test("a proved STATE boot remains bound to the full configuration before a later host-file write", async () => {
  let changed = false,
    writes = 0;
  const commands = {
    talos: async (args: string[]) => {
      if (args[0] === "apply-config") {
        writes++;
        throw Error("lost_reply");
      }
      return raw(
        changed
          ? [...source, { apiVersion: "v1alpha1", kind: "changed" }]
          : source,
      );
    },
  };
  const boot = { boot_id: randomUUID(), configuration_boot_id: randomUUID() };
  const before = await readHostConfiguration(
    commands,
    host,
    undefined,
    false,
    boot,
  );
  await applyHostConfiguration(commands, host, before);
  assert.equal(writes, 1);
  changed = true;
  await assert.rejects(
    applyHostConfiguration(commands, host, before),
    /persistence_unproved/,
  );
  assert.equal(writes, 1);
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
    { talos: async () => configList(values) },
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
      return configList(
        changed
          ? [...source, { kind: "changed", apiVersion: "v1alpha1" }]
          : source,
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
        : configList(values);
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

// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { parseAllDocuments, stringify } from "yaml";
import {
  FleetPatchFacts,
  fleetPatchCheckpointAllowed,
  fleetPatchWritePreflightAllowed,
} from "@pgcf/contracts/fleet-patches";
import { NodeHostConfigurationPrivate } from "@pgcf/contracts/node-host-configuration";
import { canonical, digest } from "../src/bootstrap.ts";
import {
  machineConfigurationSnapshot,
  planHostConfigurationReapply,
  hostConfigurationReapplyReadback,
} from "../src/fleet-host-configuration.ts";
import { patchFixture } from "./fleet-patch.fixture.ts";
import { mergeKubernetesImages } from "../src/fleet-kubernetes-images.ts";
import {
  fleetStateReapplyEligible,
  fleetStateReapplyDisposition,
} from "../src/fleet-state-reapply.ts";

const host = () => {
  const files = NodeHostConfigurationPrivate.shape.files.parse([
    {
      path: "/var/lib/pgcf-sandbox/settings.json",
      permissions: 384,
      content: '{"version":1}\n',
    },
    {
      path: "/var/lib/pgcf-sandbox/agent-key",
      permissions: 384,
      content: "unit-test-key\n",
    },
  ]);
  return NodeHostConfigurationPrivate.parse({
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
};
const resource = (body: string, id = "v1alpha1") =>
  JSON.stringify({
    metadata: { type: "MachineConfigs.config.talos.dev", id },
    spec: body,
  });
const docs = (body: string) =>
  parseAllDocuments(body).map((document) => document.toJSON());

test("full active STATE snapshot journals as explicitly unproved and cannot confirm host_config without persistent readback", () => {
  const { input, facts } = patchFixture();
  const observed = FleetPatchFacts.parse({
    ...facts,
    talos_configuration: { sha256: "a".repeat(64), persistence: "unproved" },
  });
  assert.equal(observed.talos_configuration?.persistence, "unproved");
  input.spec.roles.customer.host_configuration_required = true;
  input.host_configuration = host();
  input.status.host_configuration_sha256 =
    input.host_configuration.status.sha256;
  input.status.stage = "host_config";
  input.status.state = "dispatched";
  assert.equal(
    fleetPatchCheckpointAllowed(input, {
      expected_revision: input.status.revision,
      stage: "host_config",
      state: "confirmed",
      facts: {
        ...observed,
        host_configuration_sha256: input.host_configuration.status.sha256,
      },
      error_code: null,
    }),
    false,
  );
  input.status.baseline = observed;
  assert.equal(
    fleetPatchCheckpointAllowed(input, {
      expected_revision: input.status.revision,
      stage: "host_config",
      state: "confirmed",
      facts: {
        ...facts,
        host_configuration_sha256: input.host_configuration.status.sha256,
      },
      error_code: null,
    }),
    false,
    "an unproved baseline cannot lose its persistence requirement through omitted callback markers",
  );
});

test("recovery dispatch requires the full before/target hash witness, not just host files", () => {
  const { input, facts } = patchFixture();
  input.host_configuration = host();
  input.status.stage = "host_config";
  input.status.state = "pending";
  input.status.baseline = {
    ...facts,
    talos_configuration: { sha256: "a".repeat(64), persistence: "unproved" },
  };
  const observed = {
    ...facts,
    talos_configuration: {
      sha256: "a".repeat(64),
      persistence: "unproved" as const,
    },
  };
  assert.equal(
    fleetPatchCheckpointAllowed(input, {
      expected_revision: input.status.revision,
      stage: "host_config",
      state: "dispatched",
      facts: observed,
      error_code: null,
    }),
    false,
  );
  assert.equal(
    fleetPatchCheckpointAllowed(input, {
      expected_revision: input.status.revision,
      stage: "host_config",
      state: "dispatched",
      facts,
      error_code: null,
    }),
    false,
    "an unproved baseline cannot dispatch without the complete recovery witness",
  );
});

test("actual pinned Talos serialization preserves the full private config and exposes only hashes; lost readback cannot count as persistence", async () => {
  const client = process.env.PGCF_TEST_TALOSCTL;
  assert.ok(client, "checksum-verified native Talos client required");
  const lock = JSON.parse(
      await readFile(
        new URL("../../../infra/platform/versions.lock.json", import.meta.url),
        "utf8",
      ),
    ),
    arch = process.arch === "x64" ? "amd64" : process.arch,
    locked = lock.bootstrapClients.talos.archives.find(
      (entry: { os: string; architecture: string }) =>
        entry.os === process.platform && entry.architecture === arch,
    ),
    // Official v1.14.2 sha256sum.txt; local tests do not change the Linux runtime pins.
    darwinArm64 =
      "4b509e96912278f2af58dc0005be5252124bcba4b87a7f877674160bbf000b6f",
    expected =
      locked?.binarySha256 ??
      locked?.sha256 ??
      (process.platform === "darwin" && arch === "arm64"
        ? darwinArm64
        : undefined);
  assert.ok(
    expected,
    "native test platform needs an explicit official checksum",
  );
  assert.equal(
    createHash("sha256")
      .update(await readFile(client))
      .digest("hex"),
    expected,
    "native Talos test client checksum differs",
  );
  const directory = await mkdtemp(join(tmpdir(), "pgcf-state-reapply-"));
  await chmod(directory, 0o700);
  try {
    const generated = join(directory, "worker.yaml");
    const result = spawnSync(
      client,
      [
        "gen",
        "config",
        "state-reapply-unit",
        "https://api.invalid:6443",
        "--output-types=worker",
        "--output",
        generated,
        "--kubernetes-version=1.36.5",
        "--with-docs=false",
        "--with-examples=false",
      ],
      {
        encoding: "utf8",
        timeout: 30000,
        env: { PATH: process.env.PATH, LANG: "C" },
      },
    );
    assert.equal(
      result.status,
      0,
      "real native Talos configuration generation failed; payload withheld",
    );
    await chmod(generated, 0o600);
    const body = await readFile(generated, "utf8");
    const before = machineConfigurationSnapshot(resource(body));
    assert.equal(before.persistent === undefined, true);
    const privateHost = host(),
      boot = randomUUID();
    const plan = planHostConfigurationReapply(before, privateHost, boot, true);
    assert.equal(plan.intent.before_sha256, before.sha256);
    assert.equal(plan.intent.target_sha256, digest(canonical(docs(plan.body))));
    const actual = docs(plan.body),
      previous = docs(body);
    const changed = structuredClone(actual);
    if (Object.hasOwn(previous[0].machine, "files"))
      changed[0].machine.files = previous[0].machine.files;
    else delete changed[0].machine.files;
    assert.equal(
      canonical(changed) ===
        canonical([
          ...previous,
          {
            apiVersion: "v1alpha1",
            kind: "KernelModuleConfig",
            name: "dm_thin_pool",
          },
        ]),
      true,
      "unrelated full private configuration changed; payload withheld",
    );
    const metadata = patchFixture(),
      input = metadata.input,
      facts = metadata.facts;
    Object.assign(input.spec.roles.customer, {
      host_configuration_required: true,
      talos_version: "1.14.2",
      kubernetes_images: {
        kubelet: `registry.example/kubelet@sha256:${"a".repeat(64)}`,
        apiServer: `registry.example/api@sha256:${"b".repeat(64)}`,
        controllerManager: `registry.example/controller@sha256:${"c".repeat(64)}`,
        scheduler: `registry.example/scheduler@sha256:${"d".repeat(64)}`,
      },
    });
    input.host_configuration = privateHost;
    Object.assign(privateHost.status, {
      node_id: input.status.node_id,
      node_uid: facts.node_uid,
      cluster_uid: facts.cluster_uid,
      region_id: input.status.region_id,
      release_id: input.status.release_id,
    });
    input.status.host_configuration_revision = privateHost.status.revision;
    input.status.host_configuration_sha256 = privateHost.status.sha256;
    Object.assign(facts, {
      talos_version: "v1.14.2",
      kubelet_version: "v1.36.5",
      kubernetes_version: "v1.36.5",
      kubernetes_control_plane: false,
      cluster_nodes: [
        {
          node_uid: facts.node_uid,
          kubelet_version: "v1.36.5",
          node_ready: true,
        },
      ],
    });
    input.retained_talos_installation = {
      boot_id: randomUUID(),
      talos_version: facts.talos_version,
      talos_schematic_sha256: facts.talos_schematic_sha256,
      receipt: {
        method: "deploymentreceipt",
        installer: input.spec.roles.customer.talos_installer,
        node_uid: facts.node_uid,
        cluster_uid: facts.cluster_uid,
        system_uuid: facts.system_uuid,
        pre_reboot_boot_id: randomUUID(),
        completed_at: new Date().toISOString(),
        source: "cli_exit_0",
      },
      kubernetes_image_provenance: {
        method: "pinned_configuration_boot",
        configuration_boot_id: randomUUID(),
        configuration_observed_at: new Date().toISOString(),
        observed_at: new Date().toISOString(),
        kubelet_version: facts.kubelet_version,
        control_plane: false,
        images: {
          kubelet: {
            configuration: input.spec.roles.customer.kubernetes_images!.kubelet,
            runtime_sha256: "a".repeat(64),
          },
        },
      },
    };
    const pinnedBody = mergeKubernetesImages(resource(plan.body), input, false),
      active = resource(pinnedBody);
    assert.equal(
      fleetStateReapplyEligible(input, facts, active, false),
      true,
      "worker recovery selects kubelet despite four role pins",
    );
    assert.equal(
      fleetStateReapplyEligible(
        input,
        { ...facts, node_uid: randomUUID() },
        active,
        false,
      ),
      false,
    );
    assert.equal(
      fleetStateReapplyEligible(
        input,
        { ...facts, system_uuid: randomUUID() },
        active,
        false,
      ),
      false,
    );
    assert.equal(
      fleetStateReapplyEligible(
        input,
        { ...facts, boot_id: input.retained_talos_installation.boot_id },
        active,
        false,
      ),
      false,
    );
    assert.equal(
      fleetStateReapplyEligible(
        input,
        { ...facts, kubelet_version: "v1.36.4" },
        active,
        false,
      ),
      false,
    );
    const wrongRelease = structuredClone(input);
    wrongRelease.spec.roles.customer.talos_installer = `registry.example/talos@sha256:${"e".repeat(64)}`;
    assert.equal(
      fleetStateReapplyEligible(wrongRelease, facts, active, false),
      false,
    );
    assert.equal(
      fleetStateReapplyEligible(input, facts, resource(plan.body), false),
      false,
      "unpinned active image configuration refuses recovery",
    );
    const beforeFacts = {
      ...facts,
      talos_configuration: {
        sha256: before.sha256,
        persistence: "unproved" as const,
      },
      talos_configuration_reapply: plan.intent,
    };
    beforeFacts.boot_id = plan.intent.boot_id;
    input.status.stage = "host_config";
    input.status.state = "dispatched";
    input.status.observed = beforeFacts;
    input.status.baseline = beforeFacts;
    assert.equal(
      fleetPatchWritePreflightAllowed(input, beforeFacts, beforeFacts),
      true,
    );
    assert.equal(
      fleetPatchWritePreflightAllowed(input, beforeFacts, {
        ...beforeFacts,
        boot_id: randomUUID(),
      }),
      false,
    );
    assert.equal(
      fleetPatchWritePreflightAllowed(input, beforeFacts, {
        ...beforeFacts,
        talos_configuration: {
          sha256: "f".repeat(64),
          persistence: "unproved",
        },
      }),
      false,
      "unrelated full-config drift blocks before apply despite identical image/host facts",
    );
    assert.equal(
      fleetStateReapplyDisposition(input.status),
      "readback",
      "lost-reply dispatched re-entry cannot regenerate or repeat its write",
    );
    const provedFacts = {
      ...beforeFacts,
      talos_configuration: {
        sha256: plan.intent.target_sha256,
        persistence: "persistent_readback" as const,
      },
      host_configuration_sha256: privateHost.status.sha256,
    };
    const confirmation = {
      expected_revision: input.status.revision,
      stage: "host_config" as const,
      state: "confirmed" as const,
      facts: provedFacts,
      error_code: null,
    };
    assert.equal(
      fleetPatchCheckpointAllowed(input, confirmation),
      true,
      "exact same-boot persistent target may resolve a lost reply",
    );
    assert.equal(
      fleetPatchCheckpointAllowed(input, {
        ...confirmation,
        facts: { ...provedFacts, boot_id: randomUUID() },
      }),
      false,
      "readback on a different boot cannot confirm the original attempt",
    );
    assert.equal(
      fleetPatchCheckpointAllowed(input, {
        ...confirmation,
        state: "pending",
        error_code: "patch_host_configuration_persistence_unproved",
      }),
      false,
      "uncertain dispatched apply cannot be requeued",
    );
    const payload = join(directory, "configuration.yaml");
    await writeFile(payload, plan.body, { mode: 0o600, flag: "wx" });
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(payload)).mode & 0o777, 0o600);
    const validation = spawnSync(
      client,
      ["validate", "--config", payload, "--mode=metal"],
      {
        encoding: "utf8",
        timeout: 30000,
        env: { PATH: process.env.PATH, LANG: "C" },
      },
    );
    assert.equal(
      validation.status,
      0,
      "real native Talos payload validation failed; payload withheld",
    );
    assert.equal(
      hostConfigurationReapplyReadback(
        resource(plan.body),
        plan.intent,
        privateHost,
        true,
      ) === undefined,
      true,
      "active-only/lost apply must remain unresolved",
    );
    const accepted = hostConfigurationReapplyReadback(
      [resource(plan.body), resource(plan.body, "persistent")].join("\n"),
      plan.intent,
      privateHost,
      true,
    );
    assert.equal(accepted?.sha256, plan.intent.target_sha256);
    const drift =
      stringify({ ...actual[0], debug: true }) +
      "---\n" +
      actual
        .slice(1)
        .map((d) => stringify(d))
        .join("---\n");
    assert.throws(
      () =>
        hostConfigurationReapplyReadback(
          [resource(plan.body), resource(drift, "persistent")].join("\n"),
          plan.intent,
          privateHost,
          true,
        ),
      /active_persistent_diverged/,
    );
    assert.equal(
      hostConfigurationReapplyReadback(
        [resource(drift), resource(drift, "persistent")].join("\n"),
        plan.intent,
        privateHost,
        true,
      ) === undefined,
      true,
      "full configuration drift cannot be accepted from image equality",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

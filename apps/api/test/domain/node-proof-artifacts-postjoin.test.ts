// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import {
  base64urlToBytes,
  bytesToBase64url,
  bytesToHex,
} from "@pgcf/contracts";
import {
  NodeBootstrapCheckpoint,
  NodeStorageTrial,
  NodeBootstrapAdmissionBinding,
} from "@pgcf/contracts/node-bootstrap";
import {
  NodeProofReport,
  canonicalNodeProof,
} from "@pgcf/contracts/node-proof";
import {
  joinBundleReference,
  storeRegionJoinBundle,
} from "../../src/crypto/bootstrap-credentials.ts";
import {
  admissionAuthority,
  bootstrapJobInput,
  configureBootstrapJob,
  readBootstrapJob,
} from "../../src/domain/bootstrap-jobs.ts";
import { installationHash } from "../../src/domain/node-installation.ts";
import * as network from "../../src/domain/node-network.ts";
import { acceptNodeProofReport } from "../../src/domain/node-proof-artifacts.ts";
import { issueNodeProofSession } from "../../src/domain/node-proof-session.ts";
import {
  readNodeAddition,
  saveNodeBootstrapCheckpoint,
} from "../../src/domain/node-state.ts";
import {
  canonicalNodeVerificationProof,
  nodeVerificationProofSchema,
} from "../../src/platform/nodes.ts";
import { ContaboClient } from "../../src/providers/contabo.ts";
import { cleanupFixtures } from "./fixtures.ts";
import { boundInstallationFixture } from "./installation-fixtures.ts";

const regions: string[] = [],
  operations: string[] = [],
  encoder = new TextEncoder();
const hashText = async (text: string) =>
  bytesToHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))),
  );
const nonce = () => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
afterEach(async () => {
  vi.restoreAllMocks();
  for (const operation of operations.splice(0)) {
    for (const prefix of [
      `node-verification/${operation}/`,
      `node-proof-history/${operation}/`,
    ]) {
      const listed = await env.ARCHIVE.list({ prefix });
      for (const object of listed.objects) await env.ARCHIVE.delete(object.key);
    }
  }
  for (const region of regions.splice(0))
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM node_installation_bindings WHERE region_id=?",
      ).bind(region),
      env.DB.prepare(
        "DELETE FROM node_installation_profiles WHERE region_id=?",
      ).bind(region),
      env.DB.prepare(
        "DELETE FROM region_bootstrap_credentials WHERE region_id=?",
      ).bind(region),
    ]);
  await cleanupFixtures();
});

async function fixture() {
  const f = await boundInstallationFixture();
  regions.push(f.fixture.region);
  operations.push(f.addition.intent.operation_id);
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in pair)) throw new Error("fixture_signer_invalid");
  const privateKey = await crypto.subtle.exportKey("pkcs8", pair.privateKey),
    publicKey = await crypto.subtle.exportKey("raw", pair.publicKey);
  if (
    !(privateKey instanceof ArrayBuffer) ||
    !(publicKey instanceof ArrayBuffer)
  )
    throw new Error("fixture_signer_invalid");
  f.bindings.BOOTSTRAP_RELAY_SIGNING_KEYS = JSON.stringify({
    active: "automation",
    keys: { automation: bytesToBase64url(new Uint8Array(privateKey)) },
  });
  f.bindings.BOOTSTRAP_VERIFIER_KEYS = JSON.stringify({
    automation: bytesToBase64url(new Uint8Array(publicKey)),
  });
  // The sole provider stub represents authenticated readback; core proof verification remains real.
  f.bindings.CONTABO_CLIENT_ID = "local-unit-client";
  f.bindings.CONTABO_CLIENT_SECRET = "local-unit-secret";
  f.bindings.CONTABO_USERNAME = "local-unit-user";
  f.bindings.CONTABO_PASSWORD = "local-unit-password";
  const provider = vi
    .spyOn(ContaboClient.prototype, "getInstance")
    .mockImplementation(async (id) => {
      if (id !== f.providerId) throw new Error("unexpected_provider_instance");
      return { ...f.actual, status: "running" };
    });
  const rule = {
    protocol: "tcp",
    destPorts: ["22", "50000", "6443"],
    srcCidr: { ipv4: [`${f.relay.ipConfig.v4.ip}/32`], ipv6: [] },
    action: "accept",
    status: "active",
    displayName: "local-unit-relay",
  };
  const plan = {
    version: 1,
    operation_id: f.addition.intent.operation_id,
    node_id: f.addition.intent.node_id,
    region_id: f.fixture.region,
    provider_instance_id: f.providerId,
    intent_hash: f.addition.intent_hash,
    operators: { ipv4: ["1.1.1.1/32"], ipv6: [] },
    relay: {
      provider_instance_id: f.relay.id,
      addresses: { ipv4: [f.relay.ipConfig.v4.ip], ipv6: [] },
    },
    scan_control: { ipv4: "9.9.9.9", ipv6: "2606:4700:4700::1111", port: 443 },
    members: [
      {
        node_id: f.addition.intent.node_id,
        provider_instance_id: f.providerId,
        addresses: { ipv4: [f.actual.ipConfig.v4.ip], ipv6: [] },
        primary: { ipv4: [f.actual.ipConfig.v4.ip], ipv6: [] },
        firewall_id: crypto.randomUUID(),
        ownership_sha256: await installationHash([
          f.actual.tenantId,
          f.actual.customerId,
        ]),
        rules: { rules: { inbound: [rule] } },
        rules_sha256: await installationHash([rule]),
      },
    ],
  };
  const now = Date.now(),
    at = (offset: number) => new Date(now + offset).toISOString(),
    readback = at(-30_000),
    planHash = await installationHash(plan);
  await env.DB.prepare(
    "DELETE FROM node_network_preparations WHERE operation_id=?",
  )
    .bind(f.addition.intent.operation_id)
    .run();
  await env.DB.prepare(
    "INSERT INTO node_network_preparations(operation_id,intent_hash,plan_sha256,plan_json,status,readback_at,proof_sha256,proof_expires_at,created_at,updated_at) VALUES(?,?,?,?,'verified',?,?,?,?,?)",
  )
    .bind(
      f.addition.intent.operation_id,
      f.addition.intent_hash,
      planHash,
      JSON.stringify(plan),
      readback,
      nonce(),
      at(300_000),
      readback,
      readback,
    )
    .run();
  const addition = await readNodeAddition(
      env.DB,
      f.addition.intent.operation_id,
    ),
    body = {
      ...f.body,
      expected_revision: addition.revision,
      spec: {
        ...f.body.spec,
        inventory_revision: addition.revision,
        rescue_host_fingerprint: f.binding.rescue.ssh_host_fingerprint,
      },
      rescue: {
        ssh_private_key: f.binding.rescue.ssh_private_key,
        ssh_host_key: f.binding.rescue.ssh_host_key,
        ssh_host_fingerprint: f.binding.rescue.ssh_host_fingerprint,
      },
    };
  await configureBootstrapJob(f.bindings, addition.intent.operation_id, body);
  const configured = await readBootstrapJob(
      env.DB,
      addition.intent.operation_id,
    ),
    input = await bootstrapJobInput(f.bindings, configured),
    clusterUid = crypto.randomUUID(),
    nodeUid = crypto.randomUUID(),
    lvmUid = crypto.randomUUID(),
    vgUid = crypto.randomUUID();
  await storeRegionJoinBundle(
    f.bindings.DB,
    f.bindings.CREDENTIAL_KEYS,
    joinBundleReference(f.fixture.region, 1),
    {
      ...f.bundle,
      kube_system_uid: clusterUid,
      cluster_name: input.spec.cluster_name,
      cluster_endpoint: input.spec.cluster_endpoint,
    },
  );
  const before = {
    observed_at: at(-3_000),
    node_uid: nodeUid,
    lvmnode_uid: lvmUid,
    resource_version: "10",
    vg_uuid: vgUid,
    size: 9 * 1024 ** 3,
    free: 9 * 1024 ** 3,
  };
  const pvcUid = crypto.randomUUID(),
    volumeName = `pvc-${pvcUid}`;
  const trial = NodeStorageTrial.parse({
    version: 1,
    input_hash: configured.input_hash,
    node_uid: nodeUid,
    cluster_uid: clusterUid,
    storage_namespace_uid: crypto.randomUUID(),
    lvmnode_uid: lvmUid,
    vg_uuid: vgUid,
    pv_uuid: crypto.randomUUID(),
    device: "/dev/sda5",
    partition_uuid: crypto.randomUUID(),
    total_bytes: before.size,
    extent_size_bytes: 4 * 1024 ** 2,
    runs: [
      {
        namespace_name: `pgcf-storage-${configured.input_hash.slice(0, 20)}-1`,
        trial_sha256: nonce(),
        image: input.spec.platform!.regional_image,
        data_sha256: nonce(),
        volume_bytes: 1024 ** 3,
        stage: "published",
        namespace_uid: crypto.randomUUID(),
        pvc_uid: pvcUid,
        pod_uid: crypto.randomUUID(),
        pv_name: volumeName,
        pv_uid: crypto.randomUUID(),
        volume_handle: volumeName,
        lvmvolume_uid: crypto.randomUUID(),
        lv_uuid: crypto.randomUUID(),
        before,
        allocated: {
          ...before,
          observed_at: at(-2_000),
          resource_version: "11",
          free: 8 * 1024 ** 3,
        },
        after: { ...before, observed_at: at(-1_000), resource_version: "12" },
        written_at: at(-1_500),
        published_at: at(-500),
      },
    ],
  });
  const checkpoint = NodeBootstrapCheckpoint.parse({
    ...JSON.parse(configured.checkpoint_json),
    stage: "awaiting_verification",
    status: "awaiting_verification",
    downloaded_bytes: input.spec.image.compressed_bytes,
    written_bytes: input.spec.image.raw_bytes,
    destructive_intent: true,
    storage_trial: trial,
  });
  await env.DB.prepare(
    "UPDATE node_bootstrap_jobs SET authorized=1,revision=1,checkpoint_json=? WHERE operation_id=?",
  )
    .bind(JSON.stringify(checkpoint), configured.operation_id)
    .run();
  const reference = `${configured.input_hash}:1`;
  await saveNodeBootstrapCheckpoint(
    env.DB,
    configured.operation_id,
    addition.revision,
    { stage: "joined", reference, saved_at: at(-500) },
  );
  await env.DB.prepare(
    "INSERT INTO nodes(id,region_id,k8s_node_name,provider_instance_id,node_uid,ready,schedulable,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,platform_reserved_cpu_millicores,last_observed_at,created_at,updated_at) VALUES(?,?,?,?,?,1,0,8192,8000,8,128,100,?,?,?)",
  )
    .bind(
      configured.node_id,
      configured.region_id,
      input.spec.hostname,
      f.providerId,
      nodeUid,
      at(0),
      at(0),
      at(0),
    )
    .run();
  const run = trial.runs[0]!,
    publication = await installationHash({
      trial: run.trial_sha256,
      before: run.before,
      allocated: run.allocated,
      after: run.after,
      data: run.data_sha256,
    });
  const namespace = {
    kind: "Namespace",
    apiVersion: "v1",
    metadata: { name: "kube-system", uid: clusterUid },
    status: { phase: "Active" },
  };
  const node = {
    kind: "Node",
    apiVersion: "v1",
    metadata: {
      name: input.spec.hostname,
      uid: nodeUid,
      resourceVersion: "2",
      labels: {
        "pgcf.io/node-id": configured.node_id,
        "pgcf.io/region": configured.region_id,
        "pgcf.io/provider-instance-id": f.providerId,
      },
      annotations: {
        "pgcf.io/storage-gib-total": "8",
        "pgcf.io/storage-proof": publication,
      },
    },
    spec: {
      taints: [
        { key: "pgcf.io/quarantine", value: "bootstrap", effect: "NoSchedule" },
      ],
    },
    status: {
      conditions: [{ type: "Ready", status: "True" }],
      addresses: [{ type: "InternalIP", address: f.actual.ipConfig.v4.ip }],
    },
  };
  const binding = {
    plan_sha256: planHash,
    readback_at: readback,
    verification: {
      input_hash: configured.input_hash,
      checkpoint_reference: reference,
      cluster_uid: clusterUid,
      node_uid: nodeUid,
      node_resource_version: "1",
      hostname: input.spec.hostname,
    },
  };
  const report = NodeProofReport.parse({
    binding,
    measurements: [
      {
        purpose: "pgcf-node-measurement/v1",
        binding_sha256: await hashText(canonicalNodeProof(binding)),
        kind: "scan",
        family: "ipv4",
        source: "8.8.4.4",
        observed_at: at(0),
        scans: [
          {
            provider_instance_id: f.providerId,
            address: f.actual.ipConfig.v4.ip,
            protocol: "tcp",
            first_port: 1,
            last_port: 65535,
            scanned_ports: 65535,
            open_ports: [],
            started_at: at(-8_000),
            observed_at: at(-1_000),
            before: {
              address: plan.scan_control.ipv4,
              port: 443,
              source: "8.8.4.4",
              observed_at: at(-10_000),
              nonce: nonce(),
            },
            after: {
              address: plan.scan_control.ipv4,
              port: 443,
              source: "8.8.4.4",
              observed_at: at(-1_000),
              nonce: nonce(),
            },
          },
        ],
      },
    ],
    postjoin: {
      kube_system: namespace,
      node,
      kube_system_after: structuredClone(namespace),
      node_after: structuredClone(node),
      wireguard: { mode: "wireguard", peers: [], packet_observations: [] },
    },
  });
  const session = await issueNodeProofSession(
      f.bindings,
      configured.operation_id,
      "postjoin",
    ),
    firewall = vi.spyOn(network, "ensureNodeFirewall").mockResolvedValue(true);
  return {
    ...f,
    pair,
    job: configured,
    input,
    checkpoint,
    nodeUid,
    clusterUid,
    reference,
    report,
    session,
    provider,
    firewall,
    alias: `node-verification/${configured.operation_id}/${reference}/proof.json`,
    history: (sha: string) =>
      `node-proof-history/${configured.operation_id}/postjoin/${session.claims.session_id}/${sha}.json`,
  };
}

it("publishes a complete storage and raw Kubernetes postjoin proof and authorizes real quarantined admission", async () => {
  const f = await fixture();
  const result = await acceptNodeProofReport(
    f.bindings,
    f.session.bearer,
    f.report,
  );
  expect(result.verified).toBe(true);
  expect(result.mode).toBe("postjoin");
  const object = await env.ARCHIVE.get(f.alias);
  expect(object !== null).toBe(true);
  const body = await object!.text(),
    document = JSON.parse(body) as { payload: unknown; signature: string },
    payload = nodeVerificationProofSchema.parse(document.payload),
    signature = base64urlToBytes(document.signature);
  expect(await hashText(body)).toBe(result.sha256);
  expect(signature !== null).toBe(true);
  expect(
    await crypto.subtle.verify(
      "Ed25519",
      f.pair.publicKey,
      Uint8Array.from(signature!),
      encoder.encode(
        "pgcf-node-verification/v1\n" + canonicalNodeVerificationProof(payload),
      ),
    ),
  ).toBe(true);
  expect(payload.node_resource_version).toBe("2");
  expect(await (await env.ARCHIVE.get(f.history(result.sha256)))!.text()).toBe(
    body,
  );
  const job = await readBootstrapJob(env.DB, f.job.operation_id),
    authority = await admissionAuthority(f.bindings, job),
    binding = NodeBootstrapAdmissionBinding.parse(
      JSON.parse(job.admission_binding_json!),
    );
  expect(job.admission_authorized).toBe(1);
  expect(job.admission_expires_at).toBe(payload.expires_at);
  expect(Date.parse(job.admission_expires_at!) > Date.now()).toBe(true);
  expect(authority.admission_authorized).toBe(true);
  expect(binding).toEqual({
    checkpoint_revision: 1,
    node_uid: f.nodeUid,
    resource_version: "2",
    kube_system_uid: f.clusterUid,
    quarantine: {
      key: "pgcf.io/quarantine",
      value: "bootstrap",
      effect: "NoSchedule",
    },
  });
  const node = await env.DB.prepare("SELECT schedulable FROM nodes WHERE id=?")
    .bind(f.job.node_id)
    .first<{ schedulable: number }>();
  expect(node?.schedulable).toBe(0);
  expect(f.provider.mock.calls.length).toBe(1);
  expect(f.provider.mock.calls[0]![0]).toBe(f.providerId);
  expect(f.firewall.mock.calls.length).toBe(1);
  // Assertions never include Env or decrypted job objects in failure diagnostics.
  expect(f.firewall.mock.calls[0]![0] === f.bindings).toBe(true);
  expect(f.firewall.mock.calls[0]![1]).toBe(f.job.operation_id);
  await env.DB.prepare(
    "UPDATE node_bootstrap_jobs SET admission_expires_at=? WHERE operation_id=?",
  )
    .bind(new Date(Date.now() - 1).toISOString(), f.job.operation_id)
    .run();
  const expired = await readBootstrapJob(env.DB, f.job.operation_id),
    denied = await admissionAuthority(f.bindings, expired);
  expect(denied.admission_authorized).toBe(false);
  expect(denied.admission_binding).toEqual(binding);
});

it("rejects a raw Node storage publication marker mismatch before writing to R2", async () => {
  const f = await fixture(),
    put = vi.spyOn(env.ARCHIVE, "put"),
    wrongMarker = nonce();
  for (const value of [f.report.postjoin!.node, f.report.postjoin!.node_after])
    (value.metadata as { annotations: Record<string, string> }).annotations[
      "pgcf.io/storage-proof"
    ] = wrongMarker;
  await expect(
    acceptNodeProofReport(f.bindings, f.session.bearer, f.report),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(put.mock.calls.length).toBe(0);
  expect(f.provider.mock.calls.length).toBe(0);
  expect(
    (await readBootstrapJob(env.DB, f.job.operation_id)).admission_authorized,
  ).toBe(0);
});

it("rejects a replaced raw Node UID before writing to R2", async () => {
  const f = await fixture(),
    put = vi.spyOn(env.ARCHIVE, "put"),
    foreignUid = crypto.randomUUID();
  for (const value of [f.report.postjoin!.node, f.report.postjoin!.node_after])
    (value.metadata as { uid: string }).uid = foreignUid;
  await expect(
    acceptNodeProofReport(f.bindings, f.session.bearer, f.report),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(put.mock.calls.length).toBe(0);
  expect(f.provider.mock.calls.length).toBe(0);
  expect(
    (await readBootstrapJob(env.DB, f.job.operation_id)).admission_authorized,
  ).toBe(0);
});

it("rejects a Node resourceVersion change during the two raw observations before R2 publication", async () => {
  const f = await fixture(),
    put = vi.spyOn(env.ARCHIVE, "put");
  (
    f.report.postjoin!.node_after.metadata as { resourceVersion: string }
  ).resourceVersion = "3";
  await expect(
    acceptNodeProofReport(f.bindings, f.session.bearer, f.report),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(put.mock.calls.length).toBe(0);
  expect(f.provider.mock.calls.length).toBe(0);
  expect(
    (await readBootstrapJob(env.DB, f.job.operation_id)).admission_authorized,
  ).toBe(0);
});

it("preserves the original release-intent resourceVersion when a newer valid postjoin proof arrives", async () => {
  const f = await fixture(),
    saved = {
      checkpoint_revision: 1,
      node_uid: f.nodeUid,
      resource_version: "1",
      kube_system_uid: f.clusterUid,
      quarantine: {
        key: "pgcf.io/quarantine",
        value: "bootstrap",
        effect: "NoSchedule",
      },
    };
  const checkpoint = NodeBootstrapCheckpoint.parse({
    ...f.checkpoint,
    stage: "quarantine_release_intent",
    status: "running",
    release_node_uid: f.nodeUid,
    release_resource_version: "1",
  });
  await env.DB.prepare(
    "UPDATE node_bootstrap_jobs SET checkpoint_json=?,admission_binding_json=? WHERE operation_id=?",
  )
    .bind(JSON.stringify(checkpoint), JSON.stringify(saved), f.job.operation_id)
    .run();
  const result = await acceptNodeProofReport(
    f.bindings,
    f.session.bearer,
    f.report,
  );
  expect(result.verified).toBe(true);
  const job = await readBootstrapJob(env.DB, f.job.operation_id);
  expect(JSON.parse(job.admission_binding_json!)).toEqual(saved);
  expect((await admissionAuthority(f.bindings, job)).admission_authorized).toBe(
    true,
  );
});

// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { X509Certificate, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BootstrapJob,
  canonical,
  digest,
  inputHash,
} from "../src/bootstrap.ts";
import {
  publishKubeletTrust,
  validateKubeletCertificate,
} from "../src/kubelet-trust.ts";
import { authority, fixture } from "./fixture.ts";

type Json = Record<string, unknown>;
const object = (value: unknown) => value as Json;

async function certificate(name: string) {
  const directory = await mkdtemp(join(tmpdir(), "pgcf-certificate-test-"));
  try {
    const output = join(directory, "serving-certificate.fixture");
    const result = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ed25519",
        "-nodes",
        "-keyout",
        join(directory, "generated-signing-material"),
        "-out",
        output,
        "-subj",
        `/CN=${name}`,
        "-addext",
        `subjectAltName=DNS:${name}`,
        "-days",
        "2",
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    assert.equal(
      result.status,
      0,
      "test serving certificate generation failed",
    );
    return await readFile(output, "utf8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function stateFixture() {
  const input = fixture();
  const nodeUid = randomUUID();
  const clusterUid = randomUUID();
  const systemUid = randomUUID();
  const pem = await certificate(input.spec.hostname);
  const node: Json = {
    apiVersion: "v1",
    kind: "Node",
    metadata: {
      name: input.spec.hostname,
      uid: nodeUid,
      resourceVersion: "41",
      labels: {
        "pgcf.io/node-id": input.spec.node_id,
        "pgcf.io/region": input.spec.region_id,
        "pgcf.io/provider-instance-id": input.spec.provider_instance_id,
      },
    },
    status: {
      addresses: [{ type: "InternalIP", address: input.spec.hardware.ipv4 }],
    },
  };
  let map: Json | null = null;
  let loseResponse = false;
  let replaceNode = false;
  let creates = 0;
  const reads: string[][] = [];
  const commands = {
    authorize: async () => clusterUid,
    talos: async (args: string[]) => {
      reads.push(args);
      if (replaceNode) object(node.metadata).uid = randomUUID();
      return { exit_code: 0, stdout: pem };
    },
    kube: async (args: string[], _permit_failure?: boolean, stdin?: string) => {
      if (args.includes("create")) {
        creates++;
        map = JSON.parse(stdin!) as Json;
        map.metadata = {
          ...object(map.metadata),
          uid: randomUUID(),
          resourceVersion: "1",
        };
        if (loseResponse) throw new Error("lost create response");
        return { exit_code: 0, stdout: JSON.stringify(map) };
      }
      if (args.includes("node"))
        return { exit_code: 0, stdout: JSON.stringify(node) };
      if (args.includes("namespace"))
        return {
          exit_code: 0,
          stdout: JSON.stringify({
            apiVersion: "v1",
            kind: "Namespace",
            metadata: {
              name: args[args.indexOf("namespace") + 1],
              uid: args.includes("kube-system") ? clusterUid : systemUid,
              resourceVersion: "1",
            },
          }),
        };
      return { exit_code: 0, stdout: map ? JSON.stringify(map) : "" };
    },
  };
  return {
    input,
    nodeUid,
    clusterUid,
    pem,
    node,
    commands,
    reads,
    map: () => map,
    creates: () => creates,
    loseResponse: () => {
      loseResponse = true;
    },
    replaceNode: () => {
      replaceNode = true;
    },
    setMap: (value: Json) => {
      map = value;
    },
  };
}

test("serving certificate validation binds the exact Node DNS SAN and preserves PEM bytes for hashing", async () => {
  const state = await stateFixture();
  const validated = validateKubeletCertificate(
    state.pem,
    state.input.spec.hostname,
    Date.now(),
  );
  assert.equal(validated.certificate_pem, state.pem);
  assert.equal(validated.certificate_sha256, digest(state.pem));
  const wrong = await certificate(`other-${randomUUID()}`);
  assert.throws(
    () =>
      validateKubeletCertificate(wrong, state.input.spec.hostname, Date.now()),
    /kubelet_certificate_identity_mismatch/,
  );
  assert.throws(
    () =>
      validateKubeletCertificate(
        state.pem,
        state.input.spec.hostname,
        Date.parse(new X509Certificate(state.pem).validTo) + 1,
      ),
    /kubelet_certificate_invalid/,
  );
  assert.throws(
    () =>
      validateKubeletCertificate(
        state.pem + ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
        state.input.spec.hostname,
        Date.now(),
      ),
    /kubelet_certificate_invalid/,
  );
  assert.throws(
    () =>
      validateKubeletCertificate(
        state.pem + "not-certificate",
        state.input.spec.hostname,
        Date.now(),
      ),
    /kubelet_certificate_invalid/,
  );
  assert.throws(
    () =>
      validateKubeletCertificate(
        state.pem.repeat(9),
        state.input.spec.hostname,
        Date.now(),
      ),
    /kubelet_certificate_invalid/,
  );
  assert.throws(
    () =>
      validateKubeletCertificate(
        state.pem + " ".repeat(16 * 1024),
        state.input.spec.hostname,
        Date.now(),
      ),
    /kubelet_certificate_invalid/,
  );
});

test("certificate-map creation uses only authenticated public Talos certificate read and resolves a lost create response", async () => {
  const state = await stateFixture();
  state.loseResponse();
  await publishKubeletTrust(state.input, state.commands);
  const map = state.map()!;
  assert.equal(object(map.metadata).name, `kubelet-${state.nodeUid}`);
  assert.equal(object(map.metadata).namespace, "pgcf-system");
  assert.equal(
    object(object(map.metadata).labels)["pgcf.io/kubelet-node-uid"],
    state.nodeUid,
  );
  assert.equal(
    object(object(map.metadata).labels)["pgcf.io/kubelet-cluster-uid"],
    state.clusterUid,
  );
  assert.equal(
    object(object(map.metadata).annotations)["pgcf.io/bootstrap-input"],
    state.input.input_hash,
  );
  assert.deepEqual(map.data, {
    node_name: state.input.spec.hostname,
    node_uid: state.nodeUid,
    cluster_uid: state.clusterUid,
    certificate_pem: state.pem,
    certificate_sha256: digest(state.pem),
  });
  assert.deepEqual(state.reads, [["read", "/var/lib/kubelet/pki/kubelet.crt"]]);
  await publishKubeletTrust(state.input, state.commands);
  assert.equal(state.creates(), 1);
});

test("an unrelated certificate map or changed owned certificate is never overwritten", async () => {
  const state = await stateFixture();
  await publishKubeletTrust(state.input, state.commands);
  const map = structuredClone(state.map()!);
  object(object(map.metadata).annotations)["pgcf.io/bootstrap-input"] =
    digest(randomUUID());
  state.setMap(map);
  await assert.rejects(
    publishKubeletTrust(state.input, state.commands),
    /kubelet_trust_map_mismatch/,
  );
  assert.equal(state.creates(), 1);
  object(object(map.metadata).annotations)["pgcf.io/bootstrap-input"] =
    state.input.input_hash;
  object(map.data).certificate_sha256 = digest(randomUUID());
  await assert.rejects(
    publishKubeletTrust(state.input, state.commands),
    /kubelet_trust_map_mismatch/,
  );
  assert.equal(state.creates(), 1);
});

test("fresh cluster and Node identity checks fence certificate-map creation", async () => {
  const state = await stateFixture();
  state.replaceNode();
  await assert.rejects(
    publishKubeletTrust(state.input, state.commands),
    /kubelet_trust_identity_changed/,
  );
  assert.equal(state.creates(), 0);
  const clean = await stateFixture();
  await assert.rejects(
    publishKubeletTrust(clean.input, {
      ...clean.commands,
      authorize: async () => randomUUID(),
    }),
    /cluster_uid_mismatch/,
  );
  assert.equal(clean.creates(), 0);
});

test("a joining worker publishes its map from the sealed private join identity without reinstalling the platform", async () => {
  const state = await stateFixture();
  const bundle = {
    version: 1 as const,
    cluster_name: state.input.spec.cluster_name,
    cluster_endpoint: state.input.spec.cluster_endpoint,
    talos_version: "1.14.1" as const,
    kubernetes_version: "1.36.3" as const,
    talos_machine_secrets_yaml: randomUUID(),
    talos_admin_config: randomUUID(),
    kubeconfig: randomUUID(),
    kube_system_uid: state.clusterUid,
  };
  const spec = {
    ...state.input.spec,
    role: "worker" as const,
    cluster_uid: state.clusterUid,
    join_bundle_sha256: digest(canonical(bundle)),
  };
  const input = {
    ...state.input,
    spec,
    input_hash: inputHash(spec),
    join_bundle: bundle,
  };
  const current = authority(input);
  const job = new BootstrapJob(input, {
    request: async () => Response.json(current),
    run: async (command) =>
      command.executable === "talosctl"
        ? state.commands.talos(command.args.slice(command.args.indexOf("read")))
        : state.commands.kube(command.args, false, command.stdin),
  });
  await Reflect.get(job, "installPlatform").call(job);
  assert.equal(state.reads.length, 0);
  await Reflect.get(job, "publishKubeletTrust").call(job);
  assert.equal(state.creates(), 1);
  assert.equal(
    object(object(state.map()!.metadata).annotations)[
      "pgcf.io/bootstrap-input"
    ],
    input.input_hash,
  );
});

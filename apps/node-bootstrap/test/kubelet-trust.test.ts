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
  refreshKubeletTrust,
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
  let servingPem = pem;
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
      nodeInfo: { systemUUID: randomUUID(), bootID: randomUUID() },
    },
  };
  let map: Json | null = null;
  let loseResponse = false;
  let replaceNode = false;
  let creates = 0;
  let replaces = 0;
  let loseReplaceResponse = false;
  let createArgs: string[] = [];
  const reads: string[][] = [];
  const commands = {
    authorize: async () => clusterUid,
    talos: async (args: string[]) => {
      reads.push(args);
      if (replaceNode) object(node.metadata).uid = randomUUID();
      return { exit_code: 0, stdout: servingPem };
    },
    kube: async (args: string[], _permit_failure?: boolean, stdin?: string) => {
      if (args.includes("replace")) {
        replaces++;
        const wanted = JSON.parse(stdin!) as Json;
        assert.equal(object(wanted.metadata).uid, object(map!.metadata).uid);
        assert.equal(
          object(wanted.metadata).resourceVersion,
          object(map!.metadata).resourceVersion,
        );
        map = wanted;
        object(map.metadata).resourceVersion = String(
          Number(object(map.metadata).resourceVersion) + 1,
        );
        if (loseReplaceResponse) throw new Error("lost replace response");
        return { exit_code: 0, stdout: JSON.stringify(map) };
      }
      if (args.includes("create")) {
        createArgs = args;
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
    replaces: () => replaces,
    createArgs: () => createArgs,
    loseResponse: () => {
      loseResponse = true;
    },
    replaceNode: () => {
      replaceNode = true;
    },
    setMap: (value: Json) => {
      map = value;
    },
    setServingPem: (value: string) => {
      servingPem = value;
    },
    loseReplaceResponse: () => {
      loseReplaceResponse = true;
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

test("a supported lifecycle refresh replaces only the serving certificate on the same physical Node and resolves a lost replacement", async () => {
  const state = await stateFixture();
  await publishKubeletTrust(state.input, state.commands);
  const previous = structuredClone(state.map()!);
  const next = await certificate(state.input.spec.hostname);
  state.setServingPem(next);
  state.loseReplaceResponse();
  await publishKubeletTrust(state.input, state.commands, {
    node_uid: state.nodeUid,
    cluster_uid: state.clusterUid,
  });
  assert.equal(state.creates(), 1);
  assert.equal(state.replaces(), 1);
  assert.equal(object(state.map()!.data).certificate_pem, next);
  assert.equal(object(state.map()!.data).certificate_sha256, digest(next));
  assert.equal(
    object(state.map()!.metadata).uid,
    object(previous.metadata).uid,
  );
  assert.deepEqual(
    object(state.map()!.metadata).annotations,
    object(previous.metadata).annotations,
  );
  await publishKubeletTrust(state.input, state.commands, {
    node_uid: state.nodeUid,
    cluster_uid: state.clusterUid,
  });
  assert.equal(state.replaces(), 1);
});

test("hardware UUID casing remains the same identity across serving-pin refresh while a genuine boot change stays fenced", async () => {
  const state = await stateFixture();
  await publishKubeletTrust(state.input, state.commands);
  const physical = object(object(state.node.status).nodeInfo);
  physical.systemUUID = String(physical.systemUUID).toUpperCase();
  physical.bootID = String(physical.bootID).toUpperCase();
  state.setServingPem(await certificate(state.input.spec.hostname));
  const binding = { node_uid: state.nodeUid, cluster_uid: state.clusterUid };
  await publishKubeletTrust(
    state.input,
    {
      ...state.commands,
      talos: async (args) => {
        const result = await state.commands.talos(args);
        physical.systemUUID = String(physical.systemUUID).toLowerCase();
        physical.bootID = String(physical.bootID).toLowerCase();
        return result;
      },
    },
    binding,
  );
  assert.equal(state.replaces(), 1);
  await assert.rejects(
    publishKubeletTrust(
      state.input,
      {
        ...state.commands,
        talos: async (args) => {
          const result = await state.commands.talos(args);
          physical.bootID = randomUUID().toUpperCase();
          return result;
        },
      },
      binding,
    ),
    /kubelet_trust_identity_changed/,
  );
  assert.equal(state.replaces(), 1);
});

test("the fleet boundary refresh retains bootstrap ownership and refuses a changed Node, boot or certificate-map UID", async () => {
  const state = await stateFixture();
  await publishKubeletTrust(state.input, state.commands);
  const subject = {
    status: {
      node_id: state.input.spec.node_id,
      region_id: state.input.spec.region_id,
      node_uid: state.nodeUid,
      cluster_uid: state.clusterUid,
    },
    k8s_node_name: state.input.spec.hostname,
    address: state.input.spec.hardware.ipv4,
  };
  await refreshKubeletTrust(subject, state.commands);
  assert.equal(state.replaces(), 0); // EU's unchanged leaf stays untouched.
  state.setServingPem(await certificate(state.input.spec.hostname));
  await refreshKubeletTrust(subject, state.commands);
  assert.equal(state.replaces(), 1);
  await assert.rejects(
    refreshKubeletTrust(
      { ...subject, status: { ...subject.status, node_uid: randomUUID() } },
      state.commands,
    ),
    /kubelet_trust_identity_changed/,
  );
  state.setServingPem(await certificate(state.input.spec.hostname));
  await assert.rejects(
    refreshKubeletTrust(subject, {
      ...state.commands,
      talos: async (args) => {
        const result = await state.commands.talos(args);
        object(object(state.node.status).nodeInfo).bootID = randomUUID();
        return result;
      },
    }),
    /kubelet_trust_identity_changed/,
  );
  assert.equal(state.replaces(), 1);
  await assert.rejects(
    refreshKubeletTrust(subject, {
      ...state.commands,
      kube: async (args, permit, stdin) => {
        const result = await state.commands.kube(args, permit, stdin);
        if (args.includes("replace"))
          object(state.map()!.metadata).uid = randomUUID();
        return result;
      },
    }),
    /kubelet_trust_refresh_unconfirmed/,
  );
});

test("an uncommitted conditional replacement is resolved by readback without blind write repetition", async () => {
  const state = await stateFixture();
  await publishKubeletTrust(state.input, state.commands);
  state.setServingPem(await certificate(state.input.spec.hostname));
  let attempts = 0;
  await assert.rejects(
    publishKubeletTrust(
      state.input,
      {
        ...state.commands,
        kube: async (args, permit, stdin) => {
          if (args.includes("replace")) {
            attempts++;
            throw new Error("unknown replacement response");
          }
          return state.commands.kube(args, permit, stdin);
        },
      },
      { node_uid: state.nodeUid, cluster_uid: state.clusterUid },
    ),
    /kubelet_trust_map_mismatch/,
  );
  assert.equal(attempts, 1);
  assert.equal(state.replaces(), 0);
  assert.equal(object(state.map()!.data).certificate_pem, state.pem);
});

test("certificate-map creation uses only authenticated public Talos certificate read and resolves a lost create response", async () => {
  const state = await stateFixture();
  state.loseResponse();
  await publishKubeletTrust(state.input, state.commands);
  assert.ok(state.createArgs().includes("--filename=-"));
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
    kubernetes_version: "1.36.5" as const,
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

// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  buildPhase,
  configurationEqual,
  configurationHash,
  REGION_AUTHORITY_PHASES,
  parseAuthorityPEMEnvelope,
  type AuthorityDocuments,
} from "../src/region-authority-phases.ts";

test("one PEM envelope parser retains Talos labels and rejects mismatched envelopes", () => {
  const key = generateKeyPairSync("ed25519")
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString(),
    talos = key.replaceAll("PRIVATE KEY", "ED25519 PRIVATE KEY"),
    standard = parseAuthorityPEMEnvelope(key),
    parsed = parseAuthorityPEMEnvelope(talos);
  assert.equal(standard?.label, "PRIVATE KEY");
  assert.equal(parsed?.label, "ED25519 PRIVATE KEY");
  assert.equal(parsed?.body, standard?.body);
  assert.equal(
    parseAuthorityPEMEnvelope(talos.replace("END ED25519", "END RSA")),
    undefined,
  );
});

function tokenDocuments(token: string) {
  return [
    {
      version: "v1alpha1",
      machine: { type: "controlplane", token, hostname: "retained-node" },
      cluster: { token: "unchanged-bootstrap-token" },
    },
    { kind: "DiscoveryIdentityConfig", clusterID: "arbitrary-cluster-id" },
    {
      kind: "KubeClusterConfig",
      endpoint: "https://cluster.example:6443",
      clusterName: "arbitrary-cluster-name",
    },
    { kind: "KernelModuleConfig", name: "dm_thin_pool" },
  ];
}

test("a prepared token phase preserves an arbitrary existing document count and cluster identity", () => {
  const old = tokenDocuments("prepared-old-token"),
    next = tokenDocuments("prepared-new-token"),
    actual = structuredClone(old);
  const result = buildPhase(actual, old, next, "trustd-token");
  assert.equal(result.documents.length, actual.length);
  assert.deepEqual(result.documents, next);
  assert.deepEqual(actual, old);
});

// Public, throwaway test authorities constructed in memory; no custody is read or written.
function der(tag: number, ...contents: Buffer[]) {
  const bytes = Buffer.concat(contents),
    length =
      bytes.length < 128
        ? Buffer.from([bytes.length])
        : bytes.length < 256
          ? Buffer.from([0x81, bytes.length])
          : Buffer.from([0x82, bytes.length >> 8, bytes.length & 255]);
  return Buffer.concat([Buffer.from([tag]), length, bytes]);
}
function testAuthority() {
  const pair = generateKeyPairSync("ed25519"),
    algorithm = Buffer.from("300506032b6570", "hex"),
    name = der(
      0x30,
      der(
        0x31,
        der(
          0x30,
          Buffer.from("0603550403", "hex"),
          der(0x0c, Buffer.from("test-only")),
        ),
      ),
    ),
    tbs = der(
      0x30,
      der(0xa0, der(0x02, Buffer.from([2]))),
      der(0x02, Buffer.from([1])),
      algorithm,
      name,
      der(
        0x30,
        der(0x17, Buffer.from("240101000000Z")),
        der(0x17, Buffer.from("491231235959Z")),
      ),
      name,
      pair.publicKey.export({ type: "spki", format: "der" }),
    ),
    bytes = der(
      0x30,
      tbs,
      algorithm,
      der(0x03, Buffer.from([0]), sign(null, tbs, pair.privateKey)),
    ),
    cert = `-----BEGIN CERTIFICATE-----\n${bytes
      .toString("base64")
      .match(/.{1,64}/g)!
      .join("\n")}\n-----END CERTIFICATE-----\n`,
    key = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey = pair.publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
  return {
    cert,
    key,
    publicKey,
    encoded: {
      crt: Buffer.from(cert).toString("base64"),
      key: Buffer.from(key).toString("base64"),
    },
  };
}
function preparedDocuments(role: "controlplane" | "worker") {
  const before = testAuthority(),
    after = testAuthority();
  function docs(
    authority: typeof before,
    newMaterial: boolean,
  ): AuthorityDocuments {
    const documents: AuthorityDocuments = [
      {
        version: "v1alpha1",
        machine: {
          type: role,
          ca:
            role === "controlplane"
              ? authority.encoded
              : { crt: authority.encoded.crt, key: "" },
          token: newMaterial ? "new-trustd" : "old-trustd",
          install: { disk: "/dev/test-retained-disk", wipe: false },
          network: {
            hostname: "retained-node",
            interfaces: [{ interface: "eth0", dhcp: true }],
          },
        },
        cluster: {
          token: newMaterial ? "new-bootstrap" : "old-bootstrap",
          ...(role === "controlplane"
            ? {
                etcd: {
                  ca: authority.encoded,
                  advertisedSubnets: ["192.0.2.0/24"],
                },
              }
            : {}),
        },
      },
      {
        kind: "DiscoveryIdentityConfig",
        clusterID: "unrelated-cluster-id",
        clusterSecret: newMaterial ? "new-discovery" : "old-discovery",
      },
      {
        kind: "KubeClusterConfig",
        endpoint: "https://retained.example:6443",
        clusterName: "retained",
      },
      {
        kind: "KubeAPIServerCAConfig",
        ...(role === "controlplane"
          ? {
              issuingCA: { cert: authority.cert, key: authority.key },
              unrelatedSetting: "preserved",
            }
          : { acceptedCAs: [authority.cert] }),
      },
      {
        kind: "UnrelatedConfiguration",
        name: "arbitrary-document-id",
        values: [1, 2, 3],
        options: { preserve: true },
      },
    ];
    if (role === "controlplane")
      documents.push(
        {
          kind: "KubeAggregatorCAConfig",
          issuingCA: { cert: authority.cert, key: authority.key },
        },
        {
          kind: "KubeServiceAccountConfig",
          issuer: {
            privateKey: authority.key,
            issuerURL: "https://kubernetes.default.svc",
          },
          accepted: {
            publicKeys: [authority.publicKey],
            unrelatedSetting: "preserved",
          },
        },
        {
          kind: "KubeEtcdEncryptionConfig",
          config: {
            resources: [
              { resources: ["configmaps"], providers: [{ identity: {} }] },
              {
                resources: ["secrets"],
                providers: [
                  {
                    secretbox: {
                      keys: [
                        {
                          name: newMaterial
                            ? "operator-canonical-name"
                            : "old-canonical-name",
                          secret: Buffer.alloc(
                            32,
                            newMaterial ? 2 : 1,
                          ).toString("base64"),
                        },
                      ],
                    },
                  },
                  { identity: {} },
                ],
              },
            ],
          },
        },
      );
    return documents;
  }
  return { old: docs(before, false), next: docs(after, true), before, after };
}
function document(documents: AuthorityDocuments, kind: string) {
  return documents.find((doc) => doc.kind === kind)!;
}
function legacy(documents: AuthorityDocuments) {
  return documents.find((doc) => doc.version === "v1alpha1")!;
}
function machine(documents: AuthorityDocuments) {
  return legacy(documents).machine as Record<string, unknown>;
}

test("the rehearsed 22-phase control-plane sequence uses prepared material and preserves every unselected field", () => {
  const { old, next } = preparedDocuments("controlplane"),
    preservedOld = structuredClone(old),
    preservedNext = structuredClone(next);
  let actual = structuredClone(old);
  assert.equal(REGION_AUTHORITY_PHASES.length, 22);
  for (const phase of REGION_AUTHORITY_PHASES) {
    const result = buildPhase(actual, old, next, phase);
    assert.equal(result.unselected_fields_preserved, true);
    assert.equal(result.documents.length, old.length);
    assert.deepEqual(
      document(result.documents, "UnrelatedConfiguration"),
      document(old, "UnrelatedConfiguration"),
    );
    assert.deepEqual(machine(result.documents).network, machine(old).network);
    assert.deepEqual(machine(result.documents).install, machine(old).install);
    assert.deepEqual(
      buildPhase(result.documents, old, next, phase).documents,
      result.documents,
    );
    actual = result.documents;
  }
  assert.equal(configurationEqual(actual, next), true);
  assert.deepEqual(old, preservedOld);
  assert.deepEqual(next, preservedNext);
});

test("a worker selects new Kubernetes trust without receiving control-plane authority", () => {
  const { old, next, before, after } = preparedDocuments("worker");
  let actual = structuredClone(old);
  for (const phase of REGION_AUTHORITY_PHASES) {
    const result = buildPhase(actual, old, next, phase);
    if (phase === "kubernetes-trust") {
      assert.deepEqual(
        document(result.documents, "KubeAPIServerCAConfig").acceptedCAs,
        [before.cert, after.cert],
      );
      assert.throws(
        () => buildPhase(result.documents, old, next, "kubernetes-retire"),
        /authority_kube_new_issuer_missing/,
      );
    }
    if (phase === "kubernetes-issue")
      assert.deepEqual(
        document(result.documents, "KubeAPIServerCAConfig").acceptedCAs,
        [after.cert, before.cert],
      );
    if (
      phase.startsWith("aggregator-") ||
      phase.startsWith("service-account-") ||
      phase.startsWith("encryption-") ||
      phase === "etcd-ca"
    ) {
      assert.deepEqual(result.documents, actual);
      assert.deepEqual(result.changed_paths, []);
    }
    assert.equal(
      (machine(result.documents).ca as Record<string, unknown>).key,
      "",
    );
    assert.equal(
      document(result.documents, "KubeAPIServerCAConfig").issuingCA,
      undefined,
    );
    actual = result.documents;
  }
  assert.equal(configurationEqual(actual, next), true);
});

test("semantic readback accepts certificate/key formatting and issuer normalization but keeps worker CA selection and unrelated values", () => {
  const { old } = preparedDocuments("controlplane"),
    normalized = structuredClone(old),
    ca = document(normalized, "KubeAPIServerCAConfig"),
    issuer = ca.issuingCA as Record<string, string>;
  ca.acceptedCAs = [issuer.cert, issuer.cert!.replace(/\n/g, "\r\n")];
  issuer.key = issuer
    .key!.replace("BEGIN PRIVATE KEY", "BEGIN ED25519 PRIVATE KEY")
    .replace("END PRIVATE KEY", "END ED25519 PRIVATE KEY");
  machine(normalized).acceptedCAs = [];
  assert.equal(configurationEqual(old, normalized), true);
  assert.equal(configurationHash(old), configurationHash(normalized));
  const implicitSigner = structuredClone(old);
  delete (
    document(implicitSigner, "KubeServiceAccountConfig").accepted as Record<
      string,
      unknown
    >
  ).publicKeys;
  assert.equal(configurationEqual(old, implicitSigner), true);
  assert.equal(configurationHash(old), configurationHash(implicitSigner));
  document(normalized, "UnrelatedConfiguration").options = { preserve: false };
  assert.equal(configurationEqual(old, normalized), false);
  assert.notEqual(configurationHash(old), configurationHash(normalized));
  const worker = preparedDocuments("worker"),
    trusted = buildPhase(
      worker.old,
      worker.old,
      worker.next,
      "kubernetes-trust",
    ).documents,
    reordered = structuredClone(trusted);
  document(reordered, "KubeAPIServerCAConfig").acceptedCAs = [
    worker.after.cert,
    worker.before.cert,
  ];
  assert.equal(configurationEqual(trusted, reordered), false);
});

test("prepared authority rejects identity changes, unchanged material, missing trust, and mismatched key pairs without leaking values", () => {
  const { old, next, before } = preparedDocuments("controlplane"),
    changedIdentity = structuredClone(next);
  document(changedIdentity, "DiscoveryIdentityConfig").clusterID = "different";
  assert.throws(
    () => buildPhase(old, old, changedIdentity, "trustd-token"),
    /authority_cluster_identity_changed/,
  );
  assert.throws(
    () => buildPhase(old, old, old, "trustd-token"),
    /authority_token_state/,
  );
  assert.throws(
    () => buildPhase(old, old, old, "discovery-secret"),
    /authority_discovery_state/,
  );
  assert.throws(
    () => buildPhase(old, old, old, "encryption-decrypt"),
    /authority_encryption_persisted_material/,
  );
  assert.throws(
    () => buildPhase(old, old, old, "talos-trust"),
    /authority_talos_issuer_state/,
  );
  assert.throws(
    () => buildPhase(old, old, next, "talos-issue"),
    /authority_talos_new_trust_missing/,
  );
  assert.throws(
    () => buildPhase(old, old, next, "kubernetes-issue"),
    /authority_kube_new_trust_missing/,
  );
  assert.throws(
    () => buildPhase(old, old, next, "service-account-issue"),
    /authority_service_account_new_trust_missing/,
  );
  const mismatched = structuredClone(next);
  (machine(mismatched).ca as Record<string, unknown>).key = before.encoded.key;
  assert.throws(
    () => buildPhase(old, old, mismatched, "talos-trust"),
    (error: unknown) =>
      error instanceof Error && error.message === "authority_ca_key_mismatch",
  );
});

test("worker input cannot carry an issuing private authority even in an otherwise no-op phase", () => {
  const { old, next, before } = preparedDocuments("worker");
  document(old, "KubeAPIServerCAConfig").issuingCA = {
    cert: before.cert,
    key: before.key,
  };
  assert.throws(
    () => buildPhase(old, old, next, "aggregator-trust"),
    /authority_worker_private_authority/,
  );
});

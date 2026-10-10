// SPDX-License-Identifier: Apache-2.0
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  X509Certificate,
} from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  REGION_AUTHORITY_PHASES,
  type RegionAuthorityPhase,
} from "@pgcf/contracts/region-material-rotation";
export { REGION_AUTHORITY_PHASES, type RegionAuthorityPhase };
export type AuthorityDocuments = Record<string, unknown>[];
type ObjectValue = Record<string, unknown>;
type Field = string | number;

function fail(code: string): never {
  // Do not include configuration values or crypto-library errors in diagnostics.
  throw new Error(`authority_${code}`);
}
function isObject(value: unknown): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function object(value: unknown): ObjectValue {
  if (!isObject(value)) fail("configuration_shape");
  return value;
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value.length) fail("configuration_shape");
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) fail("configuration_shape");
  return value;
}
function at(root: unknown, ...fields: string[]): unknown {
  let value = root;
  for (const field of fields) value = object(value)[field];
  return value;
}
function optionalArray(value: unknown): unknown[] {
  return value === undefined ? [] : array(value);
}
function one(documents: AuthorityDocuments, kind: string): ObjectValue {
  if (!documents.length || documents.some((doc) => !isObject(doc)))
    fail("documents_shape");
  const matches = documents.filter((document) =>
    kind === "legacy"
      ? document.version === "v1alpha1" &&
        isObject(document.machine) &&
        !document.kind
      : document.kind === kind,
  );
  if (matches.length !== 1) fail(`document_count_${kind}`);
  return matches[0]!;
}
function identity(documents: AuthorityDocuments) {
  const legacy = one(documents, "legacy"),
    discovery = one(documents, "DiscoveryIdentityConfig"),
    cluster = one(documents, "KubeClusterConfig"),
    role = at(legacy, "machine", "type");
  if (role !== "controlplane" && role !== "worker") fail("machine_role");
  return {
    clusterID: string(discovery.clusterID),
    endpoint: string(cluster.endpoint),
    clusterName: cluster.clusterName,
    role,
  };
}
function sha(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function decoded(value: unknown): string {
  const encoded = string(value);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) fail("encoded_material");
  return Buffer.from(encoded, "base64").toString("utf8");
}
function certificate(value: unknown): X509Certificate {
  try {
    return new X509Certificate(string(value));
  } catch {
    fail("certificate_invalid");
  }
}
function certificateID(value: unknown): string {
  return sha(certificate(value).raw);
}
export function parseAuthorityPEMEnvelope(value: string) {
  const match =
    /^-{5}BEGIN ([A-Z0-9 ]+)-{5}\s*([A-Za-z0-9+/=\s]+)-{5}END \1-{5}\s*$/.exec(
      value,
    );
  return match
    ? { label: match[1]!, body: match[2]!.replace(/\s/g, "") }
    : undefined;
}
function privateKey(value: unknown) {
  const pem = string(value);
  try {
    // Talos's Ed25519 PKCS8 encoding uses this upstream-specific PEM label.
    const envelope = parseAuthorityPEMEnvelope(pem);
    if (envelope?.label === "ED25519 PRIVATE KEY") {
      const key = createPrivateKey({
        key: Buffer.from(envelope.body, "base64"),
        format: "der",
        type: "pkcs8",
      });
      if (key.asymmetricKeyType !== "ed25519") fail("private_key_invalid");
      return key;
    }
    return createPrivateKey(pem);
  } catch {
    fail("private_key_invalid");
  }
}
function publicKey(value: unknown) {
  const pem = string(value);
  try {
    return createPublicKey(
      parseAuthorityPEMEnvelope(pem)?.label === "ED25519 PRIVATE KEY"
        ? privateKey(pem)
        : pem,
    );
  } catch {
    fail("public_key_invalid");
  }
}
function publicKeyID(value: unknown): string {
  return sha(publicKey(value).export({ type: "spki", format: "der" }));
}
function publicPEM(value: unknown): string {
  return publicKey(value).export({ type: "spki", format: "pem" }).toString();
}
function encodedCAID(value: unknown): string {
  return certificateID(decoded(object(value).crt));
}
function validateCA(value: unknown, encoded: boolean, issuing: boolean) {
  const ca = object(value),
    cert = certificate(encoded ? decoded(ca.crt) : ca.cert),
    key = encoded ? ca.key && decoded(ca.key) : ca.key;
  if (issuing) {
    if (!cert.checkPrivateKey(privateKey(key))) fail("ca_key_mismatch");
  } else if (key !== undefined && key !== "") fail("worker_private_authority");
  return sha(cert.raw);
}
function unique<T>(values: T[], id: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = id(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function changed(before: unknown, after: unknown, prefix: string): string[] {
  if (isDeepStrictEqual(before, after)) return [];
  if (isObject(before) && isObject(after))
    return [
      ...new Set([...Object.keys(before), ...Object.keys(after)]),
    ].flatMap((key) => changed(before[key], after[key], `${prefix}/${key}`));
  return [prefix];
}
function encryptionSlot(documents: AuthorityDocuments) {
  const doc = one(documents, "KubeEtcdEncryptionConfig"),
    resources = array(at(doc, "config", "resources"));
  const slots = resources.flatMap((resource, ri) => {
    const value = object(resource);
    if (!array(value.resources).includes("secrets")) return [];
    return array(value.providers).flatMap((provider, pi) => {
      const secretbox = object(provider).secretbox;
      if (secretbox === undefined) return [];
      const keys = array(object(secretbox).keys).map((key) => {
        const value = object(key),
          name = string(value.name),
          secret = string(value.secret);
        if (!/^[A-Za-z0-9+/]{43}=$/.test(secret)) fail("secretbox_key_shape");
        return { ...value, name, secret };
      });
      if (
        !keys.length ||
        new Set(keys.map((key) => key.name)).size !== keys.length
      )
        fail("secretbox_key_shape");
      return [{ doc, ri, pi, keys }];
    });
  });
  if (slots.length !== 1) fail("secretbox_provider_count");
  return slots[0]!;
}
function normalize(documents: AuthorityDocuments): AuthorityDocuments {
  const result = structuredClone(documents);
  for (const doc of result) {
    if (
      doc.kind === "KubeAPIServerCAConfig" ||
      doc.kind === "KubeAggregatorCAConfig"
    ) {
      const issuer =
          doc.issuingCA === undefined ? undefined : object(doc.issuingCA),
        accepted = optionalArray(doc.acceptedCAs),
        first =
          !issuer && doc.kind === "KubeAPIServerCAConfig" && accepted.length
            ? certificateID(accepted[0])
            : undefined;
      const normalized = [
        ...new Set(
          [...accepted, ...(issuer ? [issuer.cert] : [])].map(certificateID),
        ),
      ].sort();
      // Workers select the server CA with the first entry; this order is meaningful.
      doc.acceptedCAs = first
        ? [first, ...normalized.filter((id) => id !== first)]
        : normalized;
      if (issuer)
        doc.issuingCA = {
          ...issuer,
          cert: certificateID(issuer.cert),
          key: publicKeyID(issuer.key),
        };
    }
    if (doc.kind === "KubeServiceAccountConfig") {
      const issuer = object(doc.issuer),
        issuerID = publicKeyID(issuer.privateKey);
      issuer.privateKey = issuerID;
      const accepted = doc.accepted === undefined ? {} : object(doc.accepted);
      const keys = [
        // Talos AcceptedKeys prepends the issuer's public key implicitly.
        ...new Set([
          ...optionalArray(accepted.publicKeys).map(publicKeyID),
          issuerID,
        ]),
      ].sort();
      if (keys.length) accepted.publicKeys = keys;
      else delete accepted.publicKeys;
      if (Object.keys(accepted).length) doc.accepted = accepted;
      else delete doc.accepted;
    }
    if (isObject(doc.machine)) {
      const machine = doc.machine,
        accepted = optionalArray(machine.acceptedCAs);
      if (accepted.length)
        machine.acceptedCAs = [...new Set(accepted.map(encodedCAID))].sort();
      else delete machine.acceptedCAs;
      const normalizedCA = (ca: unknown) => {
        const value = object(ca);
        return {
          ...value,
          crt: certificateID(decoded(value.crt)),
          ...(value.key === undefined || value.key === ""
            ? {}
            : { key: publicKeyID(decoded(value.key)) }),
        };
      };
      if (machine.ca !== undefined) machine.ca = normalizedCA(machine.ca);
      if (
        isObject(doc.cluster) &&
        isObject(doc.cluster.etcd) &&
        doc.cluster.etcd.ca !== undefined
      )
        doc.cluster.etcd.ca = normalizedCA(doc.cluster.etcd.ca);
    }
  }
  return result;
}

/** Compare Talos readbacks semantically without ignoring unrelated fields. */
export function configurationEqual(
  before: AuthorityDocuments,
  after: AuthorityDocuments,
): boolean {
  return isDeepStrictEqual(normalize(before), normalize(after));
}

/** Stable semantic binding for persisted candidates and uncertain-write readbacks. */
export function configurationHash(documents: AuthorityDocuments): string {
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (isObject(value))
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .filter((key) => value[key] !== undefined)
          .map((key) => [key, canonical(value[key])]),
      );
    return value;
  }
  return sha(JSON.stringify(canonical(normalize(documents))));
}

/** Rehearsed field substitutions using prepared material; no keys or I/O are created. */
export function buildPhase(
  actual: AuthorityDocuments,
  old: AuthorityDocuments,
  next: AuthorityDocuments,
  phase: RegionAuthorityPhase,
) {
  if (!(REGION_AUTHORITY_PHASES as readonly string[]).includes(phase))
    fail("unknown_phase");
  const stable = identity(actual),
    role = stable.role;
  if (
    !isDeepStrictEqual(stable, identity(old)) ||
    !isDeepStrictEqual(stable, identity(next))
  )
    fail("cluster_identity_changed");
  const documents = structuredClone(actual),
    permitted: Field[][] = [],
    legacy = one(documents, "legacy"),
    oldLegacy = one(old, "legacy"),
    newLegacy = one(next, "legacy");
  const set = (doc: ObjectValue, fields: Field[], value: unknown) => {
    const index = documents.indexOf(doc);
    if (index < 0) fail("selected_document");
    let current: ObjectValue | unknown[] = doc;
    for (const field of fields.slice(0, -1)) {
      const entry = (current as ObjectValue)[field];
      if (!isObject(entry) && !Array.isArray(entry))
        (current as ObjectValue)[field] = {};
      current = (current as ObjectValue)[field] as ObjectValue | unknown[];
    }
    (current as ObjectValue)[fields.at(-1)!] = structuredClone(value);
    permitted.push([index, ...fields]);
  };
  if (role === "worker") {
    for (const docs of [actual, old, next]) {
      const machine = object(one(docs, "legacy").machine);
      if (
        isObject(machine.ca) &&
        machine.ca.key !== undefined &&
        machine.ca.key !== ""
      )
        fail("worker_private_authority");
      for (const doc of docs)
        if (
          (doc.kind === "KubeAPIServerCAConfig" ||
            doc.kind === "KubeAggregatorCAConfig") &&
          doc.issuingCA !== undefined
        )
          fail("worker_private_authority");
    }
  }
  if (phase.startsWith("talos-")) {
    const oldCA = at(oldLegacy, "machine", "ca"),
      newCA = at(newLegacy, "machine", "ca"),
      currentCA = at(legacy, "machine", "ca"),
      oldID = validateCA(oldCA, true, role === "controlplane"),
      newID = validateCA(newCA, true, role === "controlplane"),
      current = validateCA(currentCA, true, role === "controlplane"),
      accepted = optionalArray(at(legacy, "machine", "acceptedCAs"));
    if (oldID === newID || ![oldID, newID].includes(current))
      fail("talos_issuer_state");
    if (phase === "talos-trust")
      set(
        legacy,
        ["machine", "acceptedCAs"],
        unique([...accepted, { crt: object(newCA).crt }], encodedCAID),
      );
    if (phase === "talos-issue") {
      if (
        current !== newID &&
        !accepted.some((ca) => encodedCAID(ca) === newID)
      )
        fail("talos_new_trust_missing");
      set(legacy, ["machine", "ca"], newCA);
      set(
        legacy,
        ["machine", "acceptedCAs"],
        unique(
          [
            ...accepted.filter((ca) => encodedCAID(ca) !== newID),
            { crt: object(oldCA).crt },
          ],
          encodedCAID,
        ),
      );
    }
    if (phase === "talos-retire") {
      if (current !== newID) fail("talos_new_issuer_missing");
      set(
        legacy,
        ["machine", "acceptedCAs"],
        accepted.filter((ca) => encodedCAID(ca) !== oldID),
      );
    }
  } else if (
    phase.startsWith("kubernetes-") ||
    (role === "controlplane" && phase.startsWith("aggregator-"))
  ) {
    const kind = phase.startsWith("kubernetes-")
        ? "KubeAPIServerCAConfig"
        : "KubeAggregatorCAConfig",
      doc = one(documents, kind),
      oldDoc = one(old, kind),
      newDoc = one(next, kind),
      oldAccepted = optionalArray(oldDoc.acceptedCAs),
      newAccepted = optionalArray(newDoc.acceptedCAs),
      oldCert =
        role === "controlplane"
          ? at(oldDoc, "issuingCA", "cert")
          : oldAccepted[0],
      newCert =
        role === "controlplane"
          ? at(newDoc, "issuingCA", "cert")
          : newAccepted[0],
      oldID = certificateID(oldCert),
      newID = certificateID(newCert),
      accepted = optionalArray(doc.acceptedCAs),
      current =
        role === "controlplane"
          ? validateCA(doc.issuingCA, false, true)
          : undefined;
    if (role === "controlplane") {
      validateCA(oldDoc.issuingCA, false, true);
      validateCA(newDoc.issuingCA, false, true);
    } else if (
      unique(oldAccepted, certificateID).length !== 1 ||
      unique(newAccepted, certificateID).length !== 1 ||
      !accepted.some((cert) => [oldID, newID].includes(certificateID(cert)))
    )
      fail("worker_kubernetes_trust_state");
    if (
      oldID === newID ||
      (current !== undefined && ![oldID, newID].includes(current))
    )
      fail("kube_issuer_state");
    if (phase.endsWith("-trust"))
      set(doc, ["acceptedCAs"], unique([...accepted, newCert], certificateID));
    if (phase.endsWith("-issue")) {
      if (
        current !== newID &&
        !accepted.some((cert) => certificateID(cert) === newID)
      )
        fail("kube_new_trust_missing");
      const retained = unique(
        [
          ...(kind === "KubeAPIServerCAConfig"
            ? accepted.filter((cert) => certificateID(cert) !== newID)
            : accepted),
          oldCert,
        ],
        certificateID,
      );
      if (role === "controlplane") {
        set(doc, ["issuingCA"], newDoc.issuingCA);
        set(doc, ["acceptedCAs"], retained);
      } else set(doc, ["acceptedCAs"], [newCert, ...retained]);
    }
    if (phase.endsWith("-retire")) {
      if (
        role === "controlplane"
          ? current !== newID
          : certificateID(accepted[0]) !== newID
      )
        fail("kube_new_issuer_missing");
      set(
        doc,
        ["acceptedCAs"],
        accepted.filter((cert) => certificateID(cert) !== oldID),
      );
    }
  } else if (role === "controlplane" && phase.startsWith("service-account-")) {
    const doc = one(documents, "KubeServiceAccountConfig"),
      oldDoc = one(old, "KubeServiceAccountConfig"),
      newDoc = one(next, "KubeServiceAccountConfig"),
      oldPub = publicPEM(at(oldDoc, "issuer", "privateKey")),
      newPub = publicPEM(at(newDoc, "issuer", "privateKey")),
      oldID = publicKeyID(oldPub),
      newID = publicKeyID(newPub),
      current = publicKeyID(at(doc, "issuer", "privateKey")),
      accepted = optionalArray(
        doc.accepted === undefined
          ? undefined
          : object(doc.accepted).publicKeys,
      );
    if (
      oldID === newID ||
      ![oldID, newID].includes(current) ||
      at(doc, "issuer", "issuerURL") !== at(oldDoc, "issuer", "issuerURL") ||
      at(newDoc, "issuer", "issuerURL") !== at(oldDoc, "issuer", "issuerURL")
    )
      fail("service_account_issuer_state");
    if (phase.endsWith("-trust"))
      set(
        doc,
        ["accepted", "publicKeys"],
        unique([...accepted, newPub], publicKeyID),
      );
    if (phase.endsWith("-issue")) {
      if (
        current !== newID &&
        !accepted.some((key) => publicKeyID(key) === newID)
      )
        fail("service_account_new_trust_missing");
      set(doc, ["issuer", "privateKey"], at(newDoc, "issuer", "privateKey"));
      set(
        doc,
        ["accepted", "publicKeys"],
        unique([...accepted, oldPub], publicKeyID),
      );
    }
    if (phase.endsWith("-retire")) {
      if (current !== newID) fail("service_account_new_issuer_missing");
      set(
        doc,
        ["accepted", "publicKeys"],
        accepted.filter((key) => publicKeyID(key) !== oldID),
      );
    }
  } else if (phase === "trustd-token" || phase === "bootstrap-token") {
    const field = phase === "trustd-token" ? "machine" : "cluster",
      oldToken = string(at(oldLegacy, field, "token")),
      newToken = string(at(newLegacy, field, "token"));
    if (
      oldToken === newToken ||
      ![oldToken, newToken].includes(string(at(legacy, field, "token")))
    )
      fail("token_state");
    set(legacy, [field, "token"], newToken);
  } else if (phase === "discovery-secret") {
    const doc = one(documents, "DiscoveryIdentityConfig"),
      oldSecret = string(one(old, "DiscoveryIdentityConfig").clusterSecret),
      newSecret = string(one(next, "DiscoveryIdentityConfig").clusterSecret);
    if (
      oldSecret === newSecret ||
      ![oldSecret, newSecret].includes(string(doc.clusterSecret))
    )
      fail("discovery_state");
    set(doc, ["clusterSecret"], newSecret);
  } else if (role === "controlplane" && phase === "etcd-ca") {
    const oldCA = at(oldLegacy, "cluster", "etcd", "ca"),
      newCA = at(newLegacy, "cluster", "etcd", "ca"),
      currentCA = at(legacy, "cluster", "etcd", "ca"),
      oldID = validateCA(oldCA, true, true),
      newID = validateCA(newCA, true, true),
      current = validateCA(currentCA, true, true);
    if (oldID === newID || ![oldID, newID].includes(current))
      fail("etcd_state");
    set(legacy, ["cluster", "etcd", "ca"], newCA);
  } else if (role === "controlplane" && phase.startsWith("encryption-")) {
    const slot = encryptionSlot(documents),
      oldSlot = encryptionSlot(old),
      newSlot = encryptionSlot(next);
    if (
      oldSlot.keys.length !== 1 ||
      newSlot.keys.length !== 1 ||
      oldSlot.keys[0]!.secret === newSlot.keys[0]!.secret
    )
      fail("encryption_persisted_material");
    const oldKey = oldSlot.keys[0]!,
      canonical = newSlot.keys[0]!,
      rotation = {
        ...canonical,
        name: `rotation-${sha(Buffer.from(canonical.secret, "base64")).slice(0, 16)}`,
      };
    if (
      rotation.name === canonical.name ||
      slot.keys.some(
        (key) => key.name === rotation.name && key.secret !== rotation.secret,
      )
    )
      fail("encryption_name_collision");
    let keys: typeof slot.keys;
    if (phase.startsWith("encryption-name-")) {
      if (
        slot.keys.some(
          (key) =>
            key.secret !== canonical.secret ||
            ![canonical.name, rotation.name].includes(key.name),
        )
      )
        fail("old_encryption_material_present");
      if (phase === "encryption-name-decrypt") {
        if (slot.keys[0]!.name !== rotation.name)
          fail("encryption_alias_must_issue");
        keys = [rotation, canonical];
      } else if (phase === "encryption-name-issue") {
        if (
          !slot.keys.some((key) => key.name === canonical.name) ||
          !slot.keys.some((key) => key.name === rotation.name)
        )
          fail("encryption_alias_overlap_missing");
        keys = [canonical, rotation];
      } else {
        if (slot.keys[0]!.name !== canonical.name)
          fail("canonical_encryption_must_issue");
        keys = [canonical];
      }
    } else {
      if (
        slot.keys.some(
          (key) =>
            key.secret !== oldKey.secret && key.secret !== canonical.secret,
        )
      )
        fail("encryption_current_material");
      const rest = slot.keys.filter((key) => key.secret !== rotation.secret);
      if (phase === "encryption-decrypt") {
        if (slot.keys[0]!.secret !== oldKey.secret)
          fail("old_encryption_must_issue");
        keys = [...rest, rotation];
      } else {
        if (!slot.keys.some((key) => isDeepStrictEqual(key, rotation)))
          fail("encryption_overlap_missing");
        keys = [rotation, ...rest];
        if (phase === "encryption-retire") {
          if (!isDeepStrictEqual(slot.keys[0], rotation))
            fail("new_encryption_must_issue");
          keys = keys.filter((key) => key.secret !== oldKey.secret);
        }
      }
    }
    if (new Set(keys.map((key) => key.name)).size !== keys.length)
      fail("encryption_name_collision");
    set(
      slot.doc,
      [
        "config",
        "resources",
        slot.ri,
        "providers",
        slot.pi,
        "secretbox",
        "keys",
      ],
      keys,
    );
  }
  // Mask only explicitly selected leaves, then require exact preservation elsewhere.
  const before = structuredClone(actual),
    after = structuredClone(documents);
  for (const fields of permitted)
    for (const docs of [before, after]) {
      let current: ObjectValue | unknown[] = docs;
      for (const field of fields.slice(0, -1)) {
        const entry = (current as ObjectValue)[field];
        if (!isObject(entry) && !Array.isArray(entry))
          (current as ObjectValue)[field] = {};
        current = (current as ObjectValue)[field] as ObjectValue | unknown[];
      }
      (current as ObjectValue)[fields.at(-1)!] = null;
    }
  if (
    !isDeepStrictEqual(before, after) ||
    !isDeepStrictEqual(stable, identity(documents)) ||
    documents.length !== actual.length
  )
    fail("unselected_fields_changed");
  return {
    documents,
    changed_paths: actual.flatMap((doc, index) =>
      changed(doc, documents[index], `/${index}`),
    ),
    unselected_fields_preserved: true as const,
  };
}

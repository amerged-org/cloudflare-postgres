// SPDX-License-Identifier: Apache-2.0
import { createPublicKey, verify } from "node:crypto";
import {
  RotationKubernetesCursor,
  type RotationKubernetesCursor as Cursor,
} from "@pgcf/contracts/region-material-rotation";
import { BootstrapError, canonical, digest } from "./bootstrap.ts";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
const text = (value: unknown): string =>
  typeof value === "string" ? value : "";
const metadata = (value: ObjectValue) => object(value.metadata);
const fail = (code: string): never => {
  throw new BootstrapError(code);
};
const safeName = (value: string) =>
  /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(value) && value.length <= 253;
const pathName = (value: string) =>
  safeName(value)
    ? encodeURIComponent(value)
    : fail("rotation_resource_name_invalid");
const secretPath = (namespace: string, name: string) =>
  `/api/v1/namespaces/${pathName(namespace)}/secrets/${pathName(name)}`;
const sameData = (value: ObjectValue) =>
  digest(canonical({ type: value.type ?? "Opaque", data: object(value.data) }));
export interface RotationKubernetesCommands {
  kube(args: string[], payload?: string): Promise<string>;
  authorize(): Promise<void>;
  checkpoint(cursor: Cursor): Promise<void>;
  now?: () => number;
}
async function get(
  commands: RotationKubernetesCommands,
  path: string,
): Promise<ObjectValue> {
  const raw = await commands.kube(["get", "--raw", path]);
  if (Buffer.byteLength(raw) > 16 * 1024 * 1024)
    return fail("rotation_kubernetes_read_bound");
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return fail("rotation_kubernetes_read_invalid");
    return value;
  } catch {
    return fail("rotation_kubernetes_read_invalid");
  }
}
function list(value: ObjectValue): ObjectValue[] {
  if (
    !Array.isArray(value.items) ||
    value.items.length > 1000 ||
    text(object(value.metadata).continue)
  )
    return fail("rotation_kubernetes_inventory_incomplete");
  return value.items.map(object);
}
function item(
  value: ObjectValue,
  kind: Cursor["items"][number]["kind"],
): Cursor["items"][number] {
  const md = metadata(value);
  return {
    namespace: text(md.namespace),
    name: text(md.name),
    uid: text(md.uid),
    resource_version: text(md.resourceVersion),
    sha256: kind === "Secret" ? sameData(value) : specDigest(value, kind),
    kind,
  };
}
async function save(
  commands: RotationKubernetesCommands,
  cursor: Cursor,
): Promise<Cursor> {
  const parsed = RotationKubernetesCursor.parse(cursor);
  await commands.checkpoint(parsed);
  return parsed;
}
function cursorFor(
  raw: unknown,
  kind: Cursor["kind"],
  binding: { key_name?: string; annotation_value?: string },
): Cursor | null {
  if (raw === undefined) return null;
  const cursor = RotationKubernetesCursor.parse(raw);
  if (
    cursor.kind !== kind ||
    cursor.key_name !== binding.key_name ||
    cursor.annotation_value !== binding.annotation_value
  )
    return fail("rotation_kubernetes_cursor_changed");
  return structuredClone(cursor);
}
function assertSecret(value: ObjectValue, expected: Cursor["items"][number]) {
  const md = metadata(value);
  if (
    value.kind !== "Secret" ||
    md.uid !== expected.uid ||
    md.namespace !== expected.namespace ||
    md.name !== expected.name ||
    md.deletionTimestamp ||
    sameData(value) !== expected.sha256
  )
    return fail("rotation_secret_identity_changed");
}
/** Re-encrypt current Secrets with unchanged data. A dispatched uncertain write is read-only on resume. */
export async function rewriteRotationSecrets(
  input: { key_name: string; cursor?: unknown },
  commands: RotationKubernetesCommands,
) {
  if (!/^[a-z0-9-]{1,64}$/.test(input.key_name))
    return fail("rotation_encryption_key_name_invalid");
  let cursor = cursorFor(input.cursor, "rewrite_secrets", {
    key_name: input.key_name,
  });
  if (!cursor) {
    const secrets = list(await get(commands, "/api/v1/secrets")).sort((a, b) =>
      `${metadata(a).namespace}/${metadata(a).name}`.localeCompare(
        `${metadata(b).namespace}/${metadata(b).name}`,
      ),
    );
    cursor = await save(commands, {
      kind: "rewrite_secrets",
      index: 0,
      state: "pending",
      key_name: input.key_name,
      items: secrets.map((value) => item(value, "Secret")),
    });
  }
  for (let index = cursor.index; index < cursor.items.length; index++) {
    const expected = cursor.items[index]!,
      route = secretPath(expected.namespace, expected.name);
    let actual = await get(commands, route);
    assertSecret(actual, expected);
    if (index === cursor.index && cursor.state !== "pending") {
      if (metadata(actual).resourceVersion === expected.resource_version)
        return fail("rotation_secret_write_unresolved");
    } else {
      expected.resource_version = text(metadata(actual).resourceVersion);
      await commands.authorize();
      cursor = await save(commands, { ...cursor, index, state: "dispatched" });
      await commands.kube(
        ["replace", "--raw", route, "--filename=-"],
        JSON.stringify(actual),
      );
      actual = await get(commands, route);
      assertSecret(actual, expected);
      if (metadata(actual).resourceVersion === expected.resource_version)
        return fail("rotation_secret_write_unresolved");
    }
    cursor = await save(commands, {
      ...cursor,
      index: index + 1,
      state: "pending",
    });
  }
  const after = list(await get(commands, "/api/v1/secrets"));
  if (after.length !== cursor.items.length)
    return fail("rotation_secret_set_changed");
  for (const expected of cursor.items) {
    const actual = after.find(
      (value) =>
        metadata(value).namespace === expected.namespace &&
        metadata(value).name === expected.name,
    );
    if (!actual) return fail("rotation_secret_set_changed");
    assertSecret(actual, expected);
  }
  await save(commands, { ...cursor, state: "confirmed" });
  return {
    secret_count: cursor.items.length,
    all_uids_and_data_preserved: true,
    physical_ciphertext_verification_pending: true,
    items_sha256: digest(canonical(cursor.items)),
  };
}
const RESTART = "kubectl.kubernetes.io/restartedAt";
function specDigest(
  value: ObjectValue,
  kind: Cursor["items"][number]["kind"],
): string {
  const spec = structuredClone(object(value.spec));
  if (kind !== "Cluster") {
    const md = object(object(spec.template).metadata),
      annotations = object(md.annotations);
    delete annotations[RESTART];
    if (!Object.keys(annotations).length) delete md.annotations;
  }
  return digest(canonical(spec));
}
function owner(value: ObjectValue): ObjectValue | null {
  const refs = metadata(value).ownerReferences;
  if (!Array.isArray(refs)) return null;
  const owners = refs.map(object).filter((ref) => ref.controller === true);
  if (owners.length !== 1) return null;
  return owners[0]!;
}
const live = (value: ObjectValue) =>
  !metadata(value).deletionTimestamp &&
  !["Succeeded", "Failed"].includes(text(object(value.status).phase));
const hasToken = (value: ObjectValue) => {
  const volumes = object(value.spec).volumes;
  return (
    Array.isArray(volumes) &&
    volumes.some((volume) => {
      const sources = object(object(volume).projected).sources;
      return (
        Array.isArray(sources) &&
        sources.some(
          (source) => object(source).serviceAccountToken !== undefined,
        )
      );
    })
  );
};
const controllerPath = (kind: string, namespace: string, name: string) =>
  kind === "Cluster"
    ? `/apis/postgresql.cnpg.io/v1/namespaces/${pathName(namespace)}/clusters/${pathName(name)}`
    : `/apis/apps/v1/namespaces/${pathName(namespace)}/${kind === "Deployment" ? "deployments" : kind === "DaemonSet" ? "daemonsets" : "statefulsets"}/${pathName(name)}`;
async function consumers(commands: RotationKubernetesCommands) {
  const [podList, replicaList] = await Promise.all([
    get(commands, "/api/v1/pods"),
    get(commands, "/apis/apps/v1/replicasets"),
  ]);
  const replicas = list(replicaList),
    pods = list(podList).filter((value) => live(value) && hasToken(value));
  const owners = new Map<string, ObjectValue>();
  for (const pod of pods) {
    const md = metadata(pod);
    let ref = owner(pod);
    if (!ref) return fail("rotation_token_consumer_owner_unknown");
    if (ref.kind === "ReplicaSet") {
      const replica = replicas.find(
        (value) =>
          metadata(value).uid === ref!.uid &&
          metadata(value).name === ref!.name &&
          metadata(value).namespace === md.namespace,
      );
      if (!replica) return fail("rotation_token_consumer_owner_changed");
      ref = owner(replica);
      if (ref?.kind !== "Deployment")
        return fail("rotation_token_consumer_owner_unknown");
    }
    if (
      !["Deployment", "DaemonSet", "StatefulSet", "Cluster"].includes(
        text(ref.kind),
      )
    )
      return fail("rotation_token_consumer_owner_unsupported");
    const namespace = text(md.namespace),
      kind = text(ref.kind),
      name = text(ref.name),
      uid = text(ref.uid);
    const key = `${namespace}/${kind}/${name}`;
    if (owners.has(key) && owners.get(key)!.uid !== uid)
      return fail("rotation_token_consumer_owner_changed");
    owners.set(key, { namespace, kind, name, uid });
    md.rotation_controller_uid = uid;
  }
  return { pods, owners };
}
async function issuerLoaded(
  input: { issuer_private_key: string; issuer_url: string },
  commands: RotationKubernetesCommands,
) {
  const publicKey = createPublicKey(input.issuer_private_key),
    sa = await get(
      commands,
      "/api/v1/namespaces/default/serviceaccounts/default",
    ),
    uid = text(metadata(sa).uid);
  if (
    !uid ||
    metadata(sa).namespace !== "default" ||
    metadata(sa).name !== "default"
  )
    return fail("rotation_serviceaccount_identity_changed");
  await commands.authorize();
  const raw = await commands.kube(
    [
      "create",
      "--raw",
      "/api/v1/namespaces/default/serviceaccounts/default/token",
      "--filename=-",
    ],
    JSON.stringify({
      apiVersion: "authentication.k8s.io/v1",
      kind: "TokenRequest",
      spec: { audiences: [input.issuer_url], expirationSeconds: 600 },
    }),
  );
  const token = text(object(object(JSON.parse(raw)).status).token),
    parts = token.split(".");
  if (parts.length !== 3 || token.length > 16384)
    return fail("rotation_serviceaccount_token_invalid");
  let header: ObjectValue, claims: ObjectValue;
  try {
    header = object(JSON.parse(Buffer.from(parts[0]!, "base64url").toString()));
    claims = object(JSON.parse(Buffer.from(parts[1]!, "base64url").toString()));
  } catch {
    return fail("rotation_serviceaccount_token_invalid");
  }
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`),
    signature = Buffer.from(parts[2]!, "base64url"),
    alg =
      publicKey.asymmetricKeyType === "rsa"
        ? "RS256"
        : publicKey.asymmetricKeyType === "ec"
          ? "ES256"
          : publicKey.asymmetricKeyType === "ed25519"
            ? "EdDSA"
            : null;
  const signatureValid =
    header.alg === alg &&
    (alg === "RS256"
      ? verify("RSA-SHA256", signed, publicKey, signature)
      : alg === "ES256"
        ? verify(
            "sha256",
            signed,
            { key: publicKey, dsaEncoding: "ieee-p1363" },
            signature,
          )
        : alg === "EdDSA"
          ? verify(null, signed, publicKey, signature)
          : false);
  const now = Math.floor((commands.now ?? Date.now)() / 1000),
    identity = object(claims["kubernetes.io"]),
    aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    !signatureValid ||
    claims.iss !== input.issuer_url ||
    aud.length !== 1 ||
    aud[0] !== input.issuer_url ||
    claims.sub !== "system:serviceaccount:default:default" ||
    identity.namespace !== "default" ||
    object(identity.serviceaccount).name !== "default" ||
    object(identity.serviceaccount).uid !== uid ||
    !Number.isInteger(claims.iat) ||
    Number(claims.iat) > now + 5 ||
    !Number.isInteger(claims.exp) ||
    Number(claims.exp) <= now
  )
    return fail("rotation_serviceaccount_issuer_not_loaded");
  return {
    actual_api_issuer_signature_verified: true,
    new_signer_sha256: digest(
      publicKey.export({ type: "spki", format: "der" }),
    ),
  };
}
/** Renew actual token consumers after the API demonstrably signs tokens with the replacement key. */
export async function renewRotationConsumers(
  input: {
    issuer_private_key: string;
    issuer_url: string;
    annotation_value: string;
    cursor?: unknown;
  },
  commands: RotationKubernetesCommands,
) {
  if (!input.annotation_value || input.annotation_value.length > 128)
    return fail("rotation_restart_annotation_invalid");
  const issuerProof = await issuerLoaded(input, commands);
  let cursor = cursorFor(input.cursor, "renew_consumers", {
    annotation_value: input.annotation_value,
  });
  if (!cursor) {
    const snap = await consumers(commands),
      items: Cursor["items"] = [];
    for (const value of snap.owners.values()) {
      const kind = text(value.kind) as Cursor["items"][number]["kind"],
        current = await get(
          commands,
          controllerPath(text(kind), text(value.namespace), text(value.name)),
        );
      if (metadata(current).uid !== value.uid)
        return fail("rotation_token_consumer_owner_changed");
      const entry = item(current, kind);
      entry.initial_pod_uids = snap.pods
        .filter((pod) => metadata(pod).rotation_controller_uid === entry.uid)
        .map((pod) => text(metadata(pod).uid));
      items.push(entry);
    }
    items.sort(
      (a, b) =>
        Number(a.kind === "DaemonSet" && a.name === "cilium") -
          Number(b.kind === "DaemonSet" && b.name === "cilium") ||
        `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`),
    );
    cursor = await save(commands, {
      kind: "renew_consumers",
      index: 0,
      state: "pending",
      annotation_value: input.annotation_value,
      restart_at: new Date((commands.now ?? Date.now)()).toISOString(),
      items,
    });
  }
  if (!cursor.restart_at) return fail("rotation_restart_timestamp_missing");
  for (let index = cursor.index; index < cursor.items.length; index++) {
    const expected = cursor.items[index]!,
      kind = expected.kind!,
      route = controllerPath(kind, expected.namespace, expected.name);
    let current = await get(commands, route);
    if (
      metadata(current).uid !== expected.uid ||
      specDigest(current, kind) !== expected.sha256
    )
      return fail("rotation_token_consumer_owner_changed");
    const annotation =
      kind === "Cluster"
        ? metadata(current).annotations
        : object(object(object(current.spec).template).metadata).annotations;
    if (index === cursor.index && cursor.state === "dispatched") {
      if (object(annotation)[RESTART] !== cursor.restart_at)
        return fail("rotation_consumer_write_unresolved");
    } else {
      const ops: ObjectValue[] = [
        { op: "test", path: "/metadata/uid", value: expected.uid },
        {
          op: "test",
          path: "/metadata/resourceVersion",
          value: metadata(current).resourceVersion,
        },
      ];
      const base = kind === "Cluster" ? "/metadata" : "/spec/template/metadata";
      if (annotation === undefined)
        ops.push({ op: "add", path: `${base}/annotations`, value: {} });
      ops.push({
        op: "add",
        path: `${base}/annotations/kubectl.kubernetes.io~1restartedAt`,
        value: cursor.restart_at,
      });
      await commands.authorize();
      cursor = await save(commands, { ...cursor, index, state: "dispatched" });
      await commands.kube([
        "patch",
        kind.toLowerCase(),
        expected.name,
        "-n",
        expected.namespace,
        "--type=json",
        "--patch",
        JSON.stringify(ops),
      ]);
      current = await get(commands, route);
      const after =
        kind === "Cluster"
          ? object(metadata(current).annotations)
          : object(
              object(object(object(current.spec).template).metadata)
                .annotations,
            );
      if (
        metadata(current).uid !== expected.uid ||
        specDigest(current, kind) !== expected.sha256 ||
        object(after)[RESTART] !== cursor.restart_at
      )
        return fail("rotation_consumer_write_unresolved");
    }
    const snap = await consumers(commands),
      matching = snap.pods.filter(
        (pod) => metadata(pod).rotation_controller_uid === expected.uid,
      );
    if (
      snap.pods.some((pod) =>
        expected.initial_pod_uids!.includes(text(metadata(pod).uid)),
      ) ||
      !matching.length ||
      matching.some(
        (pod) =>
          object(pod.status).phase !== "Running" ||
          !Array.isArray(object(pod.status).conditions) ||
          !(object(pod.status).conditions as unknown[]).some(
            (condition) =>
              object(condition).type === "Ready" &&
              object(condition).status === "True",
          ),
      )
    )
      return fail("rotation_consumer_rollout_pending");
    cursor = await save(commands, {
      ...cursor,
      index: index + 1,
      state: "pending",
    });
  }
  const snap = await consumers(commands);
  if (
    snap.pods.some(
      (pod) =>
        cursor!.items.some((value) =>
          value.initial_pod_uids!.includes(text(metadata(pod).uid)),
        ) ||
        !cursor!.items.some(
          (value) => value.uid === metadata(pod).rotation_controller_uid,
        ),
    )
  )
    return fail("rotation_consumer_set_changed");
  await save(commands, { ...cursor, state: "confirmed" });
  return {
    ...issuerProof,
    controllers_renewed: cursor.items.length,
    new_projected_token_pods_ready: true,
    items_sha256: digest(canonical(cursor.items)),
  };
}
export async function retireRotationBootstrapToken(
  input: { old_token: string; new_token: string; cursor?: unknown },
  commands: RotationKubernetesCommands,
) {
  if (
    !/^[a-z0-9]{6}\.[a-z0-9]{16}$/.test(input.old_token) ||
    !/^[a-z0-9]{6}\.[a-z0-9]{16}$/.test(input.new_token) ||
    input.old_token === input.new_token
  )
    return fail("rotation_bootstrap_token_invalid");
  const oldName = `bootstrap-token-${input.old_token.split(".")[0]}`,
    newName = `bootstrap-token-${input.new_token.split(".")[0]}`;
  let cursor = cursorFor(input.cursor, "retire_bootstrap", {});
  const all = list(await get(commands, "/api/v1/secrets")),
    replacement = all.find(
      (value) =>
        metadata(value).namespace === "kube-system" &&
        metadata(value).name === newName,
    );
  const matchesToken = (value: ObjectValue, token: string) =>
    `${Buffer.from(text(object(value.data)["token-id"]), "base64").toString()}.${Buffer.from(text(object(value.data)["token-secret"]), "base64").toString()}` ===
    token;
  if (!replacement || !matchesToken(replacement, input.new_token))
    return fail("rotation_replacement_bootstrap_not_ready");
  if (!cursor) {
    const old = all.find(
      (value) =>
        metadata(value).namespace === "kube-system" &&
        metadata(value).name === oldName,
    );
    if (!old || !matchesToken(old, input.old_token))
      return fail("rotation_prior_bootstrap_not_ready");
    await commands.authorize();
    cursor = await save(commands, {
      kind: "retire_bootstrap",
      index: 0,
      state: "dispatched",
      items: [item(old, "Secret"), item(replacement, "Secret")],
    });
    await commands.kube(
      ["delete", "--raw", secretPath("kube-system", oldName), "--filename=-"],
      JSON.stringify({
        apiVersion: "v1",
        kind: "DeleteOptions",
        preconditions: {
          uid: cursor.items[0]!.uid,
          resourceVersion: cursor.items[0]!.resource_version,
        },
      }),
    );
  }
  const after = list(await get(commands, "/api/v1/secrets")),
    fresh = after.find(
      (value) =>
        metadata(value).namespace === "kube-system" &&
        metadata(value).name === newName,
    );
  if (
    after.some(
      (value) =>
        metadata(value).namespace === "kube-system" &&
        metadata(value).name === oldName,
    )
  )
    return fail("rotation_bootstrap_delete_unresolved");
  if (!fresh) return fail("rotation_replacement_bootstrap_not_ready");
  assertSecret(fresh, cursor.items[1]!);
  await save(commands, { ...cursor, index: 2, state: "confirmed" });
  return { old_secret_absent: true, new_secret_preserved: true };
}

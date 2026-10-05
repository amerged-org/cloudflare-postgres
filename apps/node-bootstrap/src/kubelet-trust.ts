// SPDX-License-Identifier: Apache-2.0
import { X509Certificate } from "node:crypto";
import type { NodeBootstrapInput } from "@pgcf/contracts/node-bootstrap";
import { BootstrapError, canonical, digest } from "./bootstrap.ts";

type Json = Record<string, unknown>;
const UID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const CERTIFICATE =
  /-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g;

function record(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BootstrapError("kubelet_trust_readback_invalid");
  return value as Json;
}
function metadata(
  value: Json,
  kind: string,
  name: string,
  namespace?: string,
): Json {
  const result = record(value.metadata);
  if (
    value.apiVersion !== "v1" ||
    value.kind !== kind ||
    result.name !== name ||
    (namespace !== undefined && result.namespace !== namespace) ||
    typeof result.uid !== "string" ||
    !UID.test(result.uid) ||
    typeof result.resourceVersion !== "string" ||
    !/^[0-9]+$/.test(result.resourceVersion) ||
    result.deletionTimestamp
  )
    throw new BootstrapError("kubelet_trust_readback_invalid");
  return result;
}

export function validateKubeletCertificate(
  pem: string,
  nodeName: string,
  now: number,
) {
  if (
    !pem ||
    Buffer.byteLength(pem, "utf8") > 16 * 1024 ||
    /PRIVATE KEY/.test(pem) ||
    !Number.isFinite(now)
  )
    throw new BootstrapError("kubelet_certificate_invalid");
  const blocks = [...pem.matchAll(CERTIFICATE)];
  if (
    !blocks.length ||
    blocks.length > 8 ||
    pem.replace(CERTIFICATE, "").trim()
  )
    throw new BootstrapError("kubelet_certificate_invalid");
  let leaf: X509Certificate | undefined;
  try {
    for (const block of blocks) {
      const certificate = new X509Certificate(block[0]);
      const from = Date.parse(certificate.validFrom),
        to = Date.parse(certificate.validTo);
      if (
        !Number.isFinite(from) ||
        !Number.isFinite(to) ||
        now < from ||
        now > to
      )
        throw new BootstrapError("kubelet_certificate_invalid");
      leaf ??= certificate;
    }
  } catch {
    throw new BootstrapError("kubelet_certificate_invalid");
  }
  if (
    leaf?.checkHost(nodeName, { subject: "never", wildcards: false }) !==
    nodeName
  )
    throw new BootstrapError("kubelet_certificate_identity_mismatch");
  return { certificate_pem: pem, certificate_sha256: digest(pem) };
}

export interface KubeletTrustCommands {
  authorize(): Promise<string>;
  talos(args: string[]): Promise<{ exit_code: number; stdout: string }>;
  kube(
    args: string[],
    permit_failure?: boolean,
    stdin?: string,
  ): Promise<{ exit_code: number; stdout: string }>;
}
interface Binding {
  node_uid: string;
  cluster_uid: string;
  namespace_uid: string;
}

export async function publishKubeletTrust(
  input: NodeBootstrapInput,
  commands: KubeletTrustCommands,
) {
  const read = async (
    kind: "node" | "namespace" | "configmap",
    name: string,
    namespace?: string,
    missing = false,
  ): Promise<Json | null> => {
    const result = await commands.kube([
      ...(namespace ? ["--namespace", namespace] : []),
      "get",
      kind,
      name,
      ...(missing ? ["--ignore-not-found"] : []),
      "--output=json",
    ]);
    if (!result.stdout.trim() && missing) return null;
    try {
      return record(JSON.parse(result.stdout));
    } catch {
      throw new BootstrapError("kubelet_trust_readback_invalid");
    }
  };
  const binding = async (): Promise<Binding> => {
    const cluster_uid = await commands.authorize();
    if (!UID.test(cluster_uid))
      throw new BootstrapError("cluster_uid_mismatch");
    const node = (await read("node", input.spec.hostname))!;
    const nodeMetadata = metadata(node, "Node", input.spec.hostname);
    const labels = record(nodeMetadata.labels);
    const addresses = record(node.status).addresses;
    if (
      labels["pgcf.io/node-id"] !== input.spec.node_id ||
      labels["pgcf.io/region"] !== input.spec.region_id ||
      labels["pgcf.io/provider-instance-id"] !==
        input.spec.provider_instance_id ||
      !Array.isArray(addresses) ||
      !addresses.some(
        (value) =>
          record(value).type === "InternalIP" &&
          record(value).address === input.spec.hardware.ipv4,
      )
    )
      throw new BootstrapError("kubernetes_node_identity_mismatch");
    const cluster = metadata(
      (await read("namespace", "kube-system"))!,
      "Namespace",
      "kube-system",
    );
    if (cluster.uid !== cluster_uid)
      throw new BootstrapError("cluster_uid_mismatch");
    const namespace = metadata(
      (await read("namespace", "pgcf-system"))!,
      "Namespace",
      "pgcf-system",
    );
    return {
      node_uid: String(nodeMetadata.uid),
      cluster_uid,
      namespace_uid: String(namespace.uid),
    };
  };
  const first = await binding();
  const response = await commands.talos([
    "read",
    "/var/lib/kubelet/pki/kubelet.crt",
  ]);
  if (response.exit_code !== 0)
    throw new BootstrapError("kubelet_certificate_read_failed");
  const certificate = validateKubeletCertificate(
    response.stdout,
    input.spec.hostname,
    Date.now(),
  );
  const name = `kubelet-${first.node_uid}`;
  const expected = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name,
      namespace: "pgcf-system",
      labels: {
        "pgcf.io/kubelet-node-uid": first.node_uid,
        "pgcf.io/kubelet-cluster-uid": first.cluster_uid,
        "pgcf.io/node-id": input.spec.node_id,
        "pgcf.io/region": input.spec.region_id,
      },
      annotations: { "pgcf.io/bootstrap-input": input.input_hash },
    },
    data: {
      node_name: input.spec.hostname,
      node_uid: first.node_uid,
      cluster_uid: first.cluster_uid,
      ...certificate,
    },
  };
  const confirmBinding = async () => {
    if (canonical(await binding()) !== canonical(first))
      throw new BootstrapError("kubelet_trust_identity_changed");
  };
  const confirmMap = (value: Json) => {
    const observed = metadata(value, "ConfigMap", name, "pgcf-system");
    const labels = record(observed.labels),
      annotations = record(observed.annotations);
    if (
      Object.entries(expected.metadata.labels).some(
        ([key, wanted]) => labels[key] !== wanted,
      ) ||
      annotations["pgcf.io/bootstrap-input"] !== input.input_hash ||
      canonical(record(value.data)) !== canonical(expected.data)
    )
      throw new BootstrapError("kubelet_trust_map_mismatch");
  };
  await confirmBinding();
  const previous = await read("configmap", name, "pgcf-system", true);
  if (previous) {
    confirmMap(previous);
    await confirmBinding();
    return;
  }
  await confirmBinding();
  try {
    // Atomic create cannot overwrite another map; a lost response is resolved by exact readback.
    await commands.kube(
      ["create", "--filename=/dev/stdin", "--output=name"],
      true,
      JSON.stringify(expected),
    );
  } catch {
    /* Authenticated readback determines whether this single create committed. */
  }
  await confirmBinding();
  const observed = await read("configmap", name, "pgcf-system", true);
  if (!observed) throw new BootstrapError("kubelet_trust_create_unconfirmed");
  confirmMap(observed);
  await confirmBinding();
}

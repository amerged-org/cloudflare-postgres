// SPDX-License-Identifier: Apache-2.0
import { X509Certificate } from "node:crypto";
import type { NodeBootstrapInput } from "@pgcf/contracts/node-bootstrap";
import type { FleetPatchInput } from "@pgcf/contracts/fleet-patches";
import { BootstrapError, canonical, digest } from "./bootstrap.ts";

type Json = Record<string, unknown>;
const UID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const CERTIFICATE =
  /-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g;
// EU control predates programmed installation: the authenticated Talos operator published its map.
const OPERATOR_SOURCE = "pgcf.io/kubelet-trust-source",
  OPERATOR_PUBLISHED = "authenticated-talos-operator";

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
  system_uuid?: string;
  boot_id?: string;
}

type TrustInput = Pick<NodeBootstrapInput, "input_hash"> & {
  spec: Pick<
    NodeBootstrapInput["spec"],
    "hostname" | "node_id" | "region_id" | "provider_instance_id"
  > & { hardware: Pick<NodeBootstrapInput["spec"]["hardware"], "ipv4"> };
};

export async function publishKubeletTrust(
  input: TrustInput,
  commands: KubeletTrustCommands,
  refresh?: Pick<Binding, "node_uid" | "cluster_uid">,
  /** Retained node without bootstrap input; adopt replaces its operator-published map once. */
  retained?: { adopt: boolean },
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
      // A retained manual-era Node may lack the region label; a different region never matches.
      (labels["pgcf.io/region"] !== input.spec.region_id &&
        !(retained && labels["pgcf.io/region"] === undefined)) ||
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
    const physical = refresh ? record(record(node.status).nodeInfo) : null,
      systemUuid = String(physical?.systemUUID).toLowerCase(),
      bootId = String(physical?.bootID).toLowerCase();
    if (
      refresh &&
      (nodeMetadata.uid !== refresh.node_uid ||
        cluster_uid !== refresh.cluster_uid ||
        !UID.test(systemUuid) ||
        !UID.test(bootId))
    )
      throw new BootstrapError("kubelet_trust_identity_changed");
    return {
      node_uid: String(nodeMetadata.uid),
      cluster_uid,
      namespace_uid: String(namespace.uid),
      ...(physical
        ? {
            system_uuid: systemUuid,
            boot_id: bootId,
          }
        : {}),
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
    if (retained?.adopt) {
      const previousMetadata = metadata(
          previous,
          "ConfigMap",
          name,
          "pgcf-system",
        ),
        prior = record(previous.data),
        previousPem = prior.certificate_pem;
      // Adopt only the exact operator-published shape for this Node and cluster: one conditional
      // replacement gives it the owned labels, owner annotation and the current public leaf.
      if (
        canonical(previousMetadata.labels ?? {}) !==
          canonical({
            "app.kubernetes.io/part-of": "pgcf",
            "pgcf.io/kubelet-node-uid": first.node_uid,
          }) ||
        canonical(previousMetadata.annotations ?? {}) !==
          canonical({ [OPERATOR_SOURCE]: OPERATOR_PUBLISHED }) ||
        canonical(Object.keys(prior).sort()) !==
          canonical(Object.keys(expected.data).sort()) ||
        prior.node_name !== expected.data.node_name ||
        prior.node_uid !== first.node_uid ||
        prior.cluster_uid !== first.cluster_uid ||
        typeof previousPem !== "string" ||
        Buffer.byteLength(previousPem, "utf8") > 16 * 1024 ||
        /PRIVATE KEY/.test(previousPem) ||
        prior.certificate_sha256 !== digest(previousPem)
      )
        throw new BootstrapError("kubelet_trust_map_mismatch");
      const updated = structuredClone(previous);
      Object.assign(record(updated.metadata), {
        labels: expected.metadata.labels,
        annotations: expected.metadata.annotations,
      });
      updated.data = expected.data;
      await confirmBinding();
      try {
        await commands.kube(
          ["replace", "--filename=-", "--output=json"],
          true,
          JSON.stringify(updated),
        );
      } catch {
        /* Resolve this single conditional replacement through authenticated readback. */
      }
      await confirmBinding();
      const observed = await read("configmap", name, "pgcf-system", true);
      if (!observed || record(observed.metadata).uid !== previousMetadata.uid)
        throw new BootstrapError("kubelet_trust_refresh_unconfirmed");
      confirmMap(observed);
    } else if (
      !refresh ||
      canonical(record(previous.data)) === canonical(expected.data)
    )
      confirmMap(previous);
    else {
      const previousMetadata = metadata(
          previous,
          "ConfigMap",
          name,
          "pgcf-system",
        ),
        prior = record(previous.data),
        previousPem = prior.certificate_pem;
      // The previous public pin must still belong to this exact Node/cluster.
      // Only certificate bytes change; the existing UID/resourceVersion fence the PUT.
      if (
        typeof previousPem !== "string" ||
        Buffer.byteLength(previousPem, "utf8") > 16 * 1024 ||
        /PRIVATE KEY/.test(previousPem) ||
        prior.certificate_sha256 !== digest(previousPem)
      )
        throw new BootstrapError("kubelet_trust_map_mismatch");
      confirmMap({ ...previous, data: { ...prior, ...certificate } });
      const updated = structuredClone(previous);
      updated.data = expected.data;
      await confirmBinding();
      try {
        await commands.kube(
          ["replace", "--filename=-", "--output=json"],
          true,
          JSON.stringify(updated),
        );
      } catch {
        /* Resolve this single conditional replacement through authenticated readback. */
      }
      await confirmBinding();
      const observed = await read("configmap", name, "pgcf-system", true);
      if (!observed || record(observed.metadata).uid !== previousMetadata.uid)
        throw new BootstrapError("kubelet_trust_refresh_unconfirmed");
      confirmMap(observed);
    }
    await confirmBinding();
    return;
  }
  await confirmBinding();
  try {
    // Atomic create cannot overwrite another map; a lost response is resolved by exact readback.
    await commands.kube(
      ["create", "--filename=-", "--output=name"],
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

/** Supported patch/authority replacement boundary; consumers never trust a new TLS leaf themselves. */
export async function refreshKubeletTrust(
  input: Pick<
    FleetPatchInput,
    "k8s_node_name" | "address" | "initial_bootstrap_input_sha256"
  > & {
    status: Pick<
      FleetPatchInput["status"],
      "node_id" | "region_id" | "node_uid" | "cluster_uid"
    >;
  },
  commands: KubeletTrustCommands,
) {
  const result = await commands.kube([
    "get",
    "node",
    input.k8s_node_name,
    "--output=json",
  ]);
  const node = record(JSON.parse(result.stdout)),
    nodeMetadata = metadata(node, "Node", input.k8s_node_name);
  if (nodeMetadata.uid !== input.status.node_uid)
    throw new BootstrapError("kubelet_trust_identity_changed");
  let owner = input.initial_bootstrap_input_sha256,
    adopt = false;
  if (!owner) {
    const current = await commands.kube([
      "--namespace",
      "pgcf-system",
      "get",
      "configmap",
      `kubelet-${input.status.node_uid}`,
      "--output=json",
    ]);
    const map = record(JSON.parse(current.stdout));
    metadata(
      map,
      "ConfigMap",
      `kubelet-${input.status.node_uid}`,
      "pgcf-system",
    );
    const annotations = record(record(map.metadata).annotations);
    adopt =
      annotations["pgcf.io/bootstrap-input"] === undefined &&
      annotations[OPERATOR_SOURCE] === OPERATOR_PUBLISHED;
    // Without a bootstrap input, the operator-published map binds once to an owner derived
    // from the node's fixed identity; later refreshes read that owner back like any other.
    owner = adopt
      ? digest(
          `pgcf-retained-kubelet-trust/v1\n${input.status.node_id}\n${input.status.node_uid}\n${input.status.cluster_uid}`,
        )
      : String(annotations["pgcf.io/bootstrap-input"]);
  }
  if (!/^[a-f0-9]{64}$/.test(owner))
    throw new BootstrapError("kubelet_trust_map_mismatch");
  await publishKubeletTrust(
    {
      input_hash: owner,
      spec: {
        hostname: input.k8s_node_name,
        node_id: input.status.node_id,
        region_id: input.status.region_id,
        provider_instance_id: String(
          record(nodeMetadata.labels)["pgcf.io/provider-instance-id"],
        ),
        hardware: { ipv4: input.address },
      },
    },
    commands,
    { node_uid: input.status.node_uid, cluster_uid: input.status.cluster_uid },
    input.initial_bootstrap_input_sha256 ? undefined : { adopt },
  );
}

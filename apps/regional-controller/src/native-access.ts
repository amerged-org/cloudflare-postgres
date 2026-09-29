// SPDX-License-Identifier: Apache-2.0
import { createHash, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import type {
  Claim,
  Kubernetes,
  NativeAccessPolicy,
  NativeClientProfile,
  NativeConnectionObservation,
  RegionalConfig,
  Resource,
} from "./types.ts";

const uid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const id = /^[a-z][a-z0-9_-]{0,63}$/;
const dns = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const marker = "pgcf.io/native-client-uid";
function fields(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
export function validNativeAccess(value: unknown): value is NativeAccessPolicy {
  return (
    fields(value, ["version", "clientProfileId"]) &&
    value.version === 1 &&
    typeof value.clientProfileId === "string" &&
    id.test(value.clientProfileId)
  );
}
export function validNativeClientProfiles(
  value: unknown,
): value is NativeClientProfile[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= 32 &&
      new Set(value.map((profile: NativeClientProfile) => profile?.id)).size ===
        value.length &&
      value.every(
        (profile: unknown) =>
          fields(profile, [
            "id",
            "namespace",
            "namespaceUid",
            "serviceAccount",
            "serviceAccountUid",
          ]) &&
          typeof profile.id === "string" &&
          id.test(profile.id) &&
          typeof profile.namespace === "string" &&
          dns.test(profile.namespace) &&
          !/^pgcf-[a-f0-9]{32}$/.test(profile.namespace) &&
          typeof profile.namespaceUid === "string" &&
          uid.test(profile.namespaceUid) &&
          typeof profile.serviceAccount === "string" &&
          dns.test(profile.serviceAccount) &&
          typeof profile.serviceAccountUid === "string" &&
          uid.test(profile.serviceAccountUid),
      ))
  );
}
function same(before: Resource, after: Resource | null): boolean {
  return (
    after !== null &&
    before.apiVersion === after.apiVersion &&
    before.kind === after.kind &&
    before.metadata.name === after.metadata.name &&
    before.metadata.namespace === after.metadata.namespace &&
    before.metadata.uid === after.metadata.uid &&
    before.metadata.resourceVersion === after.metadata.resourceVersion &&
    !after.metadata.deletionTimestamp
  );
}
function owner(
  resource: Resource,
  kind: string,
  name: string,
  ownerUid: string,
  apiVersion: string,
): boolean {
  const owners = resource.metadata.ownerReferences?.filter(
    (entry) => entry.controller === true,
  );
  return (
    owners?.length === 1 &&
    owners[0]?.kind === kind &&
    owners[0].name === name &&
    owners[0].uid === ownerUid &&
    owners[0].apiVersion === apiVersion
  );
}
function identity(
  resource: Resource | null,
  kind: string,
  name: string,
  namespace?: string,
): resource is Resource {
  return (
    resource !== null &&
    resource.kind === kind &&
    resource.apiVersion ===
      (kind === "EndpointSlice" ? "discovery.k8s.io/v1" : "v1") &&
    resource.metadata.name === name &&
    resource.metadata.namespace === namespace &&
    typeof resource.metadata.uid === "string" &&
    uid.test(resource.metadata.uid) &&
    typeof resource.metadata.resourceVersion === "string" &&
    resource.metadata.resourceVersion.length > 0 &&
    !resource.metadata.deletionTimestamp
  );
}
function authorizedRead(api: Kubernetes, authorized: () => void) {
  return async (kind: string, namespace: string, name: string) => {
    authorized();
    const current = await api.read(kind, namespace, name);
    authorized();
    return current;
  };
}
export interface NativeClientBinding {
  profile: NativeClientProfile;
  namespace: Resource;
  serviceAccount: Resource;
}
// This happens before environment provisioning: an unapproved client cannot cause
// database, credential or policy effects. The installation owns these principals.
export async function prepareNativeClient(
  api: Kubernetes,
  claim: Claim,
  config: RegionalConfig,
  authorized: () => void,
): Promise<NativeClientBinding | null> {
  if (!Object.hasOwn(claim.spec.profile, "nativeAccess")) return null;
  if (
    !validNativeAccess(claim.spec.profile.nativeAccess) ||
    !validNativeClientProfiles(config.nativeClientProfiles)
  )
    throw new Error("native_client_profile_unavailable");
  const matches = config.nativeClientProfiles?.filter(
    (profile) =>
      profile.id === claim.spec.profile.nativeAccess!.clientProfileId,
  );
  if (
    matches?.length !== 1 ||
    !api.listEndpointSlices ||
    !api.readPublicCertificate
  )
    throw new Error("native_client_profile_unavailable");
  const profile = { ...matches[0]! };
  const read = authorizedRead(api, authorized);
  const namespace = await read("Namespace", "", profile.namespace);
  const serviceAccount = await read(
    "ServiceAccount",
    profile.namespace,
    profile.serviceAccount,
  );
  if (
    !identity(namespace, "Namespace", profile.namespace) ||
    namespace.metadata.uid !== profile.namespaceUid ||
    namespace.metadata.labels?.[marker] !== profile.namespaceUid ||
    !identity(
      serviceAccount,
      "ServiceAccount",
      profile.serviceAccount,
      profile.namespace,
    ) ||
    serviceAccount.metadata.uid !== profile.serviceAccountUid
  )
    throw new Error("native_client_identity_changed");
  return { profile, namespace, serviceAccount };
}
function certificate(
  resource: Resource,
  key: "ca.crt" | "tls.crt",
): { pem: string; x509: X509Certificate } {
  const encoded = resource.data?.[key];
  if (
    typeof encoded !== "string" ||
    encoded.length > 12_000 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    ) ||
    Object.keys(resource.data ?? {}).length !== 1
  )
    throw new Error("native_tls_identity_unproven");
  const bytes = Buffer.from(encoded, "base64");
  const pem = bytes.toString("utf8");
  if (
    bytes.toString("base64") !== encoded ||
    pem.length > 8192 ||
    !/^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+\n-----END CERTIFICATE-----\n?$/.test(
      pem,
    )
  )
    throw new Error("native_tls_identity_unproven");
  try {
    return { pem, x509: new X509Certificate(pem) };
  } catch {
    throw new Error("native_tls_identity_unproven");
  }
}
function certificates(ca: Resource, server: Resource, host: string) {
  const root = certificate(ca, "ca.crt");
  const leaf = certificate(server, "tls.crt");
  const now = Date.now();
  const rootFrom = Date.parse(root.x509.validFrom),
    rootUntil = Date.parse(root.x509.validTo),
    leafFrom = Date.parse(leaf.x509.validFrom),
    leafUntil = Date.parse(leaf.x509.validTo);
  if (
    !root.x509.ca ||
    leaf.x509.ca ||
    !root.x509.verify(root.x509.publicKey) ||
    !leaf.x509.checkIssued(root.x509) ||
    !leaf.x509.verify(root.x509.publicKey) ||
    !leaf.x509.keyUsage?.includes("1.3.6.1.5.5.7.3.1") ||
    leaf.x509.checkHost(host, { subject: "never", wildcards: false }) !==
      host ||
    !Number.isFinite(rootFrom) ||
    !Number.isFinite(rootUntil) ||
    !Number.isFinite(leafFrom) ||
    !Number.isFinite(leafUntil) ||
    rootFrom > now ||
    leafFrom > now ||
    rootUntil <= now ||
    leafUntil <= now
  )
    throw new Error("native_tls_identity_unproven");
  return {
    caCertificate: root.pem,
    caCertificateSha256: createHash("sha256").update(root.pem).digest("hex"),
    serverCertificateSha256: createHash("sha256")
      .update(leaf.x509.raw)
      .digest("hex"),
    caValidFrom: new Date(rootFrom).toISOString(),
    caValidUntil: new Date(rootUntil).toISOString(),
    serverValidUntil: new Date(leafUntil).toISOString(),
  };
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

// This is a provision-time Kubernetes/TLS-material observation, not a wire SQL
// verifier, a gateway, an ongoing health certificate or permission to wake.
export async function reconcileNativeAccess(
  api: Kubernetes,
  claim: Claim,
  cluster: Resource,
  namespaceResource: Resource,
  pods: Resource[],
  binding: NativeClientBinding,
  authorized: () => void,
): Promise<NativeConnectionObservation | null> {
  const namespace = namespaceResource.metadata.name;
  const deadline = Math.min(
    Date.now() + 30_000,
    Date.parse(claim.leaseExpiresAt) - 1000,
  );
  const check = () => {
    authorized();
    if (Date.now() >= deadline) throw new Error("native_observation_deferred");
  };
  const read = authorizedRead(api, check);
  const service = await read("Service", namespace, "database-rw");
  const clusterUid = cluster.metadata.uid;
  if (
    !clusterUid ||
    !uid.test(clusterUid) ||
    cluster.status?.writeService !== "database-rw" ||
    !namespaceResource.metadata.uid ||
    !uid.test(namespaceResource.metadata.uid) ||
    !identity(service, "Service", "database-rw", namespace) ||
    !owner(
      service,
      "Cluster",
      "database",
      clusterUid,
      "postgresql.cnpg.io/v1",
    ) ||
    service.metadata.labels?.["cnpg.io/cluster"] !== "database" ||
    service.spec?.type !== "ClusterIP" ||
    typeof service.spec.clusterIP !== "string" ||
    isIP(service.spec.clusterIP) === 0 ||
    service.spec.publishNotReadyAddresses === true ||
    !equal(service.spec.selector, {
      "cnpg.io/cluster": "database",
      "cnpg.io/instanceRole": "primary",
    }) ||
    !Array.isArray(service.spec.ports) ||
    service.spec.ports.length !== 1
  )
    throw new Error("native_service_identity_unproven");
  const port = service.spec.ports[0] as Record<string, unknown>;
  if (
    port.name !== "postgres" ||
    port.protocol !== "TCP" ||
    port.port !== 5432 ||
    port.targetPort !== 5432 ||
    Object.hasOwn(port, "nodePort")
  )
    throw new Error("native_service_identity_unproven");
  const candidates = pods.filter(
    (pod) => pod.metadata.name === cluster.status?.currentPrimary,
  );
  if (candidates.length !== 1) return null;
  const primary = candidates[0]!;
  if (
    !identity(primary, "Pod", primary.metadata.name, namespace) ||
    !owner(
      primary,
      "Cluster",
      "database",
      clusterUid,
      "postgresql.cnpg.io/v1",
    ) ||
    primary.metadata.labels?.["cnpg.io/cluster"] !== "database" ||
    primary.metadata.labels?.["cnpg.io/podRole"] !== "instance" ||
    primary.metadata.labels?.["cnpg.io/instanceRole"] !== "primary" ||
    primary.status?.phase !== "Running" ||
    !primary.status.conditions?.some(
      (condition) => condition.type === "Ready" && condition.status === "True",
    ) ||
    typeof primary.status.podIP !== "string" ||
    isIP(primary.status.podIP) === 0
  )
    return null;
  check();
  const slices = await api.listEndpointSlices!(
    namespace,
    service.metadata.name,
  );
  check();
  if (slices.length !== 1) return null;
  const slice = slices[0]!;
  if (
    !identity(slice, "EndpointSlice", slice.metadata.name, namespace) ||
    !owner(slice, "Service", "database-rw", service.metadata.uid!, "v1") ||
    slice.metadata.labels?.["kubernetes.io/service-name"] !== "database-rw" ||
    slice.metadata.labels?.["endpointslice.kubernetes.io/managed-by"] !==
      "endpointslice-controller.k8s.io" ||
    slice.addressType !==
      (isIP(primary.status.podIP) === 4 ? "IPv4" : "IPv6") ||
    !equal(slice.ports, [{ name: "postgres", protocol: "TCP", port: 5432 }]) ||
    slice.endpoints?.length !== 1
  )
    throw new Error("native_service_identity_unproven");
  const endpoint = slice.endpoints[0]!;
  const target = endpoint.targetRef;
  if (
    !equal(endpoint.addresses, [primary.status.podIP]) ||
    endpoint.conditions?.ready !== true ||
    endpoint.conditions.serving === false ||
    endpoint.conditions.terminating === true ||
    !target ||
    !Object.keys(target).every((key) =>
      ["apiVersion", "kind", "namespace", "name", "uid"].includes(key),
    ) ||
    (target.apiVersion !== undefined && target.apiVersion !== "v1") ||
    target.kind !== "Pod" ||
    target.name !== primary.metadata.name ||
    target.namespace !== namespace ||
    target.uid !== primary.metadata.uid
  )
    throw new Error("native_service_identity_unproven");
  const names = cluster.status?.certificates;
  if (
    !names ||
    !dns.test(names.serverCASecret ?? "") ||
    !dns.test(names.serverTLSSecret ?? "")
  )
    return null;
  const readCertificate = async (name: string, key: "ca.crt" | "tls.crt") => {
    check();
    const value = await api.readPublicCertificate!(namespace, name, key);
    check();
    return value;
  };
  const ca = await readCertificate(names.serverCASecret!, "ca.crt"),
    server = await readCertificate(names.serverTLSSecret!, "tls.crt");
  if (
    !identity(ca, "Secret", names.serverCASecret!, namespace) ||
    !identity(server, "Secret", names.serverTLSSecret!, namespace) ||
    !owner(ca, "Cluster", "database", clusterUid, "postgresql.cnpg.io/v1") ||
    !owner(server, "Cluster", "database", clusterUid, "postgresql.cnpg.io/v1")
  )
    throw new Error("native_tls_identity_unproven");
  const host = `${service.metadata.name}.${namespace}.svc`;
  const tls = certificates(ca, server, host);
  const current = async () => {
    const ns = await read("Namespace", "", namespace),
      clusterNow = await read("Cluster", namespace, "database"),
      serviceNow = await read("Service", namespace, "database-rw"),
      primaryNow = await read("Pod", namespace, primary.metadata.name),
      clientNs = await read("Namespace", "", binding.profile.namespace),
      clientSa = await read(
        "ServiceAccount",
        binding.profile.namespace,
        binding.profile.serviceAccount,
      );
    const caNow = await readCertificate(names.serverCASecret!, "ca.crt"),
      serverNow = await readCertificate(names.serverTLSSecret!, "tls.crt");
    check();
    const slicesNow = await api.listEndpointSlices!(namespace, "database-rw");
    check();
    return (
      same(namespaceResource, ns) &&
      same(cluster, clusterNow) &&
      same(service, serviceNow) &&
      same(primary, primaryNow) &&
      same(binding.namespace, clientNs) &&
      same(binding.serviceAccount, clientSa) &&
      clientNs?.metadata.labels?.[marker] === binding.profile.namespaceUid &&
      same(ca, caNow) &&
      same(server, serverNow) &&
      slicesNow.length === 1 &&
      same(slice, slicesNow[0] ?? null)
    );
  };
  if (!(await current())) return null;
  const desired: Resource = {
    apiVersion: "cilium.io/v2",
    kind: "CiliumNetworkPolicy",
    metadata: {
      name: "native-client-access",
      namespace,
      labels: {
        "app.kubernetes.io/managed-by": "cloudflare-postgres",
        "pgcf.io/environment-id": claim.environmentId,
        "pgcf.io/region-id": claim.regionId,
      },
      annotations: {
        "pgcf.io/spec-hash": claim.specHash,
        "pgcf.io/native-client-profile": binding.profile.id,
        "pgcf.io/native-client-namespace-uid": binding.profile.namespaceUid,
        "pgcf.io/native-client-sa-uid": binding.profile.serviceAccountUid,
      },
      ownerReferences: [
        {
          apiVersion: "postgresql.cnpg.io/v1",
          kind: "Cluster",
          name: "database",
          uid: clusterUid,
          controller: true,
        },
      ],
    },
    spec: {
      endpointSelector: {
        matchLabels: {
          "cnpg.io/cluster": "database",
          "cnpg.io/podRole": "instance",
        },
      },
      ingress: [
        {
          fromEndpoints: [
            {
              matchLabels: {
                "k8s:io.kubernetes.pod.namespace": binding.profile.namespace,
                "k8s:io.cilium.k8s.policy.serviceaccount":
                  binding.profile.serviceAccount,
                [`k8s:io.cilium.k8s.namespace.labels.${marker}`]:
                  binding.profile.namespaceUid,
              },
            },
          ],
          toPorts: [{ ports: [{ port: "5432", protocol: "TCP" }] }],
        },
      ],
    },
  };
  let policy = await read(
    "CiliumNetworkPolicy",
    namespace,
    desired.metadata.name,
  );
  if (!policy) {
    if (!(await current())) return null;
    check();
    try {
      policy = await api.create(desired);
    } catch {
      policy = await read(
        "CiliumNetworkPolicy",
        namespace,
        desired.metadata.name,
      );
      if (!policy) throw new Error("native_policy_create_unconfirmed");
    }
    check();
  }
  if (
    !policy.metadata.uid ||
    !uid.test(policy.metadata.uid) ||
    !policy.metadata.resourceVersion ||
    policy.metadata.deletionTimestamp ||
    policy.kind !== desired.kind ||
    policy.apiVersion !== desired.apiVersion ||
    policy.metadata.name !== desired.metadata.name ||
    policy.metadata.namespace !== namespace ||
    !equal(policy.spec, desired.spec) ||
    !equal(policy.metadata.ownerReferences, desired.metadata.ownerReferences) ||
    !Object.entries(desired.metadata.labels!).every(
      ([key, value]) => policy!.metadata.labels?.[key] === value,
    ) ||
    !Object.entries(desired.metadata.annotations!).every(
      ([key, value]) => policy!.metadata.annotations?.[key] === value,
    )
  )
    throw new Error("native_policy_identity_unproven");
  const policyNow = await read(
    "CiliumNetworkPolicy",
    namespace,
    desired.metadata.name,
  );
  if (!same(policy, policyNow) || !(await current())) return null;
  check();
  return {
    version: 1,
    visibility: "private",
    mode: "direct",
    clientProfileId: binding.profile.id,
    namespaceUid: namespaceResource.metadata.uid!,
    clusterUid,
    clusterGeneration: cluster.metadata.generation!,
    specHash: claim.specHash,
    serviceUid: service.metadata.uid!,
    serviceResourceVersion: service.metadata.resourceVersion!,
    primaryPodUid: primary.metadata.uid!,
    endpointSliceUid: slice.metadata.uid!,
    policyUid: policy.metadata.uid,
    host,
    port: 5432,
    ...tls,
    observedAt: new Date().toISOString(),
  };
}

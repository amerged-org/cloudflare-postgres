// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { ReconcileError } from "./types.ts";
import type {
  Claim,
  Kubernetes,
  Observation,
  RegionalConfig,
  Resource,
} from "./types.ts";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const dnsLabel = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const secretKey = /^[-._a-zA-Z0-9]+$/;
const ownerLabel = "pgcf.io/environment-id";
const regionLabel = "pgcf.io/region-id";
const specAnnotation = "pgcf.io/spec-hash";
const managedLabel = "app.kubernetes.io/managed-by";

function positive(value: number, max: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= max;
}

function cpuQuantity(milli: number): string {
  if (milli % 1000 !== 0) return `${milli}m`;
  let value = milli / 1000;
  let unit = 0;
  const units = ["", "k", "M"];
  while (value % 1000 === 0 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value}${units[unit]}`;
}

function binaryQuantity(mebibytes: number): string {
  let value = mebibytes;
  let unit = 0;
  const units = ["Mi", "Gi", "Ti", "Pi"];
  while (value % 1024 === 0 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value}${units[unit]}`;
}

function validate(claim: Claim, config: RegionalConfig): void {
  const spec = claim.spec;
  const profile = spec?.profile;
  const storage = profile?.storage;
  const ref = profile?.backup?.credentialSecret;
  if (
    claim.kind !== "environment.create" ||
    claim.specRevision !== 1 ||
    !uuid.test(claim.environmentId) ||
    !uuid.test(claim.regionId) ||
    spec?.regionId !== claim.regionId ||
    spec?.profileId !== profile?.id ||
    !/^[a-f0-9]{64}$/.test(claim.specHash) ||
    createHash("sha256").update(JSON.stringify(spec)).digest("hex") !==
      claim.specHash ||
    !/^[a-zA-Z0-9./_:-]+@sha256:[a-f0-9]{64}$/.test(
      profile?.postgresImage ?? "",
    ) ||
    !positive(profile?.instances, 32) ||
    !positive(profile?.compute?.cpuMilli, 1_000_000) ||
    !positive(profile?.compute?.memoryMiB, 1_048_576) ||
    !positive(spec?.volumeGiB, 1_048_576) ||
    !positive(storage?.minGiB, 1_048_576) ||
    !positive(storage?.maxGiB, 1_048_576) ||
    !positive(storage?.stepGiB, 1_048_576) ||
    spec.volumeGiB < storage.minGiB ||
    spec.volumeGiB > storage.maxGiB ||
    (spec.volumeGiB - storage.minGiB) % storage.stepGiB !== 0 ||
    !dnsLabel.test(storage?.storageClassName ?? "") ||
    !dnsLabel.test(config.operatorNamespace) ||
    Object.keys(config.operatorPodLabels).length === 0 ||
    !ref ||
    !dnsLabel.test(ref.namespace) ||
    !dnsLabel.test(ref.name) ||
    !secretKey.test(ref.accessKeyIdKey) ||
    !secretKey.test(ref.secretAccessKeyKey) ||
    !config.allowedBackupSecrets.some(
      (allowed) =>
        allowed.namespace === ref.namespace &&
        allowed.name === ref.name &&
        allowed.accessKeyIdKey === ref.accessKeyIdKey &&
        allowed.secretAccessKeyKey === ref.secretAccessKeyKey,
    ) ||
    !/^s3:\/\/[a-z0-9][a-z0-9.-]*(?:\/[a-zA-Z0-9/._-]*)?$/.test(
      profile.backup.destinationPath,
    ) ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(profile.backup.region) ||
    !/^[1-9][0-9]*[dwm]$/.test(profile.backup.retentionPolicy)
  )
    throw new ReconcileError("spec_conflict");
  let endpoint: URL;
  try {
    endpoint = new URL(profile.backup.endpointURL);
  } catch {
    throw new ReconcileError("spec_conflict");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.port ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/"
  ) {
    throw new ReconcileError("spec_conflict");
  }
}

function own(resource: Resource, expected: Resource): void {
  if (
    resource.metadata.deletionTimestamp ||
    resource.metadata.labels?.[managedLabel] !== "cloudflare-postgres" ||
    resource.metadata.labels?.[ownerLabel] !==
      expected.metadata.labels?.[ownerLabel] ||
    resource.metadata.labels?.[regionLabel] !==
      expected.metadata.labels?.[regionLabel]
  )
    throw new ReconcileError("ownership_mismatch");
  if (
    resource.metadata.annotations?.[specAnnotation] !==
    expected.metadata.annotations?.[specAnnotation]
  ) {
    throw new ReconcileError("spec_conflict");
  }
}

// Compare only the fields this controller owns: API defaulted fields belong to
// Kubernetes or CNPG and must not be mistaken for another desired configuration.
function contains(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, i) => contains(actual[i], value))
    );
  if (expected !== null && typeof expected === "object") {
    return (
      actual !== null &&
      typeof actual === "object" &&
      Object.entries(expected).every(([key, value]) =>
        contains((actual as Record<string, unknown>)[key], value),
      )
    );
  }
  return actual === expected;
}

async function ensure(
  api: Kubernetes,
  resource: Resource,
  authorized: () => void,
): Promise<Resource> {
  const ns = resource.metadata.namespace ?? "";
  let current = await api.read(resource.kind, ns, resource.metadata.name);
  if (!current) {
    authorized();
    try {
      current = await api.create(resource);
    } catch {
      // A timeout may follow a committed create. Read the stable resource name
      // before any retry. A failed read leaves the operation leased for reclaim.
      current = await api.read(resource.kind, ns, resource.metadata.name);
      if (!current) throw new Error("unconfirmed_create");
    }
  }
  own(current, resource);
  if (
    !contains(current.metadata.labels, resource.metadata.labels) ||
    (resource.spec !== undefined && !contains(current.spec, resource.spec)) ||
    (resource.data !== undefined && !contains(current.data, resource.data))
  ) {
    throw new ReconcileError("spec_conflict");
  }
  return current;
}

export async function reconcileEnvironment(
  api: Kubernetes,
  claim: Claim,
  config: RegionalConfig,
  authorized: () => void = () => {},
): Promise<{ ready: boolean; observation?: Observation }> {
  validate(claim, config);
  authorized();
  const namespace = `pgcf-${claim.environmentId.replaceAll("-", "")}`;
  const profile = claim.spec.profile;
  const labels = {
    [managedLabel]: "cloudflare-postgres",
    [ownerLabel]: claim.environmentId,
    [regionLabel]: claim.regionId,
  };
  const metadata = (name: string, namespaced = true): Resource["metadata"] => ({
    name,
    ...(namespaced ? { namespace } : {}),
    labels,
    annotations: { [specAnnotation]: claim.specHash },
  });
  await ensure(
    api,
    {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        ...metadata(namespace, false),
        labels: {
          ...labels,
          "pod-security.kubernetes.io/enforce": "restricted",
          "pod-security.kubernetes.io/enforce-version": "latest",
        },
      },
    },
    authorized,
  );
  // Reserve one additional instance slot for CNPG initialization/maintenance;
  // this is a hard namespace ceiling, not a claim of spare fleet capacity.
  const slots = profile.instances + 1;
  await ensure(
    api,
    {
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: metadata("database-resources"),
      spec: {
        hard: {
          "requests.cpu": cpuQuantity(slots * (profile.compute.cpuMilli + 25)),
          "limits.cpu": cpuQuantity(slots * (profile.compute.cpuMilli + 100)),
          "requests.memory": binaryQuantity(
            slots * (profile.compute.memoryMiB + 64),
          ),
          "limits.memory": binaryQuantity(
            slots * (profile.compute.memoryMiB + 128),
          ),
          "requests.storage": binaryQuantity(
            slots * claim.spec.volumeGiB * 1024,
          ),
          persistentvolumeclaims: String(slots),
          pods: String(slots),
        },
      },
    },
    authorized,
  );
  await ensure(
    api,
    {
      apiVersion: "v1",
      kind: "LimitRange",
      metadata: metadata("container-defaults"),
      spec: {
        limits: [
          {
            type: "Container",
            defaultRequest: { cpu: "25m", memory: "64Mi" },
            default: { cpu: "100m", memory: "128Mi" },
          },
        ],
      },
    },
    authorized,
  );
  await ensure(
    api,
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: metadata("default-deny"),
      spec: {
        podSelector: {},
        policyTypes: ["Ingress", "Egress"],
      },
    },
    authorized,
  );
  const databaseSelector = {
    "cnpg.io/cluster": "database",
    "k8s:io.kubernetes.pod.namespace": namespace,
  };
  const databasePorts = [
    { port: "5432", protocol: "TCP" },
    { port: "8000", protocol: "TCP" },
  ];
  await ensure(
    api,
    {
      apiVersion: "cilium.io/v2",
      kind: "CiliumNetworkPolicy",
      metadata: metadata("database-boundaries"),
      spec: {
        endpointSelector: { matchLabels: { "cnpg.io/cluster": "database" } },
        ingress: [
          {
            fromEndpoints: [{ matchLabels: databaseSelector }],
            toPorts: [{ ports: databasePorts }],
          },
          {
            fromEndpoints: [
              {
                matchLabels: {
                  ...config.operatorPodLabels,
                  "k8s:io.kubernetes.pod.namespace": config.operatorNamespace,
                },
              },
            ],
            toPorts: [{ ports: [{ port: "8000", protocol: "TCP" }] }],
          },
        ],
        egress: [
          {
            toEndpoints: [{ matchLabels: databaseSelector }],
            toPorts: [{ ports: databasePorts }],
          },
          {
            toEndpoints: [
              {
                matchLabels: {
                  "k8s:io.kubernetes.pod.namespace": "kube-system",
                  "k8s:k8s-app": "kube-dns",
                },
              },
            ],
            toPorts: [
              {
                ports: [
                  { port: "53", protocol: "UDP" },
                  { port: "53", protocol: "TCP" },
                ],
                rules: { dns: [{ matchPattern: "*" }] },
              },
            ],
          },
          {
            toEntities: ["kube-apiserver"],
            toPorts: [
              {
                ports: [
                  { port: "443", protocol: "TCP" },
                  { port: "6443", protocol: "TCP" },
                ],
              },
            ],
          },
          {
            toFQDNs: [
              { matchName: new URL(profile.backup.endpointURL).hostname },
            ],
            toPorts: [{ ports: [{ port: "443", protocol: "TCP" }] }],
          },
        ],
      },
    },
    authorized,
  );
  const ref = profile.backup.credentialSecret;
  authorized();
  const source = await api.readSecret(ref.namespace, ref.name);
  const accessKeyId = source[ref.accessKeyIdKey];
  const secretAccessKey = source[ref.secretAccessKeyKey];
  if (!accessKeyId || !secretAccessKey)
    throw new ReconcileError("spec_conflict");
  await ensure(
    api,
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: metadata("archive-credentials"),
      data: {
        accessKeyId,
        secretAccessKey,
        region: Buffer.from(profile.backup.region, "utf8").toString("base64"),
      },
    },
    authorized,
  );
  await ensure(
    api,
    {
      apiVersion: "barmancloud.cnpg.io/v1",
      kind: "ObjectStore",
      metadata: metadata("archive"),
      spec: {
        configuration: {
          destinationPath: `${profile.backup.destinationPath.replace(/\/+$/, "")}/${claim.environmentId}/`,
          endpointURL: profile.backup.endpointURL,
          s3Credentials: {
            region: { name: "archive-credentials", key: "region" },
            accessKeyId: { name: "archive-credentials", key: "accessKeyId" },
            secretAccessKey: {
              name: "archive-credentials",
              key: "secretAccessKey",
            },
          },
          wal: { compression: "gzip" },
          data: { compression: "gzip" },
        },
        retentionPolicy: profile.backup.retentionPolicy,
        instanceSidecarConfiguration: {
          resources: {
            requests: { cpu: "25m", memory: "64Mi" },
            limits: { cpu: "100m", memory: "128Mi" },
          },
        },
      },
    },
    authorized,
  );
  const compute = {
    cpu: cpuQuantity(profile.compute.cpuMilli),
    memory: binaryQuantity(profile.compute.memoryMiB),
  };
  const cluster = await ensure(
    api,
    {
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "Cluster",
      metadata: metadata("database"),
      spec: {
        instances: profile.instances,
        imageName: profile.postgresImage,
        enableSuperuserAccess: false,
        bootstrap: {
          initdb: { database: "app", owner: "app", dataChecksums: true },
        },
        storage: {
          size: `${claim.spec.volumeGiB}Gi`,
          storageClass: profile.storage.storageClassName,
        },
        resources: { requests: compute, limits: compute },
        seccompProfile: { type: "RuntimeDefault" },
        plugins: [
          {
            name: "barman-cloud.cloudnative-pg.io",
            isWALArchiver: true,
            parameters: { barmanObjectName: "archive", serverName: "database" },
          },
        ],
      },
    },
    authorized,
  );
  authorized();
  const readyCondition = (resource: Resource): boolean =>
    resource.status?.conditions?.some(
      (condition) =>
        condition.type === "Ready" &&
        condition.status === "True" &&
        (condition.observedGeneration === undefined ||
          condition.observedGeneration === resource.metadata.generation),
    ) === true;
  if (
    !readyCondition(cluster) ||
    !cluster.metadata.uid ||
    !cluster.metadata.generation ||
    (cluster.status?.readyInstances ?? 0) < profile.instances
  )
    return { ready: false };
  const pods = await api.listPods(namespace, "database");
  const readyPods = pods.filter(
    (pod) =>
      !pod.metadata.deletionTimestamp &&
      pod.metadata.labels?.["cnpg.io/podRole"] === "instance" &&
      pod.metadata.ownerReferences?.some(
        (owner) =>
          owner.kind === "Cluster" &&
          owner.uid === cluster.metadata.uid &&
          owner.controller === true,
      ) &&
      pod.status?.phase === "Running" &&
      readyCondition(pod),
  );
  if (
    readyPods.length < profile.instances ||
    !readyPods.some(
      (pod) => pod.metadata.name === cluster.status?.currentPrimary,
    )
  ) {
    return { ready: false };
  }
  // Do not report Pods observed for a Cluster that was replaced or revised
  // while listing them. Preserve the real Kubernetes UID and generation.
  const latest = await api.read("Cluster", namespace, "database");
  if (!latest) return { ready: false };
  own(latest, cluster);
  if (
    latest.metadata.uid !== cluster.metadata.uid ||
    latest.metadata.generation !== cluster.metadata.generation ||
    latest.status?.currentPrimary !== cluster.status?.currentPrimary ||
    !readyCondition(latest) ||
    (latest.status?.readyInstances ?? 0) < profile.instances
  )
    return { ready: false };
  return {
    ready: true,
    observation: {
      clusterUid: cluster.metadata.uid,
      clusterGeneration: cluster.metadata.generation,
      readyInstances: readyPods.length,
    },
  };
}

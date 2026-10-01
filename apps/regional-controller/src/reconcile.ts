// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import {
  BARMAN_RESOURCES,
  cpuQuantity,
  binaryQuantity,
  provisioningResourceEnvelope,
} from "@cloudflare-postgres/resource-envelope";
import { ReconcileError } from "./types.ts";
import { observePooler, validPoolingPolicy } from "./pooling.ts";
import { RUN_EPOCH_ANNOTATION, validRunEpoch } from "./run-epoch.ts";
import {
  prepareNativeClient,
  reconcileNativeAccess,
  validNativeAccess,
  type NativeAccessDeferral,
} from "./native-access.ts";
import {
  BIRTH_ANNOTATION,
  prepareNodeBirth,
  COHORT_HASH_ANNOTATION,
  COHORT_UID_ANNOTATION,
  ensureNodeCohort,
  inspectNodeCohort,
  nodeCohortAffinity,
  nodeCohortAnnotationsMatch,
  nodesMatchCohort,
  validNodeTrackingPolicy,
} from "./node-cohort.ts";
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

function validate(claim: Claim, config: RegionalConfig): void {
  const spec = claim.spec;
  const profile = spec?.profile;
  const storage = profile?.storage;
  const ref = profile?.backup?.credentialSecret;
  const fenced = Object.hasOwn(profile ?? {}, "executionFencing");
  const fencing = profile?.executionFencing;
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
    (profile?.pooling !== undefined && !validPoolingPolicy(profile.pooling)) ||
    (Object.hasOwn(profile ?? {}, "nativeAccess") &&
      !validNativeAccess(profile.nativeAccess)) ||
    fenced !== Object.hasOwn(claim, "runEpoch") ||
    (fenced &&
      (fencing === null ||
        typeof fencing !== "object" ||
        Array.isArray(fencing) ||
        Object.keys(fencing).length !== 1 ||
        fencing.version !== 1 ||
        !validRunEpoch(claim.runEpoch) ||
        claim.runEpoch !== "1")) ||
    (Object.hasOwn(profile ?? {}, "nodeTracking") &&
      (!fenced || !validNodeTrackingPolicy(profile?.nodeTracking))) ||
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
  if (expected.metadata.ownerReferences) {
    const expectedOwner = expected.metadata.ownerReferences[0];
    const owners = resource.metadata.ownerReferences?.filter(
      (owner) => owner.controller === true,
    );
    if (
      !expectedOwner ||
      owners?.length !== 1 ||
      owners[0]?.uid !== expectedOwner.uid ||
      owners[0]?.kind !== expectedOwner.kind ||
      owners[0]?.name !== expectedOwner.name ||
      owners[0]?.apiVersion !== expectedOwner.apiVersion
    )
      throw new ReconcileError("ownership_mismatch");
  }
  if (
    resource.metadata.annotations?.[specAnnotation] !==
    expected.metadata.annotations?.[specAnnotation]
  ) {
    throw new ReconcileError("spec_conflict");
  }
  if (
    ["Namespace", "ResourceQuota", "Cluster", "Pooler"].includes(expected.kind)
  ) {
    const expectedAnnotations = expected.metadata.annotations ?? {};
    const annotations = resource.metadata.annotations ?? {};
    if (
      Object.hasOwn(expectedAnnotations, RUN_EPOCH_ANNOTATION) !==
        Object.hasOwn(annotations, RUN_EPOCH_ANNOTATION) ||
      annotations[RUN_EPOCH_ANNOTATION] !==
        expectedAnnotations[RUN_EPOCH_ANNOTATION]
    )
      throw new ReconcileError("spec_conflict");
  }
  const annotations = expected.metadata.annotations ?? {};
  const cohortPointer = Object.keys(annotations).some((key) =>
    key.startsWith("pgcf.io/node-cohort-"),
  )
    ? {
        uid: annotations[COHORT_UID_ANNOTATION] ?? "",
        hash: annotations[COHORT_HASH_ANNOTATION] ?? "",
      }
    : undefined;
  if (!nodeCohortAnnotationsMatch(resource, cohortPointer))
    throw new ReconcileError("spec_conflict");
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

export interface ProvisioningCapacityStages {
  podQuota: () => string;
  beforeCluster: () => Promise<void>;
  cluster: (resource: Resource) => Promise<boolean>;
  pooler: (resource: Resource) => Promise<void>;
  ready: (observation: Observation) => Promise<void>;
}
export async function reconcileEnvironment(
  api: Kubernetes,
  claim: Claim,
  config: RegionalConfig,
  authorized: () => void = () => {},
  nativeDiagnostic: (category: NativeAccessDeferral) => void = () => {},
  capacity?: ProvisioningCapacityStages,
): Promise<{ ready: boolean; observation?: Observation }> {
  validate(claim, config);
  authorized();
  const nativeClient = await prepareNativeClient(
    api,
    claim,
    config,
    authorized,
  );
  const namespace = `pgcf-${claim.environmentId.replaceAll("-", "")}`;
  const profile = claim.spec.profile;
  const pooling = profile.pooling;
  const tracked = profile.nodeTracking !== undefined;
  let cohort: Awaited<ReturnType<typeof ensureNodeCohort>> | null = null;
  if (tracked && !config.nodeTrackingJournalPath)
    throw new Error("node_cohort_configuration_unavailable");
  const birth = tracked
    ? await prepareNodeBirth(
        api,
        claim,
        config.nodeTrackingJournalPath!,
        namespace,
        authorized,
      )
    : null;
  const labels = {
    [managedLabel]: "cloudflare-postgres",
    [ownerLabel]: claim.environmentId,
    [regionLabel]: claim.regionId,
  };
  const metadata = (
    name: string,
    namespaced = true,
    withRunEpoch = false,
    withCohort = false,
  ): Resource["metadata"] => ({
    name,
    ...(namespaced ? { namespace } : {}),
    labels,
    annotations: {
      [specAnnotation]: claim.specHash,
      ...(withRunEpoch && claim.runEpoch !== undefined
        ? { [RUN_EPOCH_ANNOTATION]: claim.runEpoch }
        : {}),
      ...(withCohort && cohort
        ? {
            [COHORT_UID_ANNOTATION]: cohort.pointer.uid,
            [COHORT_HASH_ANNOTATION]: cohort.pointer.hash,
          }
        : {}),
    },
  });
  const ownedNamespace = await ensure(
    api,
    {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        ...metadata(namespace, false, true),
        ...(birth
          ? {
              annotations: {
                ...metadata(namespace, false, true).annotations,
                [BIRTH_ANNOTATION]: birth.birthId,
              },
            }
          : {}),
        labels: {
          ...labels,
          "pod-security.kubernetes.io/enforce": "restricted",
          "pod-security.kubernetes.io/enforce-version": "latest",
        },
      },
    },
    authorized,
  );
  const cohortBinding = {
    environmentId: claim.environmentId,
    regionId: claim.regionId,
    specHash: claim.specHash,
    runEpoch: claim.runEpoch,
    namespace,
    namespaceUid: ownedNamespace.metadata.uid ?? "",
  };
  if (
    birth &&
    ownedNamespace.metadata.annotations?.[BIRTH_ANNOTATION] !== birth.birthId
  )
    throw new Error("node_birth_namespace_changed");
  if (tracked)
    cohort = await ensureNodeCohort(
      api,
      cohortBinding,
      authorized,
      birth!,
      config.nodeTrackingJournalPath!,
    );
  const verifyCohort = async () => {
    if (!cohort) return;
    authorized();
    const currentNamespace = await api.read("Namespace", "", namespace);
    authorized();
    if (
      !currentNamespace ||
      currentNamespace.metadata.uid !== ownedNamespace.metadata.uid ||
      currentNamespace.metadata.name !== namespace ||
      currentNamespace.metadata.labels?.[managedLabel] !==
        "cloudflare-postgres" ||
      currentNamespace.metadata.labels?.[ownerLabel] !== claim.environmentId ||
      currentNamespace.metadata.labels?.[regionLabel] !== claim.regionId ||
      currentNamespace.metadata.annotations?.[BIRTH_ANNOTATION] !==
        birth?.birthId ||
      currentNamespace.metadata.annotations?.[specAnnotation] !==
        claim.specHash ||
      currentNamespace.metadata.annotations?.[RUN_EPOCH_ANNOTATION] !==
        claim.runEpoch ||
      currentNamespace.metadata.deletionTimestamp
    )
      throw new Error("node_birth_namespace_changed");
    const current = await api.read("ConfigMap", namespace, "execution-nodes");
    authorized();
    if (
      !inspectNodeCohort(current, {
        ...cohortBinding,
        nodeCohort: cohort.pointer,
      })
    )
      throw new Error("node_cohort_identity_unproven");
    if (!api.listNodes)
      throw new Error("node_cohort_configuration_unavailable");
    const nodes = await api.listNodes();
    authorized();
    if (!nodesMatchCohort(cohort.data, nodes))
      throw new Error("node_cohort_birth_changed");
  };
  // Reserve one additional instance slot for CNPG initialization/maintenance;
  // this is a hard namespace ceiling, not a claim of spare fleet capacity.
  const envelope = provisioningResourceEnvelope({
    ...profile,
    volumeGiB: claim.spec.volumeGiB,
  });
  await ensure(
    api,
    {
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: metadata("database-resources", true, true),
      spec: {
        hard: {
          ...envelope.quotaHard,
          ...(capacity ? { pods: capacity.podQuota() } : {}),
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
          resources: BARMAN_RESOURCES,
        },
      },
    },
    authorized,
  );
  const compute = {
    cpu: cpuQuantity(profile.compute.cpuMilli),
    memory: binaryQuantity(profile.compute.memoryMiB),
  };
  await verifyCohort();
  if (capacity) await capacity.beforeCluster();
  const cluster = await ensure(
    api,
    {
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "Cluster",
      metadata: metadata("database", true, true, true),
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
        ...(cohort
          ? { affinity: { nodeAffinity: nodeCohortAffinity(cohort.data) } }
          : {}),
        ...(pooling
          ? {
              certificates: {
                serverAltDNSNames: [
                  "database-pool-rw",
                  `database-pool-rw.${namespace}`,
                  `database-pool-rw.${namespace}.svc`,
                ],
              },
            }
          : {}),
        plugins: [
          {
            name: "barman-cloud.cloudnative-pg.io",
            enabled: true,
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
  if (capacity && !(await capacity.cluster(cluster))) return { ready: false };
  if (
    !readyCondition(cluster) ||
    !cluster.metadata.uid ||
    !cluster.metadata.generation ||
    (cluster.status?.readyInstances ?? 0) < profile.instances
  )
    return { ready: false };
  await verifyCohort();
  const pooler = pooling
    ? await ensure(
        api,
        {
          apiVersion: "postgresql.cnpg.io/v1",
          kind: "Pooler",
          metadata: {
            ...metadata("database-pool-rw", true, true, true),
            ownerReferences: [
              {
                apiVersion: "postgresql.cnpg.io/v1",
                kind: "Cluster",
                name: "database",
                uid: cluster.metadata.uid,
                controller: true,
              },
            ],
          },
          spec: {
            cluster: { name: "database" },
            instances: 1,
            deploymentStrategy: { type: "Recreate" },
            pgbouncer: {
              image: pooling.image,
              poolMode: "session",
              paused: false,
              parameters: {
                client_tls_sslmode: "require",
                server_tls_sslmode: "verify-full",
                max_client_conn: String(pooling.connections.maxClients),
                default_pool_size: String(pooling.connections.poolSize),
                reserve_pool_size: "0",
                max_db_connections: String(
                  pooling.connections.maxDatabaseConnections,
                ),
                max_user_connections: String(
                  pooling.connections.maxUserConnections,
                ),
                query_wait_timeout: String(pooling.timeouts.queryWaitSeconds),
                server_connect_timeout: String(pooling.timeouts.connectSeconds),
                cancel_wait_timeout: String(pooling.timeouts.cancelWaitSeconds),
              },
            },
            template: {
              metadata: {
                labels: {
                  [ownerLabel]: claim.environmentId,
                  [regionLabel]: claim.regionId,
                },
                annotations: { [specAnnotation]: claim.specHash },
              },
              spec: {
                ...(cohort
                  ? {
                      affinity: {
                        nodeAffinity: nodeCohortAffinity(cohort.data),
                      },
                    }
                  : {}),
                containers: [
                  {
                    name: "pgbouncer",
                    image: pooling.image,
                    resources: {
                      requests: {
                        cpu: cpuQuantity(pooling.compute.requests.cpuMilli),
                        memory: binaryQuantity(
                          pooling.compute.requests.memoryMiB,
                        ),
                      },
                      limits: {
                        cpu: cpuQuantity(pooling.compute.limits.cpuMilli),
                        memory: binaryQuantity(
                          pooling.compute.limits.memoryMiB,
                        ),
                      },
                    },
                  },
                ],
                initContainers: [
                  {
                    name: "bootstrap-controller",
                    resources: {
                      requests: {
                        cpu: cpuQuantity(pooling.compute.requests.cpuMilli),
                        memory: binaryQuantity(
                          pooling.compute.requests.memoryMiB,
                        ),
                      },
                      limits: {
                        cpu: cpuQuantity(pooling.compute.limits.cpuMilli),
                        memory: binaryQuantity(
                          pooling.compute.limits.memoryMiB,
                        ),
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        authorized,
      )
    : null;
  const pods = await api.listPods(namespace, "database");
  if (
    cohort &&
    pods.some(
      (pod) =>
        (pod.status?.phase === "Running" &&
          typeof pod.spec?.nodeName !== "string") ||
        (pod.spec?.nodeName !== undefined &&
          !cohort!.data.nodes.some((node) => node.name === pod.spec!.nodeName)),
    )
  )
    throw new Error("node_cohort_placement_unproven");
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
  if (capacity && pooler) await capacity.pooler(pooler);
  const poolerObservation =
    pooling && pooler
      ? await observePooler(api, pooler, cluster, pooling, pods, authorized)
      : null;
  if (pooling && !poolerObservation) return { ready: false };
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
  await verifyCohort();
  const nativeConnection = nativeClient
    ? await reconcileNativeAccess(
        api,
        claim,
        latest,
        ownedNamespace,
        readyPods,
        nativeClient,
        authorized,
        nativeDiagnostic,
      )
    : null;
  if (nativeClient && !nativeConnection) return { ready: false };
  const observation: Observation = {
    clusterUid: cluster.metadata.uid,
    clusterGeneration: cluster.metadata.generation,
    readyInstances: readyPods.length,
    ...(nativeConnection ? { nativeConnection } : {}),
    ...(claim.runEpoch === undefined ? {} : { runEpoch: claim.runEpoch }),
    ...(cohort ? { nodeCohort: { ...cohort.pointer } } : {}),
    ...(poolerObservation ? { pooler: poolerObservation } : {}),
  };
  if (capacity) await capacity.ready(observation);
  authorized();
  return { ready: true, observation };
}

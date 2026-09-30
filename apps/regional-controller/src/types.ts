// SPDX-License-Identifier: Apache-2.0
import type { MeteringInventory } from "./metering-types.ts";
import type { NodeCohortPointer } from "./node-cohort.ts";
export interface BackupSecretRef {
  namespace: string;
  name: string;
  accessKeyIdKey: string;
  secretAccessKeyKey: string;
}

export interface PoolingPolicy {
  version: 1;
  image: string;
  mode: "session";
  compute: {
    requests: { cpuMilli: number; memoryMiB: number };
    limits: { cpuMilli: number; memoryMiB: number };
  };
  connections: {
    maxClients: number;
    poolSize: number;
    maxDatabaseConnections: number;
    maxUserConnections: number;
  };
  timeouts: {
    queryWaitSeconds: number;
    connectSeconds: number;
    cancelWaitSeconds: number;
  };
}

export interface NativeAccessPolicy {
  version: 1;
  clientProfileId: string;
}
export interface NativeClientProfile {
  id: string;
  namespace: string;
  namespaceUid: string;
  serviceAccount: string;
  serviceAccountUid: string;
}
export interface NativeConnectionObservation {
  version: 1;
  visibility: "private";
  mode: "direct";
  clientProfileId: string;
  namespaceUid: string;
  clusterUid: string;
  clusterGeneration: number;
  specHash: string;
  serviceUid: string;
  serviceResourceVersion: string;
  primaryPodUid: string;
  endpointSliceUid: string;
  policyUid: string;
  host: string;
  port: 5432;
  caCertificate: string;
  caCertificateSha256: string;
  serverCertificateSha256: string;
  caValidFrom: string;
  caValidUntil: string;
  serverValidUntil: string;
  observedAt: string;
}

export interface ExecutionSpec {
  name: string;
  regionId: string;
  catalogVersion: string;
  profileId: string;
  volumeGiB: number;
  profile: {
    id: string;
    postgresImage: string;
    compute: { cpuMilli: number; memoryMiB: number };
    storage: {
      classId: string;
      storageClassName: string;
      minGiB: number;
      maxGiB: number;
      stepGiB: number;
    };
    instances: number;
    pooling?: PoolingPolicy;
    nativeAccess?: NativeAccessPolicy;
    executionFencing?: { version: 1 };
    nodeTracking?: { version: 1 };
    backup: {
      endpointURL: string;
      region: string;
      destinationPath: string;
      retentionPolicy: string;
      credentialSecret: BackupSecretRef;
    };
  };
}

export interface Claim {
  operationId: string;
  environmentId: string;
  regionId: string;
  kind: "environment.create";
  leaseToken: string;
  leaseEpoch: number;
  leaseExpiresAt: string;
  specRevision: 1;
  specHash: string;
  spec: ExecutionSpec;
  runEpoch?: string;
}

export interface RegionalConfig {
  nativeClientProfiles?: NativeClientProfile[];
  nodeTrackingJournalPath?: string;
  operatorNamespace: string;
  operatorPodLabels: Record<string, string>;
  allowedBackupSecrets: BackupSecretRef[];
}

export interface Resource {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    uid?: string;
    generation?: number;
    resourceVersion?: string;
    deletionTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    finalizers?: string[];
    ownerReferences?: {
      uid: string;
      kind: string;
      name?: string;
      apiVersion?: string;
      controller?: boolean;
    }[];
  };
  spec?: Record<string, unknown>;
  immutable?: boolean;
  data?: Record<string, string>;
  addressType?: string;
  ports?: { name?: string; protocol?: string; port?: number }[];
  endpoints?: {
    addresses?: string[];
    conditions?: { ready?: boolean; serving?: boolean; terminating?: boolean };
    targetRef?: {
      apiVersion?: string;
      kind?: string;
      name?: string;
      namespace?: string;
      uid?: string;
    };
  }[];
  status?: {
    podIP?: string;
    writeService?: string;
    certificates?: { serverCASecret?: string; serverTLSSecret?: string };
    nodeInfo?: { bootID?: string };
    phase?: string;
    image?: string;
    observedGeneration?: number;
    replicas?: number;
    readyReplicas?: number;
    availableReplicas?: number;
    updatedReplicas?: number;
    currentPrimary?: string;
    readyInstances?: number;
    initContainerStatuses?: {
      name: string;
      containerID?: string;
      ready?: boolean;
      restartCount?: number;
      state?: {
        terminated?: {
          exitCode?: number;
          startedAt?: string;
          finishedAt?: string;
          containerID?: string;
        };
      };
    }[];
    containerStatuses?: {
      name: string;
      containerID?: string;
      ready?: boolean;
      restartCount?: number;
      resources?: {
        requests?: Record<string, string>;
        limits?: Record<string, string>;
      };
      state?: {
        terminated?: {
          exitCode?: number;
          startedAt?: string;
          finishedAt?: string;
          containerID?: string;
        };
      };
    }[];
    capacity?: Record<string, string>;
    conditions?: {
      type: string;
      status: string;
      observedGeneration?: number;
    }[];
  };
}

export interface Kubernetes {
  read(kind: string, namespace: string, name: string): Promise<Resource | null>;
  create(
    resource: Resource,
    dispatchAuthority?: { check: () => void; expiresAt: () => number },
  ): Promise<Resource>;
  readSecret(namespace: string, name: string): Promise<Record<string, string>>;
  listPods(namespace: string, clusterName: string): Promise<Resource[]>;
  meteringInventory?(regionId: string): Promise<MeteringInventory>;
  listNodes?(): Promise<Resource[]>;
  executionPreflight?(
    namespace: string,
  ): Promise<{ pods: Resource[]; clusters: Resource[]; poolers: Resource[] }>;
  listEndpointSlices?(
    namespace: string,
    serviceName: string,
  ): Promise<Resource[]>;
  readPublicCertificate?(
    namespace: string,
    name: string,
    key: "ca.crt" | "tls.crt",
  ): Promise<Resource | null>;
}

export interface Observation {
  nativeConnection?: NativeConnectionObservation;
  clusterUid: string;
  clusterGeneration: number;
  readyInstances: number;
  runEpoch?: string;
  nodeCohort?: NodeCohortPointer;
  pooler?: {
    uid: string;
    generation: number;
    deploymentUid: string;
    readyInstances: 1;
  };
}

export type ResultCode =
  "ownership_mismatch" | "spec_conflict" | "reconcile_failed";

export class ReconcileError extends Error {
  readonly code: ResultCode;
  constructor(code: ResultCode) {
    super(code);
    this.code = code;
  }
}

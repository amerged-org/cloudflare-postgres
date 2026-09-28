// SPDX-License-Identifier: Apache-2.0
export interface BackupSecretRef {
  namespace: string;
  name: string;
  accessKeyIdKey: string;
  secretAccessKeyKey: string;
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
}

export interface RegionalConfig {
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
    deletionTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    ownerReferences?: { uid: string; kind: string; controller?: boolean }[];
  };
  spec?: Record<string, unknown>;
  data?: Record<string, string>;
  status?: {
    phase?: string;
    currentPrimary?: string;
    readyInstances?: number;
    conditions?: {
      type: string;
      status: string;
      observedGeneration?: number;
    }[];
  };
}

export interface Kubernetes {
  read(kind: string, namespace: string, name: string): Promise<Resource | null>;
  create(resource: Resource): Promise<Resource>;
  readSecret(namespace: string, name: string): Promise<Record<string, string>>;
  listPods(namespace: string, clusterName: string): Promise<Resource[]>;
}

export interface Observation {
  clusterUid: string;
  clusterGeneration: number;
  readyInstances: number;
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

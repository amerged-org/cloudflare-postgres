// SPDX-License-Identifier: Apache-2.0
import type { Resource } from "./types.ts";

export interface RoleClaim {
  schemaVersion: 1;
  kind: "database.role.apply";
  operationId: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  regionId: string;
  specRevision: number;
  specHash: string;
  clusterUid: string;
  roleId: string;
  roleName: string;
  connectionLimit: number;
  credentialRevision: number;
  password: string;
  previousPassword: string | null;
  secretName: string;
  leaseToken: string;
  leaseEpoch: number;
  leaseExpiresAt: string;
}

export interface RoleObservation {
  namespaceUid: string;
  clusterUid: string;
  roleUid: string;
  roleGeneration: number;
  roleObservedGeneration: number;
  secretUid: string;
  secretResourceVersion: string;
  roleSecretResourceVersion: string;
  authenticatedUser: string;
  authenticatedDatabase: "app";
  writablePrimary: true;
  previousCredentialRejected: true | null;
}

export interface RoleRuntime {
  read(
    kind:
      | "Namespace"
      | "Cluster"
      | "Secret"
      | "DatabaseRole"
      | "CiliumNetworkPolicy",
    namespace: string,
    name: string,
  ): Promise<Resource | null>;
  create(resource: Resource): Promise<Resource>;
  patchRole(
    namespace: string,
    name: string,
    operations: {
      op: "test" | "add" | "replace";
      path: string;
      value: unknown;
    }[],
  ): Promise<void>;
}

export interface RoleVerifier {
  verify(input: {
    host: string;
    database: "app";
    username: string;
    password: string;
    previousPassword: string | null;
    ca: string;
    deadline: number;
  }): Promise<{
    authenticatedUser: string;
    authenticatedDatabase: "app";
    writablePrimary: true;
    previousCredentialRejected: true | null;
  }>;
}

export interface RoleConfig {
  verifierNamespace: string;
  verifierPodLabels: Record<string, string>;
}

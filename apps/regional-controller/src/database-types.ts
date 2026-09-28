// SPDX-License-Identifier: Apache-2.0
import type { Resource } from "./types.ts";
import type { RoleConfig } from "./role-types.ts";

export interface DatabaseClaim {
  schemaVersion: 1;
  kind: "database.create";
  operationId: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  regionId: string;
  specRevision: number;
  specHash: string;
  namespaceUid: string;
  clusterUid: string;
  databaseId: string;
  databaseName: string;
  ownerRoleId: string;
  ownerRoleName: string;
  ownerRoleUid: string;
  ownerCredentialRevision: number;
  secretUid: string;
  secretResourceVersion: string;
  password: string;
  leaseToken: string;
  leaseEpoch: number;
  leaseExpiresAt: string;
}

export interface DatabaseObservation {
  namespaceUid: string;
  clusterUid: string;
  ownerRoleUid: string;
  ownerCredentialRevision: number;
  secretUid: string;
  secretResourceVersion: string;
  databaseUid: string;
  databaseGeneration: number;
  databaseObservedGeneration: number;
  databaseOid: string;
  authenticatedUser: string;
  authenticatedDatabase: string;
  writablePrimary: true;
  databaseOwned: true;
  schemaCreateVerified: true;
  probeRolledBack: true;
}

export interface DatabaseRuntime {
  read(
    kind:
      | "Namespace"
      | "Cluster"
      | "DatabaseRole"
      | "Secret"
      | "Database"
      | "CiliumNetworkPolicy",
    namespace: string,
    name: string,
  ): Promise<Resource | null>;
  listDatabases(namespace: string): Promise<Resource[]>;
  create(resource: Resource): Promise<Resource>;
}

export interface DatabaseVerifier {
  absent(input: {
    host: string;
    database: "app";
    targetDatabase: string;
    username: string;
    password: string;
    ca: string;
    deadline: number;
  }): Promise<boolean>;
  verify(input: {
    host: string;
    database: string;
    username: string;
    password: string;
    ca: string;
    deadline: number;
  }): Promise<
    Pick<
      DatabaseObservation,
      | "databaseOid"
      | "authenticatedUser"
      | "authenticatedDatabase"
      | "writablePrimary"
      | "databaseOwned"
      | "schemaCreateVerified"
      | "probeRolledBack"
    >
  >;
}

export type DatabaseConfig = RoleConfig;

// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  newDatabaseId,
  newOperationId,
  newRolePassword,
  archiveDestinationPath,
} from "@pgcf/contracts";
import type { DesiredDatabase, K8sObject } from "@pgcf/contracts";
import type { BuildContext } from "../../src/agent/builders/index.ts";
import { roleSecretName } from "../../src/agent/builders/index.ts";
import { DATABASE_LABEL } from "../../src/agent/observe.ts";
import { record } from "../../src/agent/types.ts";
import type { Kubernetes, Resource } from "../../src/agent/types.ts";

export function fixture(): { db: DesiredDatabase; ctx: BuildContext } {
  const id = newDatabaseId();
  const operationId = newOperationId();
  return {
    db: {
      id,
      generation: 1,
      desired_state: "running",
      node: "test-node",
      pg_major: 18,
      size: {
        memory_mib: 512,
        cpu_millicores: 500,
        storage_gib: 10,
        max_connections: 100,
        archive_timeout_seconds: 60,
        backup_retention_days: 7,
      },
      roles: [
        { name: "app", owner: true, password: newRolePassword(), revision: 1 },
      ],
      creation: {
        operation_id: operationId,
        generation: 1,
        status: "pending",
        ever_ready: false,
      },
      archive: {
        destination_path: archiveDestinationPath(
          "pgcf-backups",
          "eu-test",
          id,
          1,
          operationId,
        ),
        server_name: "database",
      },
    },
    ctx: {
      backup: {
        bucket: "pgcf-backups",
        endpointUrl: `https://${["r2", "example", "invalid"].join(".")}`,
        region: "auto",
        credentials: {
          accessKeyId: randomBytes(16).toString("hex"),
          secretAccessKey: randomBytes(32).toString("hex"),
        },
      },
      postgresImage: `ghcr.io/cloudnative-pg/postgresql@sha256:${"a".repeat(64)}`,
      systemNamespace: "pgcf-system",
      cnpgNamespace: "cnpg-system",
      storageClass: "pgcf-lvm",
      gatewaySelector: {
        namespace: "pgcf-system",
        podLabels: { "app.kubernetes.io/name": "pgcf-gateway" },
      },
      agentSelector: {
        namespace: "pgcf-system",
        podLabels: { "app.kubernetes.io/name": "pgcf-agent" },
      },
    },
  };
}

export const metrics: typeof fetch = async () =>
  new Response('cnpg_collector_pg_wal_archive_status{value="ready"} 0\n');
export const authenticate = async () => true;

export class MemoryKubernetes implements Kubernetes {
  revision = 0;
  resources = new Map<string, Resource>();
  actions: string[] = [];
  failAfter = -1;
  mutations = 0;
  autoDeleteStorage = true;
  caPresent = true;
  ready = true;
  archiving = true;
  archivingSince: string | undefined;
  failCaPublication = false;
  key(kind: string, namespace: string | undefined, name: string): string {
    return `${kind}:${namespace ?? ""}:${name}`;
  }
  put(resource: K8sObject): Resource {
    const value = {
      ...structuredClone(resource),
      metadata: {
        ...structuredClone(resource.metadata),
        uid: randomUUID(),
        resourceVersion: String(++this.revision),
      },
    } as Resource;
    this.resources.set(
      this.key(value.kind, value.metadata.namespace, value.metadata.name),
      value,
    );
    return value;
  }
  mutation(action: string): void {
    this.actions.push(action);
    this.mutations += 1;
    if (this.mutations === this.failAfter)
      throw new Error("injected_crash_after_mutation");
  }
  async read(
    kind: string,
    namespace: string | undefined,
    name: string,
  ): Promise<Resource | null> {
    return structuredClone(
      this.resources.get(this.key(kind, namespace, name)) ?? null,
    );
  }
  async list(
    kind: string,
    namespace?: string,
    labelSelector?: string,
  ): Promise<Resource[]> {
    return [...this.resources.values()]
      .filter(
        (resource) =>
          resource.kind === kind &&
          (namespace === undefined ||
            resource.metadata.namespace === namespace) &&
          (!labelSelector ||
            resource.metadata.labels?.[labelSelector] !== undefined),
      )
      .map((resource) => structuredClone(resource));
  }
  async apply(resource: K8sObject): Promise<void> {
    await this.write(resource, "apply");
  }
  async create(resource: K8sObject): Promise<void> {
    assert.equal(
      this.resources.has(
        this.key(
          resource.kind,
          resource.metadata.namespace,
          resource.metadata.name,
        ),
      ),
      false,
    );
    await this.write(resource, "create");
  }
  private async write(resource: K8sObject, verb: string): Promise<void> {
    if (
      this.failCaPublication &&
      resource.kind === "ConfigMap" &&
      resource.metadata.name.startsWith("ca-")
    )
      throw new Error("ca_publication_unavailable");
    const key = this.key(
      resource.kind,
      resource.metadata.namespace,
      resource.metadata.name,
    );
    const old = this.resources.get(key);
    const current = {
      ...structuredClone(resource),
      metadata: {
        ...structuredClone(resource.metadata),
        uid: old?.metadata.uid ?? randomUUID(),
        resourceVersion: String(++this.revision),
      },
    } as Resource;
    if (resource.kind === "Namespace") current.status = { phase: "Active" };
    if (resource.kind === "Cluster") {
      const clusterSpec = record(resource.spec);
      const managedRoles = record(clusterSpec.managed).roles;
      const roles = Array.isArray(managedRoles) ? managedRoles.map(record) : [];
      const applicationSecret = this.resources.get(
        this.key("Secret", resource.metadata.namespace, roleSecretName("app")),
      );
      current.status = {
        secretsResourceVersion: {
          applicationSecretVersion: applicationSecret?.metadata.resourceVersion,
        },
        managedRolesStatus: {
          byStatus: { reconciled: roles.map((role) => role.name) },
          passwordStatus: Object.fromEntries(
            roles.map((role) => [
              String(role.name),
              {
                resourceVersion: this.resources.get(
                  this.key(
                    "Secret",
                    resource.metadata.namespace,
                    String(record(role.passwordSecret).name),
                  ),
                )?.metadata.resourceVersion,
              },
            ]),
          ),
        },
        currentPrimary: "database-1",
        conditions: [
          { type: "Ready", status: this.ready ? "True" : "False" },
          {
            type: "ContinuousArchiving",
            status: this.archiving ? "True" : "False",
            ...(this.archivingSince
              ? { lastTransitionTime: this.archivingSince }
              : {}),
          },
        ],
        certificates: this.caPresent ? { serverCASecret: "database-ca" } : {},
      };
      this.put({
        apiVersion: "v1",
        kind: "Pod",
        metadata: {
          name: "database-1",
          namespace: resource.metadata.namespace,
          labels: { "cnpg.io/cluster": "database" },
          ...{
            ownerReferences: [
              {
                apiVersion: current.apiVersion,
                kind: "Cluster",
                name: current.metadata.name,
                uid: current.metadata.uid,
              },
            ],
          },
        },
        spec: {
          volumes: [
            {
              name: "pgdata",
              persistentVolumeClaim: { claimName: "database-1" },
            },
          ],
          nodeName: record(record(clusterSpec.affinity).nodeSelector)[
            "kubernetes.io/hostname"
          ],
          containers: [
            {
              name: "postgres",
              image: clusterSpec.imageName,
              resources: structuredClone(clusterSpec.resources),
            },
          ],
        },
        status: {
          podIP: [127, 0, 0, 1].join("."),
          conditions: [{ type: "Ready", status: "True" }],
        },
      });
      const claimKey = this.key(
        "PersistentVolumeClaim",
        resource.metadata.namespace,
        "database-1",
      );
      let claim = this.resources.get(claimKey);
      if (!claim) {
        claim = this.put({
          apiVersion: "v1",
          kind: "PersistentVolumeClaim",
          metadata: {
            name: "database-1",
            namespace: resource.metadata.namespace,
            labels: { "cnpg.io/cluster": "database" },
            ...{
              ownerReferences: [
                {
                  apiVersion: current.apiVersion,
                  kind: "Cluster",
                  name: current.metadata.name,
                  uid: current.metadata.uid,
                },
              ],
            },
          },
          spec: {
            storageClassName: "pgcf-lvm",
            resources: {
              requests: { storage: record(clusterSpec.storage).size },
            },
          },
          status: {
            phase: "Bound",
            capacity: { storage: record(clusterSpec.storage).size },
          },
        });
        const handle = `pvc-${claim.metadata.uid}`;
        record(claim.spec).volumeName = handle;
        this.put({
          apiVersion: "v1",
          kind: "PersistentVolume",
          metadata: { name: handle },
          spec: {
            storageClassName: "pgcf-lvm",
            capacity: { storage: record(clusterSpec.storage).size },
            persistentVolumeReclaimPolicy: "Retain",
            csi: { driver: "local.csi.openebs.io", volumeHandle: handle },
            claimRef: {
              namespace: claim.metadata.namespace,
              name: claim.metadata.name,
              uid: claim.metadata.uid,
            },
          },
          status: { phase: "Bound" },
        });
      }
      if (this.caPresent)
        this.put({
          apiVersion: "v1",
          kind: "Secret",
          metadata: {
            name: "database-ca",
            namespace: resource.metadata.namespace,
          },
          data: {
            "ca.crt": Buffer.from(
              "-----BEGIN CERTIFICATE-----\ntest-public-certificate\n-----END CERTIFICATE-----\n",
            ).toString("base64"),
            "ca.key": randomBytes(48).toString("base64"),
          },
        });
    }
    this.resources.set(key, current);
    this.mutation(`${verb}:${resource.kind}:${resource.metadata.name}`);
  }
  async patch(
    kind: string,
    namespace: string | undefined,
    name: string,
    operations: unknown[],
  ): Promise<void> {
    const resource = this.resources.get(this.key(kind, namespace, name));
    assert.ok(resource);
    for (const raw of operations) {
      const op = record(raw);
      const path = String(op.path)
        .split("/")
        .slice(1)
        .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
      let parent: Record<string, unknown> = resource;
      for (const part of path.slice(0, -1)) parent = record(parent[part]);
      const last = path.at(-1)!;
      if (op.op === "test") assert.deepEqual(parent[last], op.value);
      else parent[last] = structuredClone(op.value);
    }
    if (kind === "Cluster") await this.write(resource, "patch");
    else {
      resource.metadata.resourceVersion = String(++this.revision);
      this.mutation(`patch:${kind}:${name}`);
    }
  }
  async delete(
    kind: string,
    namespace: string | undefined,
    name: string,
    uid: string,
  ): Promise<void> {
    const key = this.key(kind, namespace, name);
    const current = this.resources.get(key);
    assert.equal(current?.metadata.uid, uid);
    this.resources.delete(key);
    if (kind === "Namespace") {
      for (const [resourceKey, resource] of this.resources)
        if (resource.metadata.namespace === name)
          this.resources.delete(resourceKey);
      if (this.autoDeleteStorage) {
        for (const [resourceKey, resource] of this.resources) {
          if (
            resource.kind === "PersistentVolume" &&
            record(record(resource.spec).claimRef).namespace === name &&
            record(resource.spec).persistentVolumeReclaimPolicy === "Delete"
          ) {
            const handle = record(record(resource.spec).csi).volumeHandle;
            this.resources.delete(resourceKey);
            for (const [lvKey, lv] of this.resources)
              if (lv.kind === "LVMVolume" && lv.metadata.name === handle)
                this.resources.delete(lvKey);
          }
        }
      }
    }
    this.mutation(`delete:${kind}:${name}`);
  }
  addStorage(db: DesiredDatabase): void {
    const claim = this.resources.get(
      this.key("PersistentVolumeClaim", `pgcf-db-${db.id}`, "database-1"),
    );
    const existingHandle = record(claim?.spec).volumeName;
    if (typeof existingHandle === "string") {
      this.put({
        apiVersion: "local.openebs.io/v1alpha1",
        kind: "LVMVolume",
        metadata: { name: existingHandle, namespace: "openebs" },
      });
      return;
    }
    const handle = `pvc-${randomUUID()}`;
    this.put({
      apiVersion: "v1",
      kind: "PersistentVolume",
      metadata: { name: handle },
      spec: {
        persistentVolumeReclaimPolicy: "Retain",
        storageClassName: "pgcf-lvm",
        csi: { driver: "local.csi.openebs.io", volumeHandle: handle },
        claimRef: {
          namespace: `pgcf-db-${db.id}`,
          name: "database-1",
          uid: randomUUID(),
        },
      },
    });
    this.put({
      apiVersion: "local.openebs.io/v1alpha1",
      kind: "LVMVolume",
      metadata: { name: handle, namespace: "openebs" },
    });
  }
  backupSecret(ctx: BuildContext): void {
    this.put({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "pgcf-backup-s3", namespace: "pgcf-system" },
      data: {
        AWS_ACCESS_KEY_ID: Buffer.from(
          ctx.backup.credentials.accessKeyId,
        ).toString("base64"),
        AWS_SECRET_ACCESS_KEY: Buffer.from(
          ctx.backup.credentials.secretAccessKey,
        ).toString("base64"),
      },
    });
  }
  ownedNamespace(db: DesiredDatabase): Resource {
    return this.put({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: `pgcf-db-${db.id}`,
        labels: { [DATABASE_LABEL]: db.id },
      },
      status: { phase: "Active" },
    });
  }
}

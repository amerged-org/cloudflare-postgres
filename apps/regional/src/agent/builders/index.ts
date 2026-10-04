// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import {
  ARCHIVE_DESTINATION_PATTERN,
  BucketName,
  DatabaseId,
  DesiredDatabase,
  OWNER_ROLE_NAME,
  MAINTENANCE_ROLE,
  MAINTENANCE_BOOTSTRAP_SQL,
  RoleName,
  SIDECAR,
  gib,
  mib,
  millicores,
  postgresParameters,
  resourceQuotaFor,
} from "@pgcf/contracts";
import type { K8sObject } from "@pgcf/contracts";

export interface BuildContext {
  backup: {
    bucket: string;
    endpointUrl: string;
    region: "auto";
    credentials: { accessKeyId: string; secretAccessKey: string };
  };
  postgresImage: string;
  systemNamespace: "pgcf-system";
  cnpgNamespace: "cnpg-system";
  gatewaySelector: { namespace: string; podLabels: Record<string, string> };
  agentSelector: { namespace: string; podLabels: Record<string, string> };
  storageClass: "pgcf-lvm";
}

const DNS_LABEL = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const LABEL_NAME = /^[A-Za-z0-9](?:[-_.A-Za-z0-9]{0,61}[A-Za-z0-9])?$/;
const LABEL_VALUE = /^(?:[A-Za-z0-9](?:[-_.A-Za-z0-9]{0,61}[A-Za-z0-9])?)?$/;
const DATABASE_LABEL = "pgcf.io/database-id";
const BARMAN_PLUGIN = "barman-cloud.cloudnative-pg.io";
const CLUSTER_NAME = "database";
const ARCHIVE_NAME = "archive";
const ARCHIVE_SECRET = "archive-credentials";
const MAINTENANCE_SECRET = "maintenance-credentials";

function dnsName(value: string): boolean {
  return (
    value.length <= 253 &&
    value.split(".").every((part) => DNS_LABEL.test(part))
  );
}

function labelKey(value: string): boolean {
  const parts = value.split("/");
  return (
    (parts.length === 1 && LABEL_NAME.test(parts[0]!)) ||
    (parts.length === 2 && dnsName(parts[0]!) && LABEL_NAME.test(parts[1]!))
  );
}

function validSelector(selector: BuildContext["gatewaySelector"]): boolean {
  return (
    DNS_LABEL.test(selector.namespace) &&
    Object.entries(selector.podLabels).length > 0 &&
    Object.entries(selector.podLabels).every(
      ([key, value]) => labelKey(key) && LABEL_VALUE.test(value),
    )
  );
}

function endpointLabels(
  selector: BuildContext["gatewaySelector"],
): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(selector.podLabels).map(([key, value]) => [
        `k8s:${key}`,
        value,
      ]),
    ),
    "k8s:io.kubernetes.pod.namespace": selector.namespace,
  };
}

function validateContext(ctx: BuildContext): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(ctx.backup.endpointUrl);
  } catch {
    throw new TypeError("invalid backup endpoint");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.port ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash ||
    !dnsName(endpoint.hostname) ||
    isIP(endpoint.hostname) !== 0
  ) {
    throw new TypeError("invalid backup endpoint");
  }
  const credentials = ctx.backup.credentials;
  if (
    !BucketName.safeParse(ctx.backup.bucket).success ||
    ctx.backup.region !== "auto" ||
    !credentials ||
    typeof credentials.accessKeyId !== "string" ||
    !credentials.accessKeyId ||
    typeof credentials.secretAccessKey !== "string" ||
    !credentials.secretAccessKey ||
    ctx.systemNamespace !== "pgcf-system" ||
    ctx.cnpgNamespace !== "cnpg-system" ||
    ctx.storageClass !== "pgcf-lvm" ||
    !validSelector(ctx.gatewaySelector) ||
    !validSelector(ctx.agentSelector) ||
    !/^[A-Za-z0-9./_:-]+@sha256:[a-f0-9]{64}$/.test(ctx.postgresImage)
  ) {
    throw new TypeError("invalid build context");
  }
  return endpoint;
}

export function databaseNamespace(id: string): string {
  if (!DatabaseId.safeParse(id).success) {
    throw new TypeError("invalid database id");
  }
  return `pgcf-db-${id}`;
}

export function roleSecretName(role: string): string {
  if (!RoleName.safeParse(role).success) {
    throw new TypeError("invalid role name");
  }
  const readable = `role-${role}`;
  if (DNS_LABEL.test(readable)) return readable;
  // A second hyphen separates hashed names from every readable RoleName.
  return `role-h-${createHash("sha256").update(role).digest("hex").slice(0, 56)}`;
}

export function buildDatabaseManifests(
  input: DesiredDatabase,
  ctx: BuildContext,
): K8sObject[] {
  const parsed = DesiredDatabase.safeParse(input);
  if (!parsed.success || parsed.data.desired_state !== "running") {
    throw new TypeError("invalid running database");
  }
  const db = parsed.data;
  const endpoint = validateContext(ctx);
  const archivePath = ARCHIVE_DESTINATION_PATTERN.exec(
    db.archive.destination_path,
  );
  if (archivePath?.[1] !== ctx.backup.bucket) {
    throw new TypeError("archive bucket does not match build context");
  }
  const namespace = databaseNamespace(db.id);
  const labels = { [DATABASE_LABEL]: db.id };
  const metadata = (name: string): K8sObject["metadata"] => ({
    name,
    namespace,
    labels: { ...labels },
  });
  const quota = resourceQuotaFor(db.size);
  const compute = {
    cpu: millicores(db.size.cpu_millicores),
    memory: mib(db.size.memory_mib),
  };
  const managedRoles = [
    ...db.roles
      .filter((role) => !role.owner)
      .map((role) => ({
        name: role.name,
        ensure: "present",
        login: true,
        superuser: false,
        createdb: false,
        createrole: false,
        replication: false,
        bypassrls: false,
        inherit: true,
        passwordSecret: { name: roleSecretName(role.name) },
      })),
    ...(db.maintenance
      ? [
          {
            name: MAINTENANCE_ROLE,
            ensure: "present",
            login: true,
            superuser: false,
            createdb: false,
            createrole: false,
            replication: false,
            bypassrls: false,
            inherit: true,
            inRoles: ["pg_read_all_stats"],
            passwordSecret: { name: MAINTENANCE_SECRET },
          },
        ]
      : []),
  ];
  return [
    {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: namespace,
        labels: {
          ...labels,
          "pod-security.kubernetes.io/enforce": "restricted",
          "pod-security.kubernetes.io/enforce-version": "latest",
        },
      },
    },
    {
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: metadata("database-resources"),
      spec: {
        hard: {
          "requests.cpu": millicores(quota.requestsCpuMillicores),
          "limits.cpu": millicores(quota.limitsCpuMillicores),
          "requests.memory": mib(quota.requestsMemoryMib),
          "limits.memory": mib(quota.limitsMemoryMib),
          "requests.storage": gib(quota.requestsStorageGib),
          persistentvolumeclaims: String(quota.persistentVolumeClaims),
          pods: String(quota.pods),
        },
      },
    },
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
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: metadata("default-deny"),
      spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"] },
    },
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: metadata("gateway-ingress"),
      spec: {
        podSelector: { matchLabels: { "cnpg.io/cluster": CLUSTER_NAME } },
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [
              {
                namespaceSelector: {
                  matchLabels: {
                    "kubernetes.io/metadata.name":
                      ctx.gatewaySelector.namespace,
                  },
                },
                podSelector: {
                  matchLabels: { ...ctx.gatewaySelector.podLabels },
                },
              },
            ],
            ports: [{ port: 5432, protocol: "TCP" }],
          },
        ],
      },
    },
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: metadata("agent-management-ingress"),
      spec: {
        podSelector: { matchLabels: { "cnpg.io/cluster": CLUSTER_NAME } },
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [
              {
                namespaceSelector: {
                  matchLabels: {
                    "kubernetes.io/metadata.name": ctx.agentSelector.namespace,
                  },
                },
                podSelector: {
                  matchLabels: { ...ctx.agentSelector.podLabels },
                },
              },
            ],
            ports: [
              { port: 5432, protocol: "TCP" },
              { port: 9187, protocol: "TCP" },
            ],
          },
        ],
      },
    },
    {
      apiVersion: "cilium.io/v2",
      kind: "CiliumNetworkPolicy",
      metadata: metadata("database-boundaries"),
      spec: {
        endpointSelector: { matchLabels: { "cnpg.io/cluster": CLUSTER_NAME } },
        ingress: [
          {
            fromEndpoints: [
              {
                matchLabels: endpointLabels(ctx.gatewaySelector),
              },
            ],
            toPorts: [{ ports: [{ port: "5432", protocol: "TCP" }] }],
          },
          {
            fromEndpoints: [{ matchLabels: endpointLabels(ctx.agentSelector) }],
            toPorts: [
              {
                ports: [
                  { port: "5432", protocol: "TCP" },
                  { port: "9187", protocol: "TCP" },
                ],
              },
            ],
          },
          {
            fromEndpoints: [
              {
                matchLabels: {
                  "k8s:io.kubernetes.pod.namespace": ctx.cnpgNamespace,
                  "k8s:app.kubernetes.io/name": "cloudnative-pg",
                },
              },
              {
                matchLabels: {
                  "k8s:io.kubernetes.pod.namespace": ctx.cnpgNamespace,
                  "k8s:app.kubernetes.io/name": "plugin-barman-cloud",
                },
              },
            ],
            toPorts: [{ ports: [{ port: "8000", protocol: "TCP" }] }],
          },
        ],
        egress: [
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
            toFQDNs: [{ matchName: endpoint.hostname }],
            toPorts: [{ ports: [{ port: "443", protocol: "TCP" }] }],
          },
        ],
      },
    },
    ...db.roles.map((role): K8sObject => ({
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        ...metadata(roleSecretName(role.name)),
        labels: { ...labels, "cnpg.io/reload": "true" },
      },
      type: "kubernetes.io/basic-auth",
      data: {
        username: Buffer.from(role.name, "utf8").toString("base64"),
        password: Buffer.from(role.password, "utf8").toString("base64"),
      },
    })),
    ...(db.maintenance
      ? [
          {
            apiVersion: "v1",
            kind: "Secret",
            metadata: {
              ...metadata(MAINTENANCE_SECRET),
              labels: { ...labels, "cnpg.io/reload": "true" },
            },
            type: "kubernetes.io/basic-auth",
            data: {
              username: Buffer.from(MAINTENANCE_ROLE, "utf8").toString(
                "base64",
              ),
              password: Buffer.from(db.maintenance.password, "utf8").toString(
                "base64",
              ),
            },
          },
        ]
      : []),
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: metadata(ARCHIVE_SECRET),
      type: "Opaque",
      data: {
        AWS_ACCESS_KEY_ID: Buffer.from(
          ctx.backup.credentials.accessKeyId,
          "utf8",
        ).toString("base64"),
        AWS_SECRET_ACCESS_KEY: Buffer.from(
          ctx.backup.credentials.secretAccessKey,
          "utf8",
        ).toString("base64"),
      },
    },
    {
      apiVersion: "barmancloud.cnpg.io/v1",
      kind: "ObjectStore",
      metadata: metadata(ARCHIVE_NAME),
      spec: {
        configuration: {
          destinationPath: db.archive.destination_path,
          endpointURL: ctx.backup.endpointUrl,
          s3Credentials: {
            accessKeyId: { name: ARCHIVE_SECRET, key: "AWS_ACCESS_KEY_ID" },
            secretAccessKey: {
              name: ARCHIVE_SECRET,
              key: "AWS_SECRET_ACCESS_KEY",
            },
          },
          wal: { compression: "gzip" },
          data: { compression: "gzip" },
        },
        retentionPolicy: `${db.size.backup_retention_days}d`,
        instanceSidecarConfiguration: {
          env: [{ name: "AWS_DEFAULT_REGION", value: ctx.backup.region }],
          resources: {
            requests: {
              cpu: millicores(SIDECAR.requestCpuMillicores),
              memory: mib(SIDECAR.requestMemoryMib),
            },
            limits: {
              cpu: millicores(SIDECAR.limitCpuMillicores),
              memory: mib(SIDECAR.limitMemoryMib),
            },
          },
        },
      },
    },
    {
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "Cluster",
      metadata: metadata(CLUSTER_NAME),
      spec: {
        instances: 1,
        imageName: ctx.postgresImage,
        inheritedMetadata: { labels: { ...labels } },
        enableSuperuserAccess: false,
        bootstrap: {
          initdb: {
            database: db.id,
            owner: OWNER_ROLE_NAME,
            secret: { name: roleSecretName(OWNER_ROLE_NAME) },
            ...(db.maintenance
              ? { postInitApplicationSQL: [...MAINTENANCE_BOOTSTRAP_SQL] }
              : {}),
          },
        },
        affinity: { nodeSelector: { "kubernetes.io/hostname": db.node } },
        resources: { requests: { ...compute }, limits: { ...compute } },
        seccompProfile: { type: "RuntimeDefault" },
        storage: {
          storageClass: ctx.storageClass,
          size: gib(db.size.storage_gib),
        },
        postgresql: {
          parameters: postgresParameters(db.size),
          pg_hba: ["hostnossl all all all reject"],
        },
        managed: { roles: managedRoles },
        plugins: [
          {
            name: BARMAN_PLUGIN,
            enabled: true,
            isWALArchiver: true,
            parameters: {
              barmanObjectName: ARCHIVE_NAME,
              serverName: db.archive.server_name,
            },
          },
        ],
      },
    },
    {
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "ScheduledBackup",
      metadata: metadata("daily-backup"),
      spec: {
        schedule: "0 0 3 * * *",
        immediate: true,
        backupOwnerReference: "none",
        cluster: { name: CLUSTER_NAME },
        method: "plugin",
        pluginConfiguration: { name: BARMAN_PLUGIN },
      },
    },
  ];
}

export function buildCaConfigMap(id: string, caCrt: string): K8sObject {
  databaseNamespace(id);
  if (typeof caCrt !== "string" || caCrt.trim().length === 0) {
    throw new TypeError("invalid CA certificate");
  }
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: `ca-${id}`,
      namespace: "pgcf-system",
      labels: { [DATABASE_LABEL]: id },
    },
    data: { "ca.crt": caCrt },
  };
}

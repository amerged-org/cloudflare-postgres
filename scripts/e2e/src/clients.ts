// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { isIP } from "node:net";
import {
  HarnessError,
  assertOwned,
  archiveCounts,
  items,
  objectName,
  parseArchiveObjects,
  record,
  string,
} from "./core.ts";
import type { ArchiveObject } from "./core.ts";
import { assertPolicyIdentity, sameStructuredValue } from "./identity.ts";
import type { ClusterIdentity } from "./identity.ts";

export interface CloudflareEnvelope {
  result: unknown;
  result_info?: Record<string, unknown>;
  success: boolean;
}

function requestTimeout(deadline?: () => number): number {
  const remaining = deadline ? deadline() - Date.now() : 30_000;
  if (remaining <= 0) throw new HarnessError("step_time_budget_exhausted");
  return Math.min(remaining, 30_000);
}

export async function command(
  program: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    input?: string;
  } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let tooLarge = false;
    // Discard stderr: tools may include credentials or server-provided text in errors.
    child.stderr!.resume();
    if (options.input !== undefined) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.input);
    }
    const stop = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    const timer = setTimeout(
      stop,
      Math.min(options.timeoutMs ?? 60_000, 540_000),
    );
    child.stdout!.on("data", (bytes: Buffer) => {
      stdout += bytes.toString();
      if (stdout.length > 16_000_000) {
        tooLarge = true;
        stop();
      }
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(new HarnessError("command_failed"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || tooLarge) reject(new HarnessError("command_failed"));
      else resolve(stdout);
    });
  });
}

export class Cloudflare {
  readonly account: string;
  private readonly token: string;
  private readonly expectedName: string;
  private readonly deadline?: () => number;
  constructor(
    account: string,
    token: string,
    expectedName: string,
    deadline?: () => number,
  ) {
    this.account = account;
    this.token = token;
    this.expectedName = expectedName;
    this.deadline = deadline;
  }
  async request(
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<CloudflareEnvelope> {
    if ((path !== "" && !path.startsWith("/")) || path.includes(".."))
      throw new HarnessError("invalid_request");
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.account)}${path}`,
      {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(requestTimeout(this.deadline)),
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    const result = record(await response.json());
    if (!response.ok || result.success !== true)
      throw new HarnessError("cloudflare_request_failed");
    return result as unknown as CloudflareEnvelope;
  }
  async verifyAccount(): Promise<void> {
    const result = record((await this.request("")).result);
    if (result.id !== this.account || result.name !== this.expectedName)
      throw new HarnessError("account_mismatch");
  }
  async verifyNonexpiringToken(): Promise<void> {
    const result = record((await this.request("/tokens/verify")).result);
    if (
      result.status !== "active" ||
      typeof result.id !== "string" ||
      !/^[a-f0-9]{32}$/.test(result.id) ||
      (result.expires_on !== undefined && result.expires_on !== null)
    )
      throw new HarnessError("credential_expiry_mismatch");
  }
  async list(path: string): Promise<Record<string, unknown>[]> {
    const output: Record<string, unknown>[] = [];
    for (let page = 1; page <= 1000; page++) {
      const envelope = await this.request(
        `${path}${path.includes("?") ? "&" : "?"}page=${page}&per_page=100`,
      );
      if (!Array.isArray(envelope.result))
        throw new HarnessError("invalid_response");
      const rows = envelope.result.map(record);
      output.push(...rows);
      const totalPages = envelope.result_info?.total_pages;
      if (
        typeof totalPages === "number" ? page >= totalPages : rows.length < 100
      )
        return output;
    }
    throw new HarnessError("pagination_limit");
  }
  async buckets(
    jurisdiction: "default" | "eu",
  ): Promise<Record<string, unknown>[]> {
    const result: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const response = await this.request(
        `/r2/buckets?per_page=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        "GET",
        undefined,
        { "cf-r2-jurisdiction": jurisdiction },
      );
      const buckets = record(response.result).buckets;
      if (!Array.isArray(buckets)) throw new HarnessError("invalid_response");
      result.push(...buckets.map(record));
      cursor =
        typeof response.result_info?.cursor === "string" &&
        response.result_info.cursor
          ? response.result_info.cursor
          : undefined;
      if (!cursor) return result;
    }
    throw new HarnessError("pagination_limit");
  }
  async objects(
    bucket: string,
    prefix: string,
    jurisdiction: "default" | "eu",
  ): Promise<ArchiveObject[]> {
    assertOwned(bucket);
    const objects: ArchiveObject[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const response = await this.request(
        `/r2/buckets/${bucket}/objects?prefix=${encodeURIComponent(prefix)}&per_page=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        "GET",
        undefined,
        { "cf-r2-jurisdiction": jurisdiction },
      );
      objects.push(...parseArchiveObjects(response.result, prefix));
      if (!response.result_info?.is_truncated) return objects;
      cursor = string(response.result_info.cursor);
    }
    throw new HarnessError("pagination_limit");
  }
  async deleteObjects(
    bucket: string,
    prefix: string,
    jurisdiction: "default" | "eu",
  ): Promise<Record<string, number>> {
    assertOwned(bucket);
    const objects = await this.objects(bucket, prefix, jurisdiction);
    for (const object of objects) {
      if (!object.key.startsWith(prefix))
        throw new HarnessError("ownership_refused");
      const key = object.key.split("/").map(encodeURIComponent).join("/");
      await this.request(
        `/r2/buckets/${bucket}/objects/${key}`,
        "DELETE",
        undefined,
        { "cf-r2-jurisdiction": jurisdiction },
      );
    }
    if ((await this.objects(bucket, prefix, jurisdiction)).length)
      throw new HarnessError("archive_cleanup_incomplete");
    return archiveCounts(objects);
  }
}

export class ManagementApi {
  private readonly base: URL;
  private readonly key: string;
  private readonly deadline?: () => number;
  constructor(base: URL, key: string, deadline?: () => number) {
    this.base = base;
    this.key = key;
    this.deadline = deadline;
  }
  async request(
    path: string,
    method = "GET",
    body?: unknown,
    idempotency?: string,
  ): Promise<unknown> {
    if (!path.startsWith("/v1/") || path.includes(".."))
      throw new HarnessError("invalid_request");
    const url = new URL(path, this.base);
    const response = await fetch(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(requestTimeout(this.deadline)),
      headers: {
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
        ...(idempotency ? { "Idempotency-Key": idempotency } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok)
      throw new HarnessError(`management_http_${response.status}`);
    return response.status === 204 ? null : response.json();
  }
  async list(path: string): Promise<Record<string, unknown>[]> {
    const output: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const result = record(
        await this.request(
          `${path}${path.includes("?") ? "&" : "?"}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        ),
      );
      if (!Array.isArray(result.data))
        throw new HarnessError("invalid_response");
      output.push(...result.data.map(record));
      if (result.next_cursor === null) return output;
      cursor = string(result.next_cursor);
    }
    throw new HarnessError("pagination_limit");
  }
}

export function assertGatewayEnvironmentKeys(names: readonly string[]): void {
  if (
    names.some(
      (name) =>
        /^(?:NODE_(?!ENV$)|LD_|DYLD_)/.test(name) ||
        /^(?:PATH|ENV|BASH_ENV|GCONV_PATH|OPENSSL_CONF|OPENSSL_MODULES|GLIBC_TUNABLES)$/.test(
          name,
        ),
    )
  )
    throw new HarnessError("gateway_log_execution_hook");
}

function defaulted(
  value: unknown,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...defaults,
    ...Object.fromEntries(
      Object.entries(record(value === undefined ? {} : value)).filter(
        ([, entry]) => entry !== undefined,
      ),
    ),
  };
}

function gatewayProbe(
  value: unknown,
  path: string,
  initial: number,
  period: number,
  failures: number,
): Record<string, unknown> {
  const probe = defaulted(value, {
    initialDelaySeconds: 0,
    timeoutSeconds: 1,
    periodSeconds: 10,
    successThreshold: 1,
    failureThreshold: 3,
    terminationGracePeriodSeconds: 45,
  });
  for (const [name, fallback] of [
    ["timeoutSeconds", 1],
    ["periodSeconds", 10],
    ["successThreshold", 1],
    ["failureThreshold", 3],
  ] as const)
    if (probe[name] === 0) probe[name] = fallback;
  const http = defaulted(probe.httpGet, {
    host: "",
    scheme: "HTTP",
    httpHeaders: [],
  });
  if (http.scheme === "") http.scheme = "HTTP";
  probe.httpGet = http;
  if (
    !sameStructuredValue(probe, {
      httpGet: {
        path,
        port: "http",
        host: "",
        scheme: "HTTP",
        httpHeaders: [],
      },
      initialDelaySeconds: initial,
      timeoutSeconds: 1,
      periodSeconds: period,
      successThreshold: 1,
      failureThreshold: failures,
      terminationGracePeriodSeconds: 45,
    })
  )
    throw new HarnessError("gateway_log_probe_mismatch");
  return probe;
}

function gatewayVolumes(
  container: Record<string, unknown>,
  spec: Record<string, unknown>,
  admitted: boolean,
): Record<string, unknown> {
  // Kubernetes v1.36.3 ServiceAccount admission adds this one readonly projection:
  // https://github.com/kubernetes/kubernetes/blob/v1.36.3/plugin/pkg/admission/serviceaccount/admission.go
  try {
    if (
      !Array.isArray(container.volumeMounts) ||
      !Array.isArray(spec.volumes) ||
      (container.volumeDevices !== undefined &&
        (!Array.isArray(container.volumeDevices) ||
          container.volumeDevices.length))
    )
      throw new Error();
    const mounts = container.volumeMounts.map(record),
      volumes = spec.volumes.map(record);
    if (
      mounts.length !== (admitted ? 2 : 1) ||
      volumes.length !== mounts.length
    )
      throw new Error();
    const tmpMount = mounts.find((mount) => mount.name === "tmp"),
      tmpVolume = volumes.find((volume) => volume.name === "tmp");
    if (!tmpMount || !tmpVolume) throw new Error();
    const normalizedMount = defaulted(tmpMount, {
      readOnly: false,
      subPath: "",
      subPathExpr: "",
      mountPropagation: "None",
    });
    if (
      !sameStructuredValue(normalizedMount, {
        name: "tmp",
        mountPath: "/tmp",
        readOnly: false,
        subPath: "",
        subPathExpr: "",
        mountPropagation: "None",
      })
    )
      throw new Error();
    const emptyDir = defaulted(tmpVolume.emptyDir, { medium: "" });
    emptyDir.sizeLimit = quantityBytes(emptyDir.sizeLimit);
    if (
      !sameStructuredValue(
        { ...tmpVolume, emptyDir },
        { name: "tmp", emptyDir: { medium: "", sizeLimit: 67_108_864 } },
      )
    )
      throw new Error();
    const normalized = {
      mounts: [normalizedMount],
      volumes: [{ ...tmpVolume, emptyDir }],
    };
    if (!admitted) return normalized;
    const mount = mounts.find((row) => row.name !== "tmp"),
      volume = volumes.find((row) => row.name !== "tmp");
    if (
      !mount ||
      !volume ||
      typeof volume.name !== "string" ||
      !/^kube-api-access-[bcdfghjklmnpqrstvwxz2456789]{5}$/.test(volume.name)
    )
      throw new Error();
    if (
      !sameStructuredValue(
        defaulted(mount, {
          subPath: "",
          subPathExpr: "",
          mountPropagation: "None",
          recursiveReadOnly: "Disabled",
        }),
        {
          name: volume.name,
          mountPath: "/var/run/secrets/kubernetes.io/serviceaccount",
          readOnly: true,
          subPath: "",
          subPathExpr: "",
          mountPropagation: "None",
          recursiveReadOnly: "Disabled",
        },
      )
    )
      throw new Error();
    const projected = defaulted(volume.projected, { defaultMode: 420 });
    if (!Array.isArray(projected.sources) || projected.sources.length !== 3)
      throw new Error();
    const sources = projected.sources.map(record);
    const token = defaulted(sources[0]!.serviceAccountToken, {
      audience: "",
      expirationSeconds: 3600,
    });
    const ca = defaulted(sources[1]!.configMap, { optional: false });
    if (!Array.isArray(ca.items)) throw new Error();
    ca.items = ca.items.map((item) => defaulted(item, { mode: 420 }));
    const downward = record(sources[2]!.downwardAPI);
    if (!Array.isArray(downward.items)) throw new Error();
    const items = downward.items.map((value) => {
      const item = defaulted(value, { mode: 420 });
      item.fieldRef = defaulted(item.fieldRef, { apiVersion: "v1" });
      if ((item.fieldRef as Record<string, unknown>).apiVersion === "")
        (item.fieldRef as Record<string, unknown>).apiVersion = "v1";
      return item;
    });
    projected.sources = [
      { ...sources[0], serviceAccountToken: token },
      { ...sources[1], configMap: ca },
      { ...sources[2], downwardAPI: { ...downward, items } },
    ];
    if (
      !sameStructuredValue(
        { ...volume, projected },
        {
          name: volume.name,
          projected: {
            defaultMode: 420,
            sources: [
              {
                serviceAccountToken: {
                  path: "token",
                  expirationSeconds: 3607,
                  audience: "",
                },
              },
              {
                configMap: {
                  name: "kube-root-ca.crt",
                  optional: false,
                  items: [{ key: "ca.crt", path: "ca.crt", mode: 420 }],
                },
              },
              {
                downwardAPI: {
                  items: [
                    {
                      path: "namespace",
                      mode: 420,
                      fieldRef: {
                        apiVersion: "v1",
                        fieldPath: "metadata.namespace",
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      )
    )
      throw new Error();
    // Exclude the verified admission-only token pair from template comparison.
    return normalized;
  } catch {
    throw new HarnessError("gateway_log_executable_mount");
  }
}

function gatewayPodConfiguration(
  spec: Record<string, unknown>,
): Record<string, unknown> {
  const selected = Object.fromEntries(
    [
      "serviceAccountName",
      "serviceAccount",
      "enableServiceLinks",
      "automountServiceAccountToken",
      "hostNetwork",
      "hostPID",
      "hostIPC",
      "hostUsers",
      "shareProcessNamespace",
      "dnsPolicy",
      "dnsConfig",
      "hostAliases",
      "hostname",
      "subdomain",
      "hostnameOverride",
      "setHostnameAsFQDN",
      "runtimeClassName",
      "restartPolicy",
      "schedulerName",
      "terminationGracePeriodSeconds",
    ]
      .filter((name) => spec[name] !== undefined)
      .map((name) => [name, spec[name]]),
  );
  const defaults = {
    serviceAccount: "pgcf-gateway",
    automountServiceAccountToken: true,
    hostNetwork: false,
    hostPID: false,
    hostIPC: false,
    hostUsers: true,
    shareProcessNamespace: false,
    dnsPolicy: "ClusterFirst",
    dnsConfig: { nameservers: [], searches: [], options: [] },
    hostAliases: [],
    hostname: "",
    subdomain: "",
    hostnameOverride: "",
    setHostnameAsFQDN: false,
    runtimeClassName: "",
    restartPolicy: "Always",
    schedulerName: "default-scheduler",
  };
  const config = defaulted(selected, defaults);
  config.dnsConfig = defaulted(config.dnsConfig, {
    nameservers: [],
    searches: [],
    options: [],
  });
  if (
    !sameStructuredValue(config, {
      ...defaults,
      serviceAccountName: "pgcf-gateway",
      enableServiceLinks: false,
      terminationGracePeriodSeconds: 45,
    })
  )
    throw new HarnessError("gateway_log_pod_configuration_mismatch");
  return config;
}

function assertGatewayEntrypoint(
  container: Record<string, unknown>,
  spec: Record<string, unknown>,
  admitted = false,
): Record<string, unknown> {
  // Normalize only approved execution fields, using pinned Kubernetes v1.36.3 defaults:
  // https://github.com/kubernetes/kubernetes/blob/v1.36.3/pkg/apis/core/v1/defaults.go
  if (
    !Array.isArray(spec.containers) ||
    spec.containers.length !== 1 ||
    container.name !== "gateway" ||
    [spec.initContainers, spec.ephemeralContainers].some(
      (programs) =>
        programs !== undefined && (!Array.isArray(programs) || programs.length),
    ) ||
    container.lifecycle !== undefined
  )
    throw new HarnessError("gateway_log_extra_program");
  if (
    !sameStructuredValue(container.command, ["node", "/app/gateway.mjs"]) ||
    (container.args !== undefined &&
      !sameStructuredValue(container.args, [])) ||
    (container.workingDir !== undefined && container.workingDir !== "/app")
  )
    throw new HarnessError("gateway_log_entrypoint_mismatch");
  const port =
    Array.isArray(container.ports) && container.ports.length === 1
      ? defaulted(container.ports[0], {
          protocol: "TCP",
          hostPort: 0,
          hostIP: "",
        })
      : undefined;
  if (port?.protocol === "") port.protocol = "TCP";
  if (
    !sameStructuredValue(port, {
      name: "http",
      containerPort: 8080,
      protocol: "TCP",
      hostPort: 0,
      hostIP: "",
    })
  )
    throw new HarnessError("gateway_log_port_mismatch");
  if (container.startupProbe !== undefined)
    throw new HarnessError("gateway_log_probe_mismatch");
  const live = gatewayProbe(container.livenessProbe, "/healthz", 5, 10, 3),
    ready = gatewayProbe(container.readinessProbe, "/readyz", 0, 5, 2);
  const env = container.env;
  if (!Array.isArray(env)) throw new HarnessError("gateway_log_execution_hook");
  assertGatewayEnvironmentKeys(env.map((row) => string(record(row).name)));
  if (
    container.envFrom !== undefined &&
    !sameStructuredValue(container.envFrom, [])
  )
    throw new HarnessError("gateway_log_environment_source_mismatch");
  const expectedEnvironment: Record<string, Record<string, unknown>> = {
    PGCF_REGION_ID: {
      name: "PGCF_REGION_ID",
      valueFrom: {
        configMapKeyRef: {
          name: "pgcf-regional",
          key: "PGCF_REGION_ID",
          optional: false,
        },
      },
    },
    PGCF_ROUTE_KEY: {
      name: "PGCF_ROUTE_KEY",
      valueFrom: {
        secretKeyRef: {
          name: "pgcf-gateway",
          key: "PGCF_ROUTE_KEY",
          optional: false,
        },
      },
    },
    PGCF_GATEWAY_PORT: { name: "PGCF_GATEWAY_PORT", value: "8080" },
  };
  const environment = env.map((value) => {
    const row = { ...record(value) };
    if (row.valueFrom !== undefined) {
      const source = { ...record(row.valueFrom) };
      for (const name of ["configMapKeyRef", "secretKeyRef"])
        if (source[name] !== undefined)
          source[name] = defaulted(source[name], { optional: false });
      row.valueFrom = source;
    }
    return row;
  });
  if (
    environment.length !== 3 ||
    new Set(environment.map((row) => row.name)).size !== 3 ||
    environment.some(
      (row) => !sameStructuredValue(row, expectedEnvironment[string(row.name)]),
    )
  )
    throw new HarnessError("gateway_log_environment_source_mismatch");
  const volumes = gatewayVolumes(container, spec, admitted);
  const podDefaults = {
    supplementalGroups: [],
    sysctls: [],
    supplementalGroupsPolicy: "Merge",
    fsGroupChangePolicy: "Always",
  };
  const podSecurity = defaulted(spec.securityContext, podDefaults);
  if (
    !sameStructuredValue(podSecurity, {
      ...podDefaults,
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      seccompProfile: { type: "RuntimeDefault" },
    })
  )
    throw new HarnessError("gateway_log_execution_security_mismatch");
  const inherited = {
    privileged: false,
    procMount: "Default",
    runAsNonRoot: true,
    runAsUser: 1000,
    runAsGroup: 1000,
    seccompProfile: { type: "RuntimeDefault" },
  };
  const security = defaulted(container.securityContext, inherited);
  security.capabilities = defaulted(security.capabilities, { add: [] });
  if (
    !sameStructuredValue(security, {
      ...inherited,
      readOnlyRootFilesystem: true,
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"], add: [] },
    })
  )
    throw new HarnessError("gateway_log_execution_security_mismatch");
  const process = defaulted(
    Object.fromEntries(
      [
        "stdin",
        "stdinOnce",
        "tty",
        "terminationMessagePath",
        "terminationMessagePolicy",
      ]
        .filter((name) => container[name] !== undefined)
        .map((name) => [name, container[name]]),
    ),
    {
      stdin: false,
      stdinOnce: false,
      tty: false,
      terminationMessagePath: "/dev/termination-log",
      terminationMessagePolicy: "File",
    },
  );
  if (
    !sameStructuredValue(process, {
      stdin: false,
      stdinOnce: false,
      tty: false,
      terminationMessagePath: "/dev/termination-log",
      terminationMessagePolicy: "File",
    })
  )
    throw new HarnessError("gateway_log_pod_configuration_mismatch");
  return {
    name: container.name,
    image: container.image,
    command: container.command,
    args: container.args ?? [],
    workingDir: container.workingDir ?? "/app",
    volumes,
    environment: environment.sort((a, b) =>
      string(a.name).localeCompare(string(b.name)),
    ),
    port,
    live,
    ready,
    security,
    podSecurity,
    process,
    pod: gatewayPodConfiguration(spec),
  };
}

export function gatewayLogPods(
  deployments: unknown,
  replicaSets: unknown,
  pods: unknown,
  namespace: string,
  expectedImage: string,
): string[] {
  assertOwned(namespace);
  const digest = /@sha256:([a-f0-9]{64})$/.exec(expectedImage)?.[1];
  if (!digest) throw new HarnessError("gateway_log_source_image_unpinned");
  const deployment = items(deployments).filter((row) => {
    const metadata = record(row.metadata);
    const labels = record(metadata.labels ?? {});
    return (
      metadata.namespace === namespace &&
      metadata.name === "pgcf-gateway" &&
      labels["app.kubernetes.io/name"] === "pgcf-gateway" &&
      labels["app.kubernetes.io/part-of"] === "pgcf"
    );
  });
  if (deployment.length !== 1)
    throw new HarnessError("gateway_log_deployment_missing");
  const uid = string(record(deployment[0]!.metadata).uid);
  const template = record(record(record(deployment[0]!.spec).template).spec);
  const gateway = Array.isArray(template.containers)
    ? template.containers
        .map(record)
        .find((container) => container.name === "gateway")
    : undefined;
  if (gateway?.image !== expectedImage)
    throw new HarnessError("gateway_log_source_image_mismatch");
  const deploymentExecution = assertGatewayEntrypoint(gateway, template);
  const ownedBy = (
    row: Record<string, unknown>,
    kind: string,
    ids: Set<string>,
    name?: string,
  ) => {
    const metadata = record(row.metadata);
    return (
      metadata.namespace === namespace &&
      Array.isArray(metadata.ownerReferences) &&
      metadata.ownerReferences
        .map(record)
        .some(
          (owner) =>
            owner.kind === kind &&
            typeof owner.uid === "string" &&
            ids.has(owner.uid) &&
            (name === undefined || owner.name === name) &&
            owner.controller === true,
        )
    );
  };
  const parents = new Map(
    items(replicaSets)
      .filter((row) =>
        ownedBy(row, "Deployment", new Set([uid]), "pgcf-gateway"),
      )
      .map((row) => [string(record(row.metadata).uid), row]),
  );
  const sets = new Set(parents.keys());
  const selected = items(pods).filter((row) => {
    const metadata = record(row.metadata);
    const labels = record(metadata.labels ?? {});
    return (
      !metadata.deletionTimestamp &&
      labels["app.kubernetes.io/name"] === "pgcf-gateway" &&
      labels["app.kubernetes.io/part-of"] === "pgcf" &&
      ownedBy(row, "ReplicaSet", sets)
    );
  });
  if (!selected.length || selected.length > 3)
    throw new HarnessError("gateway_log_pods_missing");
  return selected.map((pod) => {
    const spec = record(pod.spec);
    const containers = Array.isArray(spec.containers)
      ? spec.containers.map(record)
      : [];
    const status = record(pod.status);
    const running = Array.isArray(status.containerStatuses)
      ? status.containerStatuses.map(record)
      : [];
    const container = containers.find((row) => row.name === "gateway");
    const imageId = running.find((row) => row.name === "gateway")?.imageID;
    if (
      container?.image !== expectedImage ||
      typeof imageId !== "string" ||
      !(
        imageId.endsWith(`@sha256:${digest}`) ||
        imageId === `containerd://sha256:${digest}`
      )
    )
      throw new HarnessError("gateway_log_source_image_mismatch");
    const podExecution = assertGatewayEntrypoint(container, spec, true);
    const owners = (record(pod.metadata).ownerReferences as unknown[])
      .map(record)
      .filter(
        (owner) => owner.kind === "ReplicaSet" && owner.controller === true,
      );
    const parent =
      owners.length === 1 && typeof owners[0]!.uid === "string"
        ? parents.get(owners[0]!.uid)
        : undefined;
    try {
      if (!parent || record(parent.metadata).name !== owners[0]!.name)
        throw new Error();
      const parentSpec = record(record(record(parent.spec).template).spec);
      if (
        !Array.isArray(parentSpec.containers) ||
        parentSpec.containers.length !== 1
      )
        throw new Error();
      const parentExecution = assertGatewayEntrypoint(
        record(parentSpec.containers[0]),
        parentSpec,
      );
      if (
        !sameStructuredValue(parentExecution, deploymentExecution) ||
        !sameStructuredValue(parentExecution, podExecution)
      )
        throw new Error();
    } catch {
      throw new HarnessError("gateway_log_replica_set_template_mismatch");
    }
    const name = objectName(pod);
    assertOwned(name);
    return name;
  });
}

export class Kubernetes {
  private readonly configPath: string;
  private readonly context: string;
  private readonly deadline?: () => number;
  private mutationGuard?: () => Promise<void>;
  setMutationGuard(guard: () => Promise<void>): void {
    this.mutationGuard = guard;
  }
  private async guard(): Promise<void> {
    if (!this.mutationGuard)
      throw new HarnessError("cluster_mutation_guard_missing");
    await this.mutationGuard();
  }
  constructor(configPath: string, context: string, deadline?: () => number) {
    this.configPath = configPath;
    this.context = context;
    this.deadline = deadline;
  }
  async read(resource: string): Promise<unknown> {
    if (
      ![
        "nodes",
        "namespaces",
        "persistentvolumeclaims",
        "persistentvolumes",
        "lvmvolumes.local.openebs.io",
        "lvmnodes.local.openebs.io",
        "pods",
        "deployments",
        "daemonsets",
        "statefulsets",
        "services",
        "helmreleases.helm.toolkit.fluxcd.io",
        "storageclasses",
        "replicasets",
        "ciliumnetworkpolicies.cilium.io",
      ].includes(resource)
    )
      throw new HarnessError("read_scope_refused");
    const args = [
      "--kubeconfig",
      this.configPath,
      "--context",
      this.context,
      "--request-timeout=30s",
      "get",
      resource,
      "--all-namespaces",
      "-o",
      "json",
    ];
    return JSON.parse(
      await command("kubectl", args, {
        timeoutMs: requestTimeout(this.deadline),
      }),
    );
  }
  async gatewayLogs(
    namespace: string,
    since: string,
    expectedImage: string,
  ): Promise<string> {
    const started = Date.parse(since);
    if (
      !Number.isFinite(started) ||
      new Date(started).toISOString() !== since ||
      started > Date.now() ||
      Date.now() - started > 600_000
    )
      throw new HarnessError("gateway_log_window_invalid");
    await this.guard();
    const deployments = await this.read("deployments");
    await this.guard();
    const replicaSets = await this.read("replicasets");
    await this.guard();
    const pods = await this.read("pods");
    const names = gatewayLogPods(
      deployments,
      replicaSets,
      pods,
      namespace,
      expectedImage,
    );
    const logs: string[] = [];
    for (const name of names) {
      await this.guard();
      logs.push(
        await command(
          "kubectl",
          [
            "--kubeconfig",
            this.configPath,
            "--context",
            this.context,
            "--request-timeout=30s",
            "logs",
            name,
            "--namespace",
            namespace,
            "--container=gateway",
            `--since-time=${since}`,
            "--tail=10000",
            "--limit-bytes=2000000",
          ],
          { timeoutMs: requestTimeout(this.deadline) },
        ),
      );
    }
    return logs.join("\n");
  }
  async rolePasswords(namespace: string): Promise<string[]> {
    assertOwned(namespace);
    const args = [
      "--kubeconfig",
      this.configPath,
      "--context",
      this.context,
      "--request-timeout=30s",
      "get",
      "secrets",
      "--namespace",
      namespace,
      "--field-selector=type=kubernetes.io/basic-auth",
      "-o",
      "json",
    ];
    const secrets = items(
      JSON.parse(
        await command("kubectl", args, {
          timeoutMs: requestTimeout(this.deadline),
        }),
      ),
    );
    return secrets.map((secret) => {
      if (
        record(secret.metadata).namespace !== namespace ||
        secret.type !== "kubernetes.io/basic-auth"
      )
        throw new HarnessError("secret_scope_mismatch");
      return string(record(secret.data).password);
    });
  }
  async named(
    resource: "configmaps",
    name: string,
    namespace: string,
  ): Promise<Record<string, unknown>> {
    assertOwned(name);
    assertOwned(namespace);
    return record(
      JSON.parse(
        await command(
          "kubectl",
          [
            "--kubeconfig",
            this.configPath,
            "--context",
            this.context,
            "--request-timeout=30s",
            "get",
            resource,
            name,
            "--namespace",
            namespace,
            "-o",
            "json",
          ],
          { timeoutMs: requestTimeout(this.deadline) },
        ),
      ),
    );
  }
  async effectiveConfig(
    container: Record<string, unknown>,
    namespace: string,
  ): Promise<{ api_url: string; region_id: string }> {
    const selected: Record<string, string> = {};
    for (const from of Array.isArray(container.envFrom)
      ? container.envFrom.map(record)
      : []) {
      const prefix = typeof from.prefix === "string" ? from.prefix : "";
      if (from.configMapRef) {
        const map = await this.named(
          "configmaps",
          string(record(from.configMapRef).name),
          namespace,
        );
        for (const [key, value] of Object.entries(record(map.data)))
          if (["PGCF_API_URL", "PGCF_REGION_ID"].includes(`${prefix}${key}`))
            selected[`${prefix}${key}`] = string(value);
      } else if (from.secretRef) {
        const name = string(record(from.secretRef).name);
        assertOwned(name);
        const keys = await command(
          "kubectl",
          [
            "--kubeconfig",
            this.configPath,
            "--context",
            this.context,
            "--request-timeout=30s",
            "get",
            "secret",
            name,
            "--namespace",
            namespace,
            "-o",
            'go-template={{range $key, $value := .data}}{{printf "%s\\n" $key}}{{end}}',
          ],
          { timeoutMs: requestTimeout(this.deadline) },
        );
        if (
          keys
            .trim()
            .split("\n")
            .some((key) =>
              ["PGCF_API_URL", "PGCF_REGION_ID"].includes(`${prefix}${key}`),
            )
        )
          throw new HarnessError("secret_shadows_agent_configuration");
      }
    }
    for (const variable of Array.isArray(container.env)
      ? container.env.map(record)
      : []) {
      if (!["PGCF_API_URL", "PGCF_REGION_ID"].includes(String(variable.name)))
        continue;
      if (typeof variable.value === "string")
        selected[string(variable.name)] = variable.value;
      else if (
        variable.valueFrom &&
        record(variable.valueFrom).configMapKeyRef
      ) {
        const source = record(record(variable.valueFrom).configMapKeyRef),
          map = await this.named("configmaps", string(source.name), namespace);
        selected[string(variable.name)] = string(
          record(map.data)[string(source.key)],
        );
      } else
        throw new HarnessError("agent_effective_configuration_unverifiable");
    }
    return {
      api_url: string(selected.PGCF_API_URL),
      region_id: string(selected.PGCF_REGION_ID),
    };
  }
  async clusterIdentity(
    namespace: string,
    deploymentName: string,
  ): Promise<ClusterIdentity> {
    const [namespaces, nodes, settings] = await Promise.all([
      this.read("namespaces"),
      this.read("nodes"),
      this.agentSettings(namespace, deploymentName),
    ]);
    const system = items(namespaces).find(
        (row) => objectName(row) === "kube-system",
      ),
      regional = items(namespaces).find((row) => objectName(row) === namespace);
    if (!system || !regional)
      throw new HarnessError("cluster_namespace_missing");
    return {
      cluster_uid: string(record(system.metadata).uid),
      namespace_uid: string(record(regional.metadata).uid),
      agent_uid: settings.uid,
      nodes: Object.fromEntries(
        items(nodes).map((node) => [
          objectName(node),
          string(record(node.metadata).uid),
        ]),
      ),
      agent_api_url: settings.effective.api_url,
      region_id: settings.effective.region_id,
    };
  }
  async agentPod(
    namespace: string,
    deploymentName: string,
  ): Promise<Record<string, unknown>> {
    assertOwned(namespace);
    assertOwned(deploymentName);
    const [deployments, replicaSets, pods] = await Promise.all([
      this.read("deployments"),
      this.read("replicasets"),
      this.read("pods"),
    ]);
    const deploymentsInScope = items(deployments).filter(
      (deployment) =>
        record(deployment.metadata).namespace === namespace &&
        objectName(deployment) === deploymentName,
    );
    if (deploymentsInScope.length !== 1)
      throw new HarnessError("agent_deployment_missing");
    const deployment = deploymentsInScope[0]!;
    const uid = string(record(deployment.metadata).uid);
    const sets = items(replicaSets).filter(
      (set) =>
        record(set.metadata).namespace === namespace &&
        Array.isArray(record(set.metadata).ownerReferences) &&
        (record(set.metadata).ownerReferences as unknown[])
          .map(record)
          .some(
            (owner) =>
              owner.kind === "Deployment" &&
              owner.name === deploymentName &&
              owner.uid === uid &&
              owner.controller === true,
          ),
    );
    const setIds = new Set(sets.map((set) => string(record(set.metadata).uid)));
    const agents = items(pods).filter((pod) => {
      const metadata = record(pod.metadata);
      const labels = record(metadata.labels ?? {});
      return (
        metadata.namespace === namespace &&
        labels["app.kubernetes.io/name"] === deploymentName &&
        labels["app.kubernetes.io/part-of"] === "pgcf" &&
        !metadata.deletionTimestamp &&
        Array.isArray(metadata.ownerReferences) &&
        metadata.ownerReferences
          .map(record)
          .some(
            (owner) =>
              owner.kind === "ReplicaSet" &&
              setIds.has(string(owner.uid)) &&
              owner.controller === true,
          )
      );
    });
    if (agents.length !== 1) throw new HarnessError("agent_pod_ambiguous");
    return agents[0]!;
  }
  async restartAgent(
    namespace: string,
    deploymentName: string,
    victim: { name: string; uid: string },
  ): Promise<string> {
    await this.guard();
    const pod = await this.agentPod(namespace, deploymentName);
    if (
      objectName(pod) !== victim.name ||
      record(pod.metadata).uid !== victim.uid
    )
      throw new HarnessError("agent_pod_identity_changed");
    const name = objectName(pod),
      podUid = string(record(pod.metadata).uid);
    assertOwned(name);
    const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(name)}`;
    await this.guard();
    await command(
      "kubectl",
      [
        "--kubeconfig",
        this.configPath,
        "--context",
        this.context,
        "--request-timeout=30s",
        "delete",
        "--raw",
        path,
        "-f",
        "-",
      ],
      {
        timeoutMs: requestTimeout(this.deadline),
        input: JSON.stringify({
          apiVersion: "v1",
          kind: "DeleteOptions",
          gracePeriodSeconds: 0,
          preconditions: { uid: podUid },
        }),
      },
    );
    return podUid;
  }
  async agentSettings(
    namespace: string,
    deploymentName: string,
  ): Promise<{
    uid: string;
    container: string;
    override: Record<string, unknown> | null;
    effective: { api_url: string; region_id: string };
  }> {
    assertOwned(namespace);
    assertOwned(deploymentName);
    const deployment = items(await this.read("deployments")).find(
      (object) =>
        objectName(object) === deploymentName &&
        record(object.metadata).namespace === namespace,
    );
    if (!deployment) throw new HarnessError("agent_deployment_missing");
    if (
      record(record(deployment.metadata).labels)[
        "app.kubernetes.io/part-of"
      ] !== "pgcf"
    )
      throw new HarnessError("agent_deployment_not_owned");
    const spec = record(record(record(deployment.spec).template).spec);
    if (!Array.isArray(spec.containers))
      throw new HarnessError("agent_container_missing");
    const agent = spec.containers
      .map(record)
      .find((container) => container.name === "agent");
    if (!agent) throw new HarnessError("agent_container_missing");
    const variables = Array.isArray(agent.env) ? agent.env.map(record) : [];
    const override =
      variables.find((variable) => variable.name === "PGCF_API_URL") ?? null;
    return {
      uid: string(record(deployment.metadata).uid),
      container: string(agent.name),
      override,
      effective: await this.effectiveConfig(agent, namespace),
    };
  }
  async patchAgentUrl(
    namespace: string,
    deploymentName: string,
    expectedUid: string,
    container: string,
    override: Record<string, unknown> | null,
  ): Promise<void> {
    await this.guard();
    assertOwned(namespace);
    assertOwned(deploymentName);
    const deployment = items(await this.read("deployments")).find(
      (object) =>
        objectName(object) === deploymentName &&
        record(object.metadata).namespace === namespace,
    );
    if (!deployment || record(deployment.metadata).uid !== expectedUid)
      throw new HarnessError("agent_identity_changed");
    if (override && override.name !== "PGCF_API_URL")
      throw new HarnessError("agent_patch_scope_refused");
    const patch = {
      metadata: {
        uid: expectedUid,
        resourceVersion: string(record(deployment.metadata).resourceVersion),
      },
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: container,
                env: [override ?? { name: "PGCF_API_URL", $patch: "delete" }],
              },
            ],
          },
        },
      },
    };
    await this.guard();
    await command(
      "kubectl",
      [
        "--kubeconfig",
        this.configPath,
        "--context",
        this.context,
        "--request-timeout=30s",
        "patch",
        "deployment",
        deploymentName,
        "--namespace",
        namespace,
        "--type=strategic",
        "--patch-file=/dev/stdin",
      ],
      {
        timeoutMs: requestTimeout(this.deadline),
        input: JSON.stringify(patch),
      },
    );
  }
  async applyPolicy(
    policy: Record<string, unknown>,
    name: string,
    namespace: string,
    runName: string,
    expectedUid?: string,
  ): Promise<string> {
    await this.guard();
    assertOwned(name);
    assertOwned(namespace);
    assertOwned(runName);
    const metadata = record(policy.metadata),
      labels = record(metadata.labels);
    if (
      policy.apiVersion !== "cilium.io/v2" ||
      policy.kind !== "CiliumNetworkPolicy" ||
      metadata.name !== name ||
      metadata.namespace !== namespace ||
      labels["pgcf.io/e2e-run"] !== runName
    )
      throw new HarnessError("policy_scope_refused");
    const existing = items(
      await this.read("ciliumnetworkpolicies.cilium.io"),
    ).find(
      (row) =>
        objectName(row) === name &&
        record(row.metadata).namespace === namespace,
    );
    if (existing) {
      assertPolicyIdentity(existing, name, namespace, runName, expectedUid);
      if (!sameStructuredValue(existing.spec, policy.spec))
        throw new HarnessError("owned_policy_configuration_changed");
      return string(record(existing.metadata).uid);
    }
    if (expectedUid) throw new HarnessError("owned_policy_missing");
    await this.guard();
    const created = record(
      JSON.parse(
        await command(
          "kubectl",
          [
            "--kubeconfig",
            this.configPath,
            "--context",
            this.context,
            "--request-timeout=30s",
            "create",
            "-f",
            "-",
            "-o",
            "json",
          ],
          {
            timeoutMs: requestTimeout(this.deadline),
            input: JSON.stringify(policy),
          },
        ),
      ),
    );
    const uid = string(record(created.metadata).uid);
    assertPolicyIdentity(created, name, namespace, runName, uid);
    return uid;
  }
  async deletePolicy(
    name: string,
    namespace: string,
    runName: string,
    expectedUid?: string,
  ): Promise<void> {
    await this.guard();
    assertOwned(name);
    assertOwned(namespace);
    assertOwned(runName);
    const policy = items(
      await this.read("ciliumnetworkpolicies.cilium.io"),
    ).find(
      (object) =>
        objectName(object) === name &&
        record(object.metadata).namespace === namespace,
    );
    if (!policy) return;
    assertPolicyIdentity(policy, name, namespace, runName, expectedUid);
    const path = `/apis/cilium.io/v2/namespaces/${encodeURIComponent(namespace)}/ciliumnetworkpolicies/${encodeURIComponent(name)}`;
    await this.guard();
    await command(
      "kubectl",
      [
        "--kubeconfig",
        this.configPath,
        "--context",
        this.context,
        "--request-timeout=30s",
        "delete",
        "--raw",
        path,
        "-f",
        "-",
      ],
      {
        timeoutMs: requestTimeout(this.deadline),
        input: JSON.stringify({
          apiVersion: "v1",
          kind: "DeleteOptions",
          preconditions: { uid: string(record(policy.metadata).uid) },
        }),
      },
    );
  }
}

// OpenEBS v1.10.1 reports the measured VG free capacity here, including units:
// https://github.com/openebs/lvm-localpv/blob/v1.10.1/pkg/apis/openebs.io/lvm/v1alpha1/lvmnode.go
export function quantityBytes(value: unknown): number {
  const text = typeof value === "number" ? String(value) : string(value);
  const match =
    /^([0-9]+(?:\.[0-9]+)?)([KMGTPE]i|[kMGTPE]|[eE][+-]?[0-9]+)?$/.exec(text);
  if (!match) throw new HarnessError("invalid_vg_quantity");
  const suffix = match[2] ?? "";
  const power = suffix.endsWith("i")
    ? "KMGTPE".indexOf(suffix[0]!) + 1
    : "kMGTPE".indexOf(suffix[0]!) + 1;
  const multiplier = /^[eE]/.test(suffix)
    ? 10 ** Number(suffix.slice(1))
    : suffix
      ? (suffix.endsWith("i") ? 1024 : 1000) ** power
      : 1;
  const valueBytes = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(valueBytes) || valueBytes < 0)
    throw new HarnessError("invalid_vg_quantity");
  return valueBytes;
}

export interface VgSample {
  node: string;
  free_bytes: number;
  resource_version: string;
}

export function vgSamples(
  value: unknown,
  expectedNodes: readonly string[],
  group: string,
): VgSample[] {
  const samples = items(value)
    .filter((node) => expectedNodes.includes(objectName(node)))
    .map((node) => {
      const groups = node.volumeGroups;
      if (!Array.isArray(groups))
        throw new HarnessError("missing_vg_measurement");
      const matches = groups.map(record).filter((vg) => vg.name === group);
      if (matches.length !== 1)
        throw new HarnessError("missing_vg_measurement");
      return {
        node: objectName(node),
        free_bytes: quantityBytes(matches[0]!.free),
        resource_version: string(record(node.metadata).resourceVersion),
      };
    });
  if (
    samples.length !== expectedNodes.length ||
    new Set(samples.map((s) => s.node)).size !== samples.length
  )
    throw new HarnessError("missing_vg_measurement");
  return samples;
}

export function nodeAddresses(
  value: unknown,
): { node: string; host: string }[] {
  const addresses: { node: string; host: string }[] = [];
  for (const node of items(value)) {
    const status = record(node.status);
    if (!Array.isArray(status.addresses))
      throw new HarnessError("missing_node_addresses");
    for (const address of status.addresses.map(record)) {
      if (
        ["ExternalIP", "InternalIP"].includes(String(address.type)) &&
        typeof address.address === "string" &&
        isIP(address.address)
      ) {
        addresses.push({ node: objectName(node), host: address.address });
      }
    }
  }
  const unique = [...new Map(addresses.map((a) => [a.host, a])).values()];
  if (!unique.length) throw new HarnessError("missing_node_addresses");
  return unique.sort((a, b) =>
    `${a.node}:${a.host}`.localeCompare(`${b.node}:${b.host}`),
  );
}

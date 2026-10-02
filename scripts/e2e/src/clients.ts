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

export class Kubernetes {
  private readonly configPath: string;
  private readonly context: string;
  private readonly deadline?: () => number;
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
  async restartAgent(
    namespace: string,
    deploymentName: string,
  ): Promise<string> {
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
    const pod = agents[0]!,
      name = objectName(pod),
      podUid = string(record(pod.metadata).uid);
    assertOwned(name);
    const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(name)}`;
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
  }> {
    assertOwned(namespace);
    assertOwned(deploymentName);
    const deployment = items(await this.read("deployments")).find(
      (object) =>
        objectName(object) === deploymentName &&
        record(object.metadata).namespace === namespace,
    );
    if (!deployment) throw new HarnessError("agent_deployment_missing");
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
    };
  }
  async patchAgentUrl(
    namespace: string,
    deploymentName: string,
    expectedUid: string,
    container: string,
    override: Record<string, unknown> | null,
  ): Promise<void> {
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
  ): Promise<void> {
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
    await command(
      "kubectl",
      [
        "--kubeconfig",
        this.configPath,
        "--context",
        this.context,
        "--request-timeout=30s",
        "apply",
        "--server-side",
        "--field-manager=pgcf-e2e",
        "-f",
        "-",
      ],
      {
        timeoutMs: requestTimeout(this.deadline),
        input: JSON.stringify(policy),
      },
    );
  }
  async deletePolicy(
    name: string,
    namespace: string,
    runName: string,
  ): Promise<void> {
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
    if (record(record(policy.metadata).labels)["pgcf.io/e2e-run"] !== runName)
      throw new HarnessError("policy_scope_refused");
    const path = `/apis/cilium.io/v2/namespaces/${encodeURIComponent(namespace)}/ciliumnetworkpolicies/${encodeURIComponent(name)}`;
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

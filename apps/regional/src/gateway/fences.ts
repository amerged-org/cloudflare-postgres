// SPDX-License-Identifier: Apache-2.0
import { KubeConfig } from "@kubernetes/client-node";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { IncomingMessage } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import {
  GATEWAY_FENCE_NAMESPACE,
  GATEWAY_FENCE_LABEL,
  GATEWAY_FENCE_SELECTOR,
  gatewayFenceName,
  gatewayIntentSchema,
  gatewayPodUidSchema,
  type GatewayIntent,
} from "@pgcf/contracts/gateway-control";
import type { Gateway } from "./server.ts";

export const MAX_GATEWAY_FENCES = 2000;
export const MAX_FENCE_LIST_BYTES = 4 * 1024 * 1024;
export const MAX_FENCE_EVENT_BYTES = 64 * 1024;
interface FenceRecord {
  readonly uid: string;
  readonly intent: Readonly<GatewayIntent>;
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid gateway fence");
  return value as Record<string, unknown>;
};
function resourceVersion(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128)
    throw new Error("invalid fence resource version");
  return value;
}
function parseFence(value: unknown): FenceRecord {
  const map = object(value),
    metadata = object(map.metadata),
    labels = object(metadata.labels),
    data = object(map.data);
  if (
    map.apiVersion !== "v1" ||
    map.kind !== "ConfigMap" ||
    metadata.namespace !== GATEWAY_FENCE_NAMESPACE ||
    labels[GATEWAY_FENCE_LABEL] !== "true" ||
    typeof data["intent.json"] !== "string" ||
    data["intent.json"].length > 1024
  )
    throw new Error("invalid gateway fence");
  resourceVersion(metadata.resourceVersion);
  const intent = gatewayIntentSchema.parse(JSON.parse(data["intent.json"]));
  const uid = gatewayPodUidSchema.parse(metadata.uid);
  if (
    metadata.name !== gatewayFenceName(intent.database) ||
    labels["pgcf.io/database-id"] !== intent.database ||
    metadata.deletionTimestamp !== undefined
  )
    throw new Error("invalid gateway fence identity");
  return { uid, intent: Object.freeze(intent) };
}

export class GatewayFenceStore {
  private records = new Map<string, FenceRecord>();
  private readonly gateway: Pick<Gateway, "beginQuiesce" | "releaseQuiesce">;
  ready = false;
  epoch = 0;
  constructor(gateway: Pick<Gateway, "beginQuiesce" | "releaseQuiesce">) {
    this.gateway = gateway;
  }
  get(database: string): Readonly<GatewayIntent> | undefined {
    return this.records.get(database)?.intent;
  }
  disconnect(): void {
    this.ready = false;
    this.epoch++;
  }
  connected(): void {
    this.ready = true;
  }
  private validate(record: FenceRecord): void {
    const old = this.records.get(record.intent.database);
    if (!old) return;
    if (
      record.uid !== old.uid ||
      record.intent.revision < old.intent.revision ||
      (record.intent.revision === old.intent.revision &&
        (record.intent.operation !== old.intent.operation ||
          record.intent.mode !== old.intent.mode))
    )
      throw new Error("gateway fence history mismatch");
  }
  private apply(record: FenceRecord): void {
    const old = this.records.get(record.intent.database)?.intent,
      next = record.intent;
    if (
      old?.mode === "quiesce" &&
      (next.mode === "running" || next.operation !== old.operation)
    )
      this.gateway.releaseQuiesce(next.database, old.operation);
    if (next.mode === "quiesce")
      this.gateway.beginQuiesce(next.database, next.operation);
    this.records.set(next.database, record);
  }
  load(values: unknown[]): void {
    this.disconnect();
    try {
      if (values.length > MAX_GATEWAY_FENCES)
        throw new Error("gateway fence capacity exhausted");
      const parsed = values.map(parseFence),
        unique = new Set(parsed.map((record) => record.intent.database));
      if (
        unique.size !== parsed.length ||
        [...this.records.keys()].some((database) => !unique.has(database))
      )
        throw new Error("incomplete gateway fence snapshot");
      for (const record of parsed) this.validate(record);
      for (const record of parsed) this.apply(record);
    } catch (error) {
      this.disconnect();
      throw error;
    }
  }
  update(value: unknown): void {
    try {
      const record = parseFence(value);
      this.validate(record);
      if (
        !this.records.has(record.intent.database) &&
        this.records.size >= MAX_GATEWAY_FENCES
      )
        throw new Error("gateway fence capacity exhausted");
      this.apply(record);
    } catch (error) {
      this.disconnect();
      throw error;
    }
  }
}

export type FenceRequest = (
  query: URLSearchParams,
  signal: AbortSignal,
) => Promise<IncomingMessage>;
/** Service-account authentication and normal Kubernetes CA verification; no external URL input. */
export function clusterFenceRequest(configuration?: KubeConfig): FenceRequest {
  const config = configuration ?? new KubeConfig();
  if (!configuration) config.loadFromCluster();
  const cluster = config.getCurrentCluster();
  if (!cluster) throw new Error("cluster unavailable");
  const base = new URL(cluster.server);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    cluster.skipTLSVerify
  )
    throw new Error("invalid cluster fence source");
  return async (query, signal) => {
    signal.throwIfAborted();
    const url = new URL(
      `/api/v1/namespaces/${GATEWAY_FENCE_NAMESPACE}/configmaps`,
      base,
    );
    url.search = query.toString();
    const options: RequestOptions = {
      method: "GET",
      signal,
      headers: { Accept: "application/json" },
      rejectUnauthorized: true,
    };
    await config.applyToHTTPSOptions(options);
    signal.throwIfAborted();
    options.rejectUnauthorized = true;
    options.agent = false;
    return new Promise((resolve, reject) => {
      const req = httpsRequest(url, options, resolve);
      req.once("error", () => reject(new Error("fence source unavailable")));
      req.end();
    });
  };
}
async function readList(
  response: IncomingMessage,
): Promise<{ items: unknown[]; version: string }> {
  if (response.statusCode !== 200) {
    response.destroy();
    throw new Error("fence list unavailable");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response) {
    const value = Buffer.from(chunk);
    bytes += value.length;
    if (bytes > MAX_FENCE_LIST_BYTES) {
      response.destroy();
      throw new Error("fence list overflow");
    }
    chunks.push(value);
  }
  const list = object(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    ),
  );
  const metadata = object(list.metadata);
  if (list.apiVersion !== "v1" || list.kind !== "ConfigMapList")
    throw new Error("invalid fence list kind");
  if (
    !Array.isArray(list.items) ||
    list.items.length > MAX_GATEWAY_FENCES ||
    (metadata.continue !== undefined && metadata.continue !== "")
  )
    throw new Error("incomplete fence list");
  return {
    items: list.items.map((value) => ({
      apiVersion: "v1",
      kind: "ConfigMap",
      ...object(value),
    })),
    version: resourceVersion(metadata.resourceVersion),
  };
}
async function readWatch(
  response: IncomingMessage,
  store: GatewayFenceStore,
): Promise<void> {
  if (response.statusCode !== 200) {
    response.destroy();
    throw new Error("fence watch unavailable");
  }
  store.connected();
  let pending = Buffer.alloc(0);
  for await (const chunk of response) {
    const value = Buffer.from(chunk);
    if (value.length > MAX_FENCE_EVENT_BYTES)
      throw new Error("fence watch overflow");
    pending = Buffer.concat([pending, value]);
    let newline: number;
    while ((newline = pending.indexOf(10)) !== -1) {
      if (newline > MAX_FENCE_EVENT_BYTES)
        throw new Error("fence event overflow");
      const event = object(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            pending.subarray(0, newline),
          ),
        ),
      );
      pending = pending.subarray(newline + 1);
      if (event.type === "ADDED" || event.type === "MODIFIED")
        store.update(event.object);
      else if (event.type === "BOOKMARK")
        resourceVersion(object(object(event.object).metadata).resourceVersion);
      else throw new Error("fence watch lost authority");
    }
    if (pending.length > MAX_FENCE_EVENT_BYTES)
      throw new Error("fence event overflow");
  }
  if (pending.length !== 0) throw new Error("incomplete fence event");
}

export function watchGatewayFences(
  store: GatewayFenceStore,
  request: FenceRequest = clusterFenceRequest(),
): { stop(): Promise<void> } {
  const stopped = new AbortController();
  const run = (async () => {
    while (!stopped.signal.aborted) {
      store.disconnect();
      let failed = false;
      const cycle = new AbortController();
      const abort = () => cycle.abort();
      stopped.signal.addEventListener("abort", abort, { once: true });
      try {
        const query = new URLSearchParams({
          labelSelector: GATEWAY_FENCE_SELECTOR,
          limit: String(MAX_GATEWAY_FENCES + 1),
        });
        const list = await readList(
          await request(
            query,
            AbortSignal.any([cycle.signal, AbortSignal.timeout(10000)]),
          ),
        );
        if (stopped.signal.aborted) break;
        store.load(list.items);
        const watchQuery = new URLSearchParams({
          labelSelector: GATEWAY_FENCE_SELECTOR,
          watch: "true",
          resourceVersion: list.version,
          allowWatchBookmarks: "true",
          timeoutSeconds: "30",
        });
        const response = await request(
          watchQuery,
          AbortSignal.any([cycle.signal, AbortSignal.timeout(45000)]),
        );
        if (stopped.signal.aborted) {
          response.destroy();
          break;
        }
        await readWatch(response, store);
      } catch {
        failed = true;
        store.disconnect();
      } finally {
        cycle.abort();
        stopped.signal.removeEventListener("abort", abort);
        store.disconnect();
      }
      if (failed && !stopped.signal.aborted) {
        try {
          await delay(1000, undefined, { signal: stopped.signal });
        } catch {
          /* Stop cancels retry delay. */
        }
      }
    }
  })();
  return {
    async stop() {
      stopped.abort();
      store.disconnect();
      await run;
    },
  };
}

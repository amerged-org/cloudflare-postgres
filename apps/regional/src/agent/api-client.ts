// SPDX-License-Identifier: Apache-2.0
import {
  DesiredResponse,
  ObservationRequest,
  AgentActivityRequest,
  AgentUsageRequest,
} from "@pgcf/contracts";
import type { AgentConfig } from "./config.ts";

export const API_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export function backoff(
  attempt: number,
  base: number,
  maximum: number,
  random = Math.random,
): number {
  return (
    Math.min(maximum, base * 2 ** Math.min(20, attempt)) *
    (0.75 + random() * 0.25)
  );
}

export async function boundedText(
  response: Response,
  limit: number,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("response_body_missing");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error("response_body_too_large");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class AgentApi {
  private config: Pick<AgentConfig, "apiUrl" | "agentKey" | "regionId">;
  private fetcher: typeof fetch;
  constructor(
    config: Pick<AgentConfig, "apiUrl" | "agentKey" | "regionId">,
    fetcher: typeof fetch = fetch,
  ) {
    this.config = config;
    this.fetcher = fetcher;
  }

  private async request(
    path: string,
    signal: AbortSignal,
    body?: string,
  ): Promise<Response> {
    const response = await this.fetcher(new URL(path, this.config.apiUrl), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${this.config.agentKey}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body }),
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(API_TIMEOUT_MS)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`agent_api_http_${response.status}`);
    }
    return response;
  }

  async activity(
    value: AgentActivityRequest,
    signal: AbortSignal,
  ): Promise<void> {
    const parsed = AgentActivityRequest.safeParse(value);
    if (!parsed.success) throw new Error("activity_measurements_invalid");
    const body = JSON.stringify(parsed.data);
    if (Buffer.byteLength(body) > 64 * 1024)
      throw new Error("activity_measurements_too_large");
    const response = await this.request("/agent/v1/activity", signal, body);
    const reply = JSON.parse(await boundedText(response, 4096)) as {
      accepted?: unknown;
      idle_intents?: unknown;
    };
    if (
      !Number.isSafeInteger(reply.accepted) ||
      (reply.accepted as number) < 0 ||
      (reply.accepted as number) > parsed.data.databases.length ||
      !Number.isSafeInteger(reply.idle_intents) ||
      (reply.idle_intents as number) < 0 ||
      (reply.idle_intents as number) > (reply.accepted as number)
    )
      throw new Error("activity_ack_invalid");
  }
  async usage(value: AgentUsageRequest, signal: AbortSignal): Promise<void> {
    const parsed = AgentUsageRequest.safeParse(value);
    if (!parsed.success) throw new Error("usage_measurements_invalid");
    const body = JSON.stringify(parsed.data);
    if (Buffer.byteLength(body) > 64 * 1024)
      throw new Error("usage_measurements_too_large");
    const response = await this.request("/agent/v1/usage", signal, body);
    const reply = JSON.parse(await boundedText(response, 4096)) as {
      recorded?: unknown;
      duplicates?: unknown;
    };
    if (
      !Number.isSafeInteger(reply.recorded) ||
      (reply.recorded as number) < 0 ||
      !Number.isSafeInteger(reply.duplicates) ||
      (reply.duplicates as number) < 0 ||
      (reply.recorded as number) + (reply.duplicates as number) !==
        parsed.data.samples.length
    )
      throw new Error("usage_ack_invalid");
  }
  async desired(signal: AbortSignal): Promise<DesiredResponse> {
    const pullSignal = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
    let after: string | undefined;
    let region: DesiredResponse["region"] | undefined;
    const databases: DesiredResponse["databases"] = [];
    const ids = new Set<string>();
    const cursors = new Set<string>();
    // A failed or inconsistent page discards the whole pull. No partial snapshot is returned.
    for (let page = 0; page < 50; page += 1) {
      const query = new URLSearchParams({
        limit: "200",
        ...(after ? { after } : {}),
      });
      const response = await this.request(
        `/agent/v1/desired?${query}`,
        pullSignal,
      );
      const parsed = DesiredResponse.safeParse(
        JSON.parse(await boundedText(response, MAX_BODY_BYTES)),
      );
      if (!parsed.success) throw new Error("desired_response_invalid");
      const value = parsed.data;
      if (
        value.region.id !== this.config.regionId ||
        (region && JSON.stringify(region) !== JSON.stringify(value.region))
      )
        throw new Error("desired_region_changed");
      region = value.region;
      for (const database of value.databases) {
        if (ids.has(database.id)) throw new Error("desired_duplicate_database");
        ids.add(database.id);
        databases.push(database);
      }
      if (value.next === null) return { region, databases, next: null };
      if (
        !value.databases.length ||
        cursors.has(value.next) ||
        value.next === after
      )
        throw new Error("desired_cursor_invalid");
      cursors.add(value.next);
      after = value.next;
    }
    throw new Error("desired_page_bound_exceeded");
  }

  async observations(
    value: ObservationRequest,
    signal: AbortSignal,
  ): Promise<void> {
    const parsed = ObservationRequest.safeParse(value);
    if (!parsed.success) throw new Error("observations_invalid");
    const response = await this.request(
      "/agent/v1/observations",
      signal,
      JSON.stringify(parsed.data),
    );
    await response.body?.cancel();
  }
}

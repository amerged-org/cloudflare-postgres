// SPDX-License-Identifier: Apache-2.0
// Live fault injection only. Every replay is an unmodified response captured from the real API.
import { DesiredResponse, ObservationRequest } from "@pgcf/contracts";
import { Buffer } from "node:buffer";
import { runActive } from "../src/run-expiry.ts";

interface RelayEnv {
  API_URL: string;
  RUN_NAME: string;
  RUN_EXPIRES_AT: string;
  PROBE_BEARER: string;
  AGENT_KEY: string;
  RELAY: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
}
interface Snapshot {
  body: string;
  captured_at: number;
}
type Mode = "pass" | "empty" | "older" | "failure" | "out_of_order";
export interface RelayDurableState {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<boolean>;
  };
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}
interface RelayRecord {
  empty?: Snapshot;
  older?: Snapshot;
  fresh?: Snapshot;
  databaseId?: string;
  mode: Mode;
  swapped: boolean;
  highest: [string, number][];
  cycleId: string;
  pulls: number;
  replayed: number;
  transportFailures: number;
  observations: number;
  regressed: number;
  completedResponses: number;
  observationsAfterResponse: number;
  lastObservedResponse: number;
  cycleFailures: number;
}
interface StoredRelay {
  version: 1;
  run: string;
  expires_at: string;
  kind: "relay";
  saved_at: number;
  nonce: string;
  ciphertext: string;
}
const STORAGE_KEY = "relay-state";
const MODES: readonly Mode[] = [
  "pass",
  "empty",
  "older",
  "failure",
  "out_of_order",
];
const COUNTERS = [
  "pulls",
  "replayed",
  "transportFailures",
  "observations",
  "regressed",
  "completedResponses",
  "observationsAfterResponse",
  "lastObservedResponse",
  "cycleFailures",
] as const;

function relayRecord(value: unknown): RelayRecord {
  const row = value as RelayRecord;
  if (
    !row ||
    Object.keys(row).some(
      (key) =>
        ![
          ...COUNTERS,
          "empty",
          "older",
          "fresh",
          "databaseId",
          "mode",
          "swapped",
          "highest",
          "cycleId",
        ].includes(key),
    ) ||
    !MODES.includes(row.mode) ||
    typeof row.swapped !== "boolean" ||
    typeof row.cycleId !== "string" ||
    (row.cycleId !== "" && !/^[a-f0-9]{48}$/.test(row.cycleId)) ||
    (row.databaseId !== undefined && typeof row.databaseId !== "string") ||
    !COUNTERS.every((key) => Number.isSafeInteger(row[key]) && row[key] >= 0) ||
    !Array.isArray(row.highest) ||
    new Set(row.highest.map((entry) => entry[0])).size !== row.highest.length ||
    row.highest.some(
      (entry) =>
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== "string" ||
        !Number.isSafeInteger(entry[1]) ||
        entry[1] < 0,
    )
  )
    throw new Error("relay_state_invalid");
  for (const snapshot of [row.empty, row.older, row.fresh]) {
    if (snapshot === undefined) continue;
    if (
      typeof snapshot.body !== "string" ||
      !Number.isSafeInteger(snapshot.captured_at) ||
      snapshot.captured_at < 0 ||
      snapshot.captured_at > Date.now()
    )
      throw new Error("relay_state_invalid");
    DesiredResponse.parse(JSON.parse(snapshot.body));
  }
  return row;
}

export function currentSnapshot(
  snapshot: Snapshot | undefined,
  now: number,
): string {
  if (
    !snapshot ||
    now - snapshot.captured_at > 900_000 ||
    now < snapshot.captured_at
  )
    throw new Error("real_snapshot_unavailable");
  return snapshot.body;
}

export class ChaosRelay {
  private env: RelayEnv;
  private storage: RelayDurableState["storage"];
  private initialized: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private requests: Promise<void> = Promise.resolve();
  private key?: ReturnType<typeof crypto.subtle.deriveKey>;
  private invalid = false;
  private epoch = 0;
  private empty?: Snapshot;
  private older?: Snapshot;
  private fresh?: Snapshot;
  private databaseId?: string;
  private mode: Mode = "pass";
  private swapped = false;
  private pulls = 0;
  private replayed = 0;
  private transportFailures = 0;
  private observations = 0;
  private regressed = 0;
  private highest = new Map<string, number>();
  private cycleId = "";
  private completedResponses = 0;
  private observationsAfterResponse = 0;
  private lastObservedResponse = 0;
  private cycleFailures = 0;
  constructor(state: RelayDurableState, env: RelayEnv) {
    if (!state?.storage || typeof state.blockConcurrencyWhile !== "function")
      throw new Error("relay_storage_required");
    this.env = env;
    this.storage = state.storage;
    this.initialized = state.blockConcurrencyWhile(async () => {
      try {
        await this.restore();
      } catch {
        this.invalid = true;
      }
    });
  }

  private cryptoKey() {
    this.key ??= (async () => {
      if (!this.env.PROBE_BEARER || this.env.PROBE_BEARER.length < 32)
        throw new Error("relay_state_invalid");
      const encoder = new TextEncoder();
      const material = await crypto.subtle.importKey(
        "raw",
        encoder.encode(this.env.PROBE_BEARER),
        "HKDF",
        false,
        ["deriveKey"],
      );
      return crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: encoder.encode(this.env.RUN_NAME),
          info: encoder.encode(`pgcf-relay-v1:${this.env.RUN_EXPIRES_AT}`),
        },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    })();
    return this.key;
  }

  private aad(
    record: Pick<
      StoredRelay,
      "version" | "run" | "expires_at" | "kind" | "saved_at"
    >,
  ) {
    return new TextEncoder().encode(
      JSON.stringify([
        record.version,
        record.run,
        record.expires_at,
        this.env.API_URL,
        record.kind,
        record.saved_at,
      ]),
    );
  }

  private record(): RelayRecord {
    return {
      empty: this.empty,
      older: this.older,
      fresh: this.fresh,
      databaseId: this.databaseId,
      mode: this.mode,
      swapped: this.swapped,
      highest: [...this.highest],
      cycleId: this.cycleId,
      pulls: this.pulls,
      replayed: this.replayed,
      transportFailures: this.transportFailures,
      observations: this.observations,
      regressed: this.regressed,
      completedResponses: this.completedResponses,
      observationsAfterResponse: this.observationsAfterResponse,
      lastObservedResponse: this.lastObservedResponse,
      cycleFailures: this.cycleFailures,
    };
  }

  private async restore(): Promise<void> {
    if (!runActive(this.env.RUN_EXPIRES_AT)) {
      await this.storage.delete(STORAGE_KEY);
      return;
    }
    const stored = await this.storage.get<StoredRelay>(STORAGE_KEY);
    if (stored === undefined) return;
    if (
      stored.version !== 1 ||
      stored.run !== this.env.RUN_NAME ||
      stored.expires_at !== this.env.RUN_EXPIRES_AT ||
      stored.kind !== "relay" ||
      !Number.isSafeInteger(stored.saved_at) ||
      stored.saved_at < 0 ||
      stored.saved_at > Date.now() ||
      typeof stored.nonce !== "string" ||
      typeof stored.ciphertext !== "string"
    )
      throw new Error("relay_state_invalid");
    const nonce = new Uint8Array(Buffer.from(stored.nonce, "base64"));
    const ciphertext = new Uint8Array(Buffer.from(stored.ciphertext, "base64"));
    if (
      nonce.length !== 12 ||
      Buffer.from(nonce).toString("base64") !== stored.nonce ||
      ciphertext.length < 16 ||
      Buffer.from(ciphertext).toString("base64") !== stored.ciphertext
    )
      throw new Error("relay_state_invalid");
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: this.aad(stored) },
      await this.cryptoKey(),
      ciphertext,
    );
    const restored = relayRecord(
      JSON.parse(new TextDecoder().decode(plaintext)),
    );
    const { highest, ...fields } = restored;
    Object.assign(this, fields);
    this.highest = new Map(highest);
  }

  private async persist(): Promise<void> {
    const value = JSON.stringify(this.record());
    this.writes = this.writes.then(async () => {
      if (!runActive(this.env.RUN_EXPIRES_AT))
        throw new Error("relay_state_expired");
      const metadata = {
        version: 1,
        run: this.env.RUN_NAME,
        expires_at: this.env.RUN_EXPIRES_AT,
        kind: "relay",
        saved_at: Date.now(),
      } as const;
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: this.aad(metadata) },
        await this.cryptoKey(),
        new TextEncoder().encode(value),
      );
      await this.storage.put<StoredRelay>(STORAGE_KEY, {
        ...metadata,
        nonce: Buffer.from(nonce).toString("base64"),
        ciphertext: Buffer.from(ciphertext).toString("base64"),
      });
    });
    try {
      await this.writes;
    } catch {
      this.invalid = true;
      throw new Error("relay_state_unavailable");
    }
  }

  private async clear(): Promise<void> {
    this.epoch++;
    await this.writes.catch(() => undefined);
    await this.storage.delete(STORAGE_KEY);
    this.empty = this.older = this.fresh = undefined;
    this.databaseId = undefined;
    this.mode = "pass";
    this.swapped = false;
    this.highest.clear();
    this.cycleId = "";
    for (const key of COUNTERS) this[key] = 0;
    this.writes = Promise.resolve();
    this.invalid = false;
  }

  private async desired(): Promise<DesiredResponse> {
    const response = await fetch(
      new URL("/agent/v1/desired", this.env.API_URL),
      {
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${this.env.AGENT_KEY}` },
      },
    );
    if (!response.ok) throw new Error("real_desired_capture_failed");
    const desired = DesiredResponse.parse(await response.json());
    if (desired.next !== null)
      throw new Error("capture_requires_complete_real_snapshot");
    return desired;
  }

  async fetch(request: Request): Promise<Response> {
    const operation = this.requests.then(() => this.handle(request));
    this.requests = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async handle(request: Request): Promise<Response> {
    await this.initialized;
    if (!runActive(this.env.RUN_EXPIRES_AT)) {
      await this.clear();
      return new Response(null, { status: 410 });
    }
    const path = new URL(request.url).pathname;
    if (path.startsWith("/control/")) {
      if (
        !this.env.PROBE_BEARER ||
        request.headers.get("Authorization") !==
          `Bearer ${this.env.PROBE_BEARER}`
      )
        return new Response(null, { status: 401 });
      if (request.method !== "POST") return new Response(null, { status: 405 });
      if (path === "/control/stop") {
        await this.clear();
        return Response.json({ count: 0 });
      }
      if (this.invalid) throw new Error("relay_state_invalid");
      await this.writes;
      if (path === "/control/capture-empty") {
        const source = await this.desired();
        if (source.databases.length !== 0)
          throw new Error("real_empty_snapshot_required");
        this.empty = { body: JSON.stringify(source), captured_at: Date.now() };
        await this.persist();
        return Response.json({ count: 0 });
      }
      if (path === "/control/capture-older") {
        const body = (await request.json()) as { database_id: string };
        const source = await this.desired();
        if (
          !source.databases.some((database) => database.id === body.database_id)
        )
          throw new Error("real_run_database_missing");
        this.databaseId = body.database_id;
        this.older = { body: JSON.stringify(source), captured_at: Date.now() };
        await this.persist();
        return Response.json({ count: source.databases.length });
      }
      if (path === "/control/capture-fresh") {
        const older = DesiredResponse.parse(
          JSON.parse(currentSnapshot(this.older, Date.now())),
        );
        const source = await this.desired();
        const oldDatabase = older.databases.find(
          (database) => database.id === this.databaseId,
        );
        const freshDatabase = source.databases.find(
          (database) => database.id === this.databaseId,
        );
        if (
          !oldDatabase ||
          !freshDatabase ||
          freshDatabase.generation <= oldDatabase.generation
        )
          throw new Error("real_revision_change_required");
        this.fresh = { body: JSON.stringify(source), captured_at: Date.now() };
        await this.persist();
        return Response.json({ count: source.databases.length });
      }
      if (path === "/control/mode") {
        const body = (await request.json()) as { mode: Mode; cycle_id: string };
        if (
          !["pass", "empty", "older", "failure", "out_of_order"].includes(
            body.mode,
          )
        )
          return new Response(null, { status: 400 });
        if (body.mode === "empty") currentSnapshot(this.empty, Date.now());
        if (body.mode === "older") currentSnapshot(this.older, Date.now());
        if (body.mode === "out_of_order") {
          currentSnapshot(this.older, Date.now());
          currentSnapshot(this.fresh, Date.now());
        }
        if (!/^[a-f0-9]{48}$/.test(body.cycle_id))
          return new Response(null, { status: 400 });
        this.cycleId = body.cycle_id;
        this.completedResponses = 0;
        this.observationsAfterResponse = 0;
        this.lastObservedResponse = 0;
        this.cycleFailures = 0;
        this.mode = body.mode;
        this.swapped = false;
        await this.persist();
        return Response.json({ pulls: this.pulls });
      }
      if (path === "/control/counts")
        return Response.json({
          agent_key_configured: Boolean(this.env.AGENT_KEY),
          completed_responses: this.completedResponses,
          observations_after_response: this.observationsAfterResponse,
          failure_responses: this.cycleFailures,
          pulls: this.pulls,
          replayed: this.replayed,
          transport_failures: this.transportFailures,
          observations: this.observations,
          regressed_generations: this.regressed,
        });
      return new Response(null, { status: 404 });
    }
    if (
      !this.env.AGENT_KEY ||
      request.headers.get("Authorization") !== `Bearer ${this.env.AGENT_KEY}`
    )
      return new Response(null, { status: 401 });
    if (this.invalid) throw new Error("relay_state_invalid");
    await this.writes;
    if (
      ![
        "/agent/v1/desired",
        "/agent/v1/observations",
        "/agent/v1/link",
      ].includes(path)
    )
      return new Response(null, { status: 404 });
    if (path === "/agent/v1/desired") {
      this.pulls++;
      if (this.mode === "failure") {
        this.transportFailures++;
        this.cycleFailures++;
        await this.persist();
        throw new Error("injected_desired_transport_failure");
      }
      if (this.mode !== "pass") {
        this.replayed++;
        const source =
          this.mode === "empty"
            ? this.empty
            : this.mode === "older"
              ? this.older
              : this.swapped
                ? this.older
                : this.fresh;
        if (this.mode === "out_of_order") this.swapped = true;
        const body = currentSnapshot(source, Date.now());
        await this.persist();
        return this.trackResponse(
          new Response(body, {
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      await this.persist();
    }
    if (path === "/agent/v1/observations") {
      const observations = ObservationRequest.parse(
        await request.clone().json(),
      );
      this.observations++;
      for (const observation of observations.databases) {
        const previous = this.highest.get(observation.id) ?? 0;
        if (observation.generation < previous) this.regressed++;
        this.highest.set(
          observation.id,
          Math.max(previous, observation.generation),
        );
      }
      await this.persist();
    }
    const original = new URL(request.url);
    const target = new URL(
      `${original.pathname}${original.search}`,
      this.env.API_URL,
    );
    const response = await fetch(new Request(target, request), {
      redirect: "manual",
    });
    if (
      path === "/agent/v1/observations" &&
      response.ok &&
      this.completedResponses > this.lastObservedResponse
    ) {
      this.observationsAfterResponse++;
      this.lastObservedResponse = this.completedResponses;
      await this.persist();
    }
    return path === "/agent/v1/desired"
      ? this.trackResponse(response)
      : response;
  }
  private trackResponse(response: Response): Response {
    if (!response.body || !response.ok) return response;
    const cycle = this.cycleId;
    const epoch = this.epoch;
    const tracked = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, controller) => controller.enqueue(chunk),
        flush: async () => {
          if (this.epoch === epoch && this.cycleId === cycle) {
            this.completedResponses++;
            await this.persist();
          }
        },
      }),
    );
    return new Response(tracked, {
      status: response.status,
      headers: response.headers,
    });
  }
}

export default {
  async fetch(request: Request, env: RelayEnv): Promise<Response> {
    const id = env.RELAY.idFromName(env.RUN_NAME);
    return env.RELAY.get(id).fetch(request);
  },
};

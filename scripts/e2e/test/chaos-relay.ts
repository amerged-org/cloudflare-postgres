// SPDX-License-Identifier: Apache-2.0
// Live fault injection only. Every replay is an unmodified response captured from the real API.
import { DesiredResponse, ObservationRequest } from "@pgcf/contracts";
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
  constructor(_state: unknown, env: RelayEnv) {
    this.env = env;
  }

  private async desired(): Promise<DesiredResponse> {
    const response = await fetch(
      new URL("/agent/v1/desired", this.env.API_URL),
      {
        redirect: "error",
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
    if (!runActive(this.env.RUN_EXPIRES_AT)) {
      this.empty = undefined;
      this.older = undefined;
      this.fresh = undefined;
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
      if (path === "/control/capture-empty") {
        const source = await this.desired();
        if (source.databases.length !== 0)
          throw new Error("real_empty_snapshot_required");
        this.empty = { body: JSON.stringify(source), captured_at: Date.now() };
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
        return Response.json({ pulls: this.pulls });
      }
      if (path === "/control/counts")
        return Response.json({
          completed_responses: this.completedResponses,
          observations_after_response: this.observationsAfterResponse,
          failure_responses: this.cycleFailures,
          pulls: this.pulls,
          replayed: this.replayed,
          transport_failures: this.transportFailures,
          observations: this.observations,
          regressed_generations: this.regressed,
        });
      if (path === "/control/stop") {
        this.mode = "pass";
        this.empty = undefined;
        this.older = undefined;
        this.fresh = undefined;
        return Response.json({ count: 0 });
      }
      return new Response(null, { status: 404 });
    }
    if (
      !this.env.AGENT_KEY ||
      request.headers.get("Authorization") !== `Bearer ${this.env.AGENT_KEY}`
    )
      return new Response(null, { status: 401 });
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
        return this.trackResponse(
          new Response(currentSnapshot(source, Date.now()), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
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
    }
    const original = new URL(request.url);
    const target = new URL(
      `${original.pathname}${original.search}`,
      this.env.API_URL,
    );
    const response = await fetch(new Request(target, request), {
      redirect: "error",
    });
    if (
      path === "/agent/v1/observations" &&
      response.ok &&
      this.completedResponses > this.lastObservedResponse
    ) {
      this.observationsAfterResponse++;
      this.lastObservedResponse = this.completedResponses;
    }
    return path === "/agent/v1/desired"
      ? this.trackResponse(response)
      : response;
  }
  private trackResponse(response: Response): Response {
    if (!response.body || !response.ok) return response;
    const cycle = this.cycleId;
    const tracked = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, controller) => controller.enqueue(chunk),
        flush: () => {
          if (this.cycleId === cycle) this.completedResponses++;
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
    if (!runActive(env.RUN_EXPIRES_AT))
      return new Response(null, { status: 410 });
    const id = env.RELAY.idFromName(env.RUN_NAME);
    return env.RELAY.get(id).fetch(request);
  },
};

// SPDX-License-Identifier: Apache-2.0
import type {
  DatabaseObservation,
  DesiredDatabase,
  DesiredResponse,
  ObservationRequest,
} from "@pgcf/contracts";
import type { BuildContext } from "./builders/index.ts";
import { backoff } from "./api-client.ts";
import {
  DATABASE_LABEL,
  nodeObservations,
  orphanObservations,
} from "./observe.ts";
import { backupCredentials, Reconciler } from "./reconcile.ts";
import type { Kubernetes, Log } from "./types.ts";
import type { AuthenticationProbe } from "./readiness.ts";

export interface ControlApi {
  desired(signal: AbortSignal): Promise<DesiredResponse>;
  observations(value: ObservationRequest, signal: AbortSignal): Promise<void>;
}

interface Retry {
  generation: number;
  attempt: number;
  nextAt: number;
}

export class AgentLoop {
  private retries = new Map<string, Retry>();
  private waiting: (() => void) | undefined;
  private hinted = false;
  private reconcile: Reconciler;
  private api: ControlApi;
  private k8s: Kubernetes;
  private postgresImage: string;
  private signal: AbortSignal;
  private log: Log;
  private now: () => number;
  constructor(
    api: ControlApi,
    k8s: Kubernetes,
    postgresImage: string,
    signal: AbortSignal,
    log: Log,
    now = Date.now,
    fetcher: typeof fetch = fetch,
    authenticate?: AuthenticationProbe,
  ) {
    this.api = api;
    this.k8s = k8s;
    this.postgresImage = postgresImage;
    this.signal = signal;
    this.log = log;
    this.now = now;
    this.reconcile = new Reconciler(k8s, signal, now, fetcher, authenticate);
  }

  hint(): void {
    this.hinted = true;
    this.waiting?.();
  }

  async cycle(): Promise<boolean> {
    const desired = await this.api.desired(this.signal);
    let context: Promise<BuildContext> | undefined;
    const buildContext = () =>
      (context ??= backupCredentials(this.k8s).then(
        (credentials): BuildContext => ({
          backup: {
            bucket: desired.region.backup.bucket,
            endpointUrl: desired.region.backup.endpoint_url,
            region: desired.region.backup.region,
            credentials,
          },
          postgresImage: this.postgresImage,
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
        }),
      ));
    const observations: DatabaseObservation[] = [];
    let nonterminal = false;
    let index = 0;
    const worker = async () => {
      while (!this.signal.aborted) {
        const db = desired.databases[index++];
        if (!db) return;
        const retry = this.retries.get(db.id);
        if (
          retry &&
          retry.generation === db.generation &&
          this.now() < retry.nextAt
        ) {
          nonterminal = true;
          continue;
        }
        try {
          const observation = await this.reconcile.reconcile(
            db,
            db.desired_state === "running" ? await buildContext() : undefined,
          );
          this.retries.delete(db.id);
          if (observation) observations.push(observation);
          if (!observation || !["ready", "deleted"].includes(observation.state))
            nonterminal = true;
        } catch {
          if (this.signal.aborted) return;
          nonterminal = true;
          const attempt =
            retry?.generation === db.generation ? retry.attempt + 1 : 0;
          this.retries.set(db.id, {
            generation: db.generation,
            attempt,
            nextAt: this.now() + backoff(attempt, 5_000, 300_000),
          });
          this.log("database_reconcile_failed", {
            database_id: db.id,
            generation: db.generation,
          });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(4, desired.databases.length) }, worker),
    );
    if (this.signal.aborted) return nonterminal;
    const [namespaces, nodes, pods] = await Promise.all([
      this.k8s.list("Namespace", undefined, DATABASE_LABEL),
      this.k8s.list("Node"),
      this.k8s.list("Pod"),
    ]);
    await this.api.observations(
      {
        observed_at: new Date(this.now()).toISOString(),
        nodes: nodeObservations(nodes, pods, namespaces),
        databases: observations,
        orphans: orphanObservations(
          namespaces,
          new Set(desired.databases.map((db: DesiredDatabase) => db.id)),
        ),
      },
      this.signal,
    );
    for (const id of this.retries.keys())
      if (!desired.databases.some((db) => db.id === id))
        this.retries.delete(id);
    return nonterminal;
  }

  async run(): Promise<void> {
    let failures = 0;
    while (!this.signal.aborted) {
      this.hinted = false;
      let interval: number;
      try {
        interval = (await this.cycle()) ? 5_000 : 60_000;
        failures = 0;
      } catch {
        if (this.signal.aborted) break;
        this.log("agent_cycle_failed");
        interval = backoff(failures++, 1_000, 60_000);
      }
      if (this.hinted) continue;
      await this.wait(interval);
    }
  }

  private wait(ms: number): Promise<void> {
    if (this.signal.aborted || this.hinted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.signal.removeEventListener("abort", done);
        this.waiting = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiting = done;
      this.signal.addEventListener("abort", done, { once: true });
    });
  }
}

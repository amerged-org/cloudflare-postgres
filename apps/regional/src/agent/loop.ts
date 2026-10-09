// SPDX-License-Identifier: Apache-2.0
import type {
  DatabaseObservation,
  DesiredDatabase,
  DesiredResponse,
  ObservationRequest,
  NodeStorageSample,
} from "@pgcf/contracts";
import type { FleetNodeReleaseObservation } from "@pgcf/contracts/releases";
import {
  collectFleetInventory,
  FLEET_INVENTORY_INTERVAL_MS,
} from "./fleet-inventory.ts";
import type { BuildContext } from "./builders/index.ts";
import { backoff } from "./api-client.ts";
import {
  DATABASE_LABEL,
  nodeObservations,
  orphanObservations,
} from "./observe.ts";
import { backupCredentials, Reconciler } from "./reconcile.ts";
import { recoveryBuildContext } from "./recovery.ts";
import type { Kubernetes, Log } from "./types.ts";
import type { RegionalMeasurements } from "./measurements.ts";
import {
  beginWakePhase,
  type WakePhaseOutcome,
  type PowerCoordinator,
} from "./power.ts";
import type { AuthenticationProbe } from "./readiness.ts";
import {
  nodeStorageSample,
  type StorageMetricsKubernetes,
} from "./node-storage.ts";

export interface ControlApi {
  desired(signal: AbortSignal): Promise<DesiredResponse>;
  observations(value: ObservationRequest, signal: AbortSignal): Promise<void>;
  fleetObservations?(
    value: FleetNodeReleaseObservation,
    signal: AbortSignal,
  ): Promise<void>;
}

interface Retry {
  generation: number;
  attempt: number;
  nextAt: number;
}

export class AgentLoop {
  private retries = new Map<string, Retry>();
  private lastFleetInventory = -Infinity;
  private fleetInventoryInFlight: Promise<void> | undefined;
  private storageSamples = new Map<string, NodeStorageSample>();
  private lastStorageSample = -Infinity;
  private storageSampling: Promise<void> | undefined;
  private waiting: (() => void) | undefined;
  private hinted = false;
  private wakePending = false;
  private wakeRetryPending = false;
  private reconcile: Reconciler;
  private api: ControlApi;
  private k8s: Kubernetes;
  private postgresImage: string;
  private signal: AbortSignal;
  private log: Log;
  private now: () => number;
  private phaseNow: () => number;
  private cadenceNow: () => number;
  private measurements?: Pick<RegionalMeasurements, "update">;
  constructor(
    api: ControlApi,
    k8s: Kubernetes,
    postgresImage: string,
    signal: AbortSignal,
    log: Log,
    now = Date.now,
    fetcher: typeof fetch = fetch,
    authenticate?: AuthenticationProbe,
    power?: PowerCoordinator,
    measurements?: Pick<RegionalMeasurements, "update">,
    phaseNow = () => performance.now(),
    cadenceNow = () => performance.now(),
  ) {
    this.api = api;
    this.k8s = k8s;
    this.postgresImage = postgresImage;
    this.signal = signal;
    this.log = log;
    this.now = now;
    this.measurements = measurements;
    this.phaseNow = phaseNow;
    this.cadenceNow = cadenceNow;
    this.reconcile = new Reconciler(
      k8s,
      signal,
      now,
      fetcher,
      authenticate,
      power,
      log,
      phaseNow,
    );
  }

  hint(): void {
    this.reconcile.hint();
    this.hinted = true;
    this.waiting?.();
  }

  async cycle(): Promise<boolean> {
    this.wakePending = false;
    this.wakeRetryPending = false;
    const desired = await this.api.desired(this.signal);
    this.measurements?.update(desired.databases);
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
          computePool: desired.region.compute_pool,
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
        const waking =
          db.desired_state === "running" && db.power?.mode === "running";
        const retry = this.retries.get(db.id);
        if (
          retry &&
          retry.generation === db.generation &&
          this.now() < retry.nextAt
        ) {
          nonterminal = true;
          if (waking) {
            this.wakePending = true;
            this.wakeRetryPending = true;
          }
          continue;
        }
        try {
          const observation = await this.reconcile.reconcile(
            db,
            db.desired_state === "running"
              ? await recoveryBuildContext(
                  db,
                  await buildContext(),
                  this.k8s,
                  desired.region.recovery_sources,
                )
              : undefined,
          );
          this.retries.delete(db.id);
          if (observation) observations.push(observation);
          if (waking && (!observation || observation.state === "provisioning"))
            this.wakePending = true;
          if (
            !observation ||
            !["ready", "deleted", "hibernated"].includes(observation.state)
          )
            nonterminal = true;
        } catch {
          if (this.signal.aborted) return;
          nonterminal = true;
          if (waking) {
            this.wakePending = true;
            this.wakeRetryPending = true;
          }
          const attempt =
            retry?.generation === db.generation ? retry.attempt + 1 : 0;
          this.retries.set(db.id, {
            generation: db.generation,
            attempt,
            nextAt:
              this.now() + backoff(attempt, waking ? 1_000 : 5_000, 300_000),
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
    const phaseLog = desired.databases.some(
      (db) => db.desired_state === "running" && db.power?.mode === "running",
    )
      ? this.log
      : undefined;
    const finishPost = beginWakePhase(
      phaseLog,
      "observation_post",
      undefined,
      this.phaseNow,
    );
    let postOutcome: WakePhaseOutcome = "failed";
    try {
      const [namespaces, nodes, pods] = await Promise.all([
        this.k8s.list("Namespace", undefined, DATABASE_LABEL),
        this.k8s.list("Node"),
        this.k8s.list("Pod"),
      ]);
      await this.api.observations(
        {
          observed_at: new Date(this.now()).toISOString(),
          nodes: nodeObservations(nodes, pods, namespaces).map((node) => {
            const storage = node.node_uid
              ? this.storageSamples.get(node.node_uid)
              : undefined;
            return storage &&
              Date.parse(storage.observed_at) >= this.now() - 120_000
              ? { ...node, storage }
              : node;
          }),
          databases: observations,
          orphans: orphanObservations(
            namespaces,
            new Set(desired.databases.map((db: DesiredDatabase) => db.id)),
          ),
        },
        this.signal,
      );
      postOutcome = "completed";
      // The existing exporter performs lvs/vgs per scrape; do not put this slow read on wake's hot path.
      if (
        !this.storageSampling &&
        (this.k8s as StorageMetricsKubernetes).openEbsMetrics &&
        this.now() - this.lastStorageSample >= 60_000
      ) {
        this.lastStorageSample = this.now();
        this.storageSampling = (async () => {
          const samples = new Map<string, NodeStorageSample>();
          for (const node of nodes) {
            if (this.signal.aborted) return;
            const sample = await nodeStorageSample(
              this.k8s as StorageMetricsKubernetes,
              node,
              this.now,
            );
            if (sample) samples.set(sample.node_uid, sample);
          }
          this.storageSamples = samples;
        })()
          .catch(() => {
            if (!this.signal.aborted) this.log("node_storage_sample_failed");
          })
          .finally(() => {
            this.storageSampling = undefined;
          });
      }
    } finally {
      finishPost(postOutcome);
    }
    // Fleet inventory is bounded/coalesced outside the wake/reconcile critical path.
    if (
      desired.fleet_release &&
      this.api.fleetObservations &&
      !this.fleetInventoryInFlight &&
      this.now() - this.lastFleetInventory >= FLEET_INVENTORY_INTERVAL_MS
    ) {
      this.lastFleetInventory = this.now();
      const selected = desired.fleet_release;
      this.fleetInventoryInFlight = (async () => {
        const reports = await collectFleetInventory(
          this.k8s,
          selected,
          this.now,
          this.signal,
        );
        for (const report of reports) {
          if (this.signal.aborted) return;
          await this.api.fleetObservations!(report, this.signal);
        }
      })()
        .catch(() => {
          if (!this.signal.aborted) this.log("fleet_inventory_failed");
        })
        .finally(() => {
          this.fleetInventoryInFlight = undefined;
        });
    }
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
      const started = this.cadenceTimestamp();
      try {
        interval = (await this.cycle())
          ? this.wakePending
            ? 1_000
            : 5_000
          : 60_000;
        if (this.wakePending && !this.wakeRetryPending) {
          const finished = this.cadenceTimestamp();
          if (
            Number.isFinite(started) &&
            Number.isFinite(finished) &&
            started >= 0 &&
            finished >= started &&
            finished <= Number.MAX_SAFE_INTEGER
          )
            interval = Math.max(0, Math.ceil(1_000 - (finished - started)));
        }
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

  private cadenceTimestamp(): number {
    try {
      return this.cadenceNow();
    } catch {
      return NaN;
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

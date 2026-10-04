// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { DatabaseId } from "@pgcf/contracts";

const processEpoch = randomUUID(),
  startedAt = new Date(performance.timeOrigin).toISOString();
export const MAX_ACTIVITY_RECORDS = 2000;
interface RecordState {
  ingressBytes: number;
  egressBytes: number;
  totalConnections: number;
  closedMilliseconds: number;
  active: number;
  lastActivity: number | null;
  since: number;
  complete: boolean;
  invalid: boolean;
}
export interface MeasurementSession {
  ingress(bytes: number): void;
  egress(bytes: number): void;
  authenticate(): void;
  clientActivity(): void;
  close(): void;
  readonly authenticated: boolean;
}
interface ActiveSession {
  record?: RecordState;
  authenticatedAt?: number;
  closed: boolean;
}
export class GatewayMeasurements {
  readonly epoch = randomUUID();
  readonly processEpoch = processEpoch;
  readonly startedAt = startedAt;
  readonly counterStartedAt: string;
  private readonly records = new Map<string, RecordState>();
  private readonly sessions = new Set<ActiveSession>();
  private readonly now: () => number;
  private readonly maxRecords: number;
  private incomplete = false;
  constructor(options: { now?: () => number; maxRecords?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.maxRecords = options.maxRecords ?? MAX_ACTIVITY_RECORDS;
    if (
      !Number.isInteger(this.maxRecords) ||
      this.maxRecords < 1 ||
      this.maxRecords > MAX_ACTIVITY_RECORDS
    )
      throw new Error("invalid activity record bound");
    this.counterStartedAt = new Date(this.now()).toISOString();
  }
  get size(): number {
    return this.records.size;
  }
  begin(database: string): MeasurementSession {
    DatabaseId.parse(database);
    let record = this.records.get(database);
    if (!record) {
      if (this.records.size >= this.maxRecords) {
        for (const [id, existing] of this.records)
          if (existing.active === 0) {
            this.records.delete(id);
            break;
          }
        this.incomplete = true;
      }
      if (this.records.size < this.maxRecords) {
        record = {
          ingressBytes: 0,
          egressBytes: 0,
          totalConnections: 0,
          closedMilliseconds: 0,
          active: 0,
          lastActivity: null,
          since: this.incomplete
            ? this.now()
            : Date.parse(this.counterStartedAt),
          complete: !this.incomplete,
          invalid: false,
        };
        this.records.set(database, record);
      }
    }
    if (record) {
      record.active++;
      record.lastActivity = this.now();
    }
    const active: ActiveSession = { record, closed: false };
    this.sessions.add(active);
    let ingress = 0,
      egress = 0;
    const add = (
      field:
        | "ingressBytes"
        | "egressBytes"
        | "totalConnections"
        | "closedMilliseconds",
      amount: number,
    ) => {
      if (!record) return;
      const value = record[field] + amount;
      if (!Number.isSafeInteger(value) || value < 0) record.invalid = true;
      else record[field] = value;
    };
    const touch = () => {
      if (record) {
        record.lastActivity = this.now();
        this.records.delete(database);
        this.records.set(database, record);
      }
    };
    const bytes = (amount: number, incoming: boolean) => {
      if (active.closed) return;
      if (!Number.isSafeInteger(amount) || amount < 0)
        throw new Error("invalid activity bytes");
      if (incoming) ingress += amount;
      else egress += amount;
      if (!Number.isSafeInteger(ingress) || !Number.isSafeInteger(egress)) {
        if (record) record.invalid = true;
      }
      if (active.authenticatedAt !== undefined)
        add(incoming ? "ingressBytes" : "egressBytes", amount);
    };
    return {
      get authenticated() {
        return active.authenticatedAt !== undefined;
      },
      ingress: (amount) => bytes(amount, true),
      egress: (amount) => bytes(amount, false),
      authenticate: () => {
        if (active.closed || active.authenticatedAt !== undefined) return;
        active.authenticatedAt = this.now();
        add("ingressBytes", ingress);
        add("egressBytes", egress);
        add("totalConnections", 1);
        touch();
      },
      clientActivity: () => {
        if (!active.closed) touch();
      },
      close: () => {
        if (active.closed) return;
        active.closed = true;
        this.sessions.delete(active);
        if (record) record.active--;
        if (active.authenticatedAt !== undefined)
          add(
            "closedMilliseconds",
            Math.max(0, this.now() - active.authenticatedAt),
          );
      },
    };
  }
  read(database: string) {
    DatabaseId.parse(database);
    const observed = this.now(),
      record = this.records.get(database);
    let connectionMilliseconds: number | null =
      record?.closedMilliseconds ?? null;
    if (record)
      for (const session of this.sessions)
        if (session.record === record && session.authenticatedAt !== undefined)
          connectionMilliseconds! += Math.max(
            0,
            observed - session.authenticatedAt,
          );
    const unavailable =
      record?.invalid ||
      (record && !Number.isSafeInteger(connectionMilliseconds));
    const history = unavailable
      ? "unavailable"
      : record
        ? record.complete
          ? "complete"
          : "partial"
        : this.incomplete
          ? "unavailable"
          : "current_process_absence";
    const absent = history === "current_process_absence";
    return {
      processEpoch: this.processEpoch,
      epoch: this.epoch,
      startedAt: this.startedAt,
      counterStartedAt: this.counterStartedAt,
      observedAt: new Date(observed).toISOString(),
      history,
      countersSince:
        unavailable || (!record && !absent)
          ? null
          : record
            ? new Date(record.since).toISOString()
            : this.counterStartedAt,
      ingressBytes: unavailable
        ? null
        : (record?.ingressBytes ?? (absent ? 0 : null)),
      egressBytes: unavailable
        ? null
        : (record?.egressBytes ?? (absent ? 0 : null)),
      totalConnections: unavailable
        ? null
        : (record?.totalConnections ?? (absent ? 0 : null)),
      connectionMilliseconds: unavailable
        ? null
        : (connectionMilliseconds ?? (absent ? 0 : null)),
      lastActivityAt:
        record?.lastActivity === null || !record
          ? null
          : new Date(record.lastActivity).toISOString(),
    };
  }
}

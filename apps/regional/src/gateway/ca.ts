// SPDX-License-Identifier: Apache-2.0
import { CoreV1Api, KubeConfig, Observable } from "@kubernetes/client-node";
import { DATABASE_ID_PATTERN } from "@pgcf/contracts";
import { X509Certificate } from "node:crypto";

export interface DatabaseCaProvider {
  get(database: string, refresh?: boolean): Promise<string>;
}

export type ReadDatabaseCa = (
  name: string,
  namespace: string,
) => Promise<string>;

export function readClusterDatabaseCa(): ReadDatabaseCa {
  const configuration = new KubeConfig();
  configuration.loadFromCluster();
  const api = configuration.makeApiClient(CoreV1Api);
  return async (name, namespace) => {
    if (
      namespace !== "pgcf-system" ||
      !DATABASE_ID_PATTERN.test(name.slice(3)) ||
      !name.startsWith("ca-")
    )
      throw new Error("invalid database CA source");
    const map = await api.readNamespacedConfigMap(
      { name, namespace },
      {
        middlewareMergeStrategy: "append",
        middleware: [
          {
            pre(context) {
              context.setSignal(AbortSignal.timeout(10_000));
              return new Observable(Promise.resolve(context));
            },
            post(context) {
              return new Observable(Promise.resolve(context));
            },
          },
        ],
      },
    );
    const ca = map.data?.["ca.crt"];
    if (!ca) throw new Error("database CA unavailable");
    return ca;
  };
}

export class DatabaseCaCache implements DatabaseCaProvider {
  readonly #read: ReadDatabaseCa;
  readonly #ttl: number;
  readonly #maximum: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, { ca: string; expires: number }>();
  readonly #inflight = new Map<string, Promise<string>>();

  constructor(
    read: ReadDatabaseCa,
    options: { ttlMs?: number; maximum?: number; now?: () => number } = {},
  ) {
    this.#read = read;
    this.#ttl = options.ttlMs ?? 300_000;
    this.#maximum = options.maximum ?? 2_000;
    this.#now = options.now ?? Date.now;
    if (!Number.isInteger(this.#maximum) || this.#maximum < 1 || this.#ttl < 1)
      throw new RangeError("invalid CA cache bounds");
  }

  get size(): number {
    return this.#entries.size;
  }

  async get(database: string, refresh = false): Promise<string> {
    if (!DATABASE_ID_PATTERN.test(database))
      throw new Error("invalid database ID");
    const cached = this.#entries.get(database);
    if (!refresh && cached && cached.expires > this.#now()) return cached.ca;
    const current = this.#inflight.get(database);
    if (current) return current;
    if (this.#inflight.size >= this.#maximum)
      throw new Error("database CA request capacity exhausted");
    const read = this.#fetch(database);
    this.#inflight.set(database, read);
    try {
      return await read;
    } finally {
      this.#inflight.delete(database);
    }
  }

  async #fetch(database: string): Promise<string> {
    const ca = await this.#read(`ca-${database}`, "pgcf-system");
    if (ca.length > 65_536) throw new Error("database CA exceeds size bound");
    try {
      new X509Certificate(ca);
    } catch {
      throw new Error("invalid database CA");
    }
    this.#entries.delete(database);
    if (this.#entries.size >= this.#maximum) {
      const first = this.#entries.keys().next().value;
      if (first !== undefined) this.#entries.delete(first);
    }
    this.#entries.set(database, { ca, expires: this.#now() + this.#ttl });
    return ca;
  }
}

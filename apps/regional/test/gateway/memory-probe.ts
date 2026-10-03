// SPDX-License-Identifier: Apache-2.0
import { once } from "node:events";
import { createConnection } from "node:net";
import { networkInterfaces } from "node:os";
import type { RouteKeyring } from "@pgcf/contracts/route-token";
import { DatabaseCaCache } from "../../src/gateway/ca.ts";
import { createPostgresDial } from "../../src/gateway/postgres.ts";
import { createGateway, type Gateway } from "../../src/gateway/server.ts";

interface Configuration {
  readonly kind: "start";
  readonly region: string;
  readonly active: string;
  readonly keys: readonly [string, string][];
  readonly postgresPort: number;
  readonly ca: string;
}

let gateway: Gateway | undefined;
let baselineRss = 0;
let peakRss = 0;
const sample = () => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
};
const sampler = setInterval(sample, 10);
sampler.unref();

process.on(
  "message",
  (message: Configuration | { kind: "sample" | "stop" }) => {
    void handle(message).catch(() => {
      process.stderr.write("gateway memory probe failed\n");
      process.exitCode = 1;
      void gateway?.drain().finally(() => process.disconnect());
    });
  },
);

async function handle(
  message: Configuration | { kind: "sample" | "stop" },
): Promise<void> {
  if (message.kind === "start") {
    const loopback = Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry?.internal && entry.family === "IPv4")?.address;
    if (!loopback) throw new Error("loopback required");
    const keyring: RouteKeyring = {
      active: message.active,
      keys: new Map(
        message.keys.map(([kid, key]) => [kid, Buffer.from(key, "base64url")]),
      ),
    };
    gateway = createGateway({
      region: message.region,
      keyring,
      dial: createPostgresDial(new DatabaseCaCache(async () => message.ca), {
        tcpConnect: () =>
          createConnection({ host: loopback, port: message.postgresPort }),
      }),
      drainMs: 100,
      startupTimeoutMs: 30_000,
      log: () => sample(),
    });
    gateway.server.listen(0, loopback);
    await once(gateway.server, "listening");
    const address = gateway.server.address();
    if (!address || typeof address === "string")
      throw new Error("gateway not listening");
    baselineRss = process.memoryUsage().rss;
    sample();
    process.send?.({ kind: "ready", port: address.port, baselineRss });
  } else if (message.kind === "sample") {
    sample();
    process.send?.({
      kind: "sample",
      memoryBytes: gateway?.metrics.memoryBytes,
      peakMemoryBytes: gateway?.metrics.peakMemoryBytes,
      baselineRss,
      peakRss,
    });
  } else {
    await gateway?.drain();
    sample();
    clearInterval(sampler);
    process.send?.(
      {
        kind: "stopped",
        activeConnections: gateway?.metrics.activeConnections,
        memoryBytes: gateway?.metrics.memoryBytes,
        peakMemoryBytes: gateway?.metrics.peakMemoryBytes,
        baselineRss,
        peakRss,
      },
      () => process.disconnect(),
    );
  }
}

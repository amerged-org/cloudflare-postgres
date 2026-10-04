// SPDX-License-Identifier: Apache-2.0
import { DatabaseCaCache, readClusterDatabaseCa } from "./ca.ts";
import { readGatewayConfiguration, readGatewayPodUid } from "./config.ts";
import { createPostgresDial } from "./postgres.ts";
import { createGateway } from "./server.ts";
import { GatewayFenceStore, watchGatewayFences } from "./fences.ts";
import { createGatewayControl } from "./control.ts";

try {
  const configuration = readGatewayConfiguration(),
    pod = readGatewayPodUid();
  const ca = new DatabaseCaCache(readClusterDatabaseCa());
  const gateway = createGateway({
    ...configuration,
    dial: createPostgresDial(ca),
    fenceSynchronization: {
      get ready() {
        return store?.ready ?? false;
      },
      get epoch() {
        return store?.epoch ?? 0;
      },
    },
    control: (request, response) => control?.(request, response) ?? false,
  });
  const store = new GatewayFenceStore(gateway);
  const control = createGatewayControl({
    gateway,
    store,
    pod,
    region: configuration.region,
    keyring: configuration.keyring,
  });
  const watcher = watchGatewayFences(store);
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      await watcher.stop();
      await gateway.drain();
    })();
    void stopping.catch(() => {
      process.stderr.write(
        `${JSON.stringify({ event: "gateway_drain_failed" })}\n`,
      );
      process.exitCode = 1;
    });
  };
  gateway.server.listen(configuration.port, () => {
    process.stdout.write(
      `${JSON.stringify({ event: "gateway_listening", region: configuration.region, port: configuration.port })}\n`,
    );
  });
  gateway.server.on("error", () => {
    process.stderr.write(
      `${JSON.stringify({ event: "gateway_listen_failed" })}\n`,
    );
    process.exitCode = 1;
    stop();
  });
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
} catch {
  process.stderr.write(
    `${JSON.stringify({ event: "gateway_invalid_configuration" })}\n`,
  );
  process.exitCode = 1;
}

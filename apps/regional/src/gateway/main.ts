// SPDX-License-Identifier: Apache-2.0
import { DatabaseCaCache, readClusterDatabaseCa } from "./ca.ts";
import { readGatewayConfiguration } from "./config.ts";
import { createPostgresDial } from "./postgres.ts";
import { createGateway } from "./server.ts";

try {
  const configuration = readGatewayConfiguration();
  const ca = new DatabaseCaCache(readClusterDatabaseCa());
  const gateway = createGateway({
    ...configuration,
    dial: createPostgresDial(ca),
  });
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
  });
  process.once("SIGTERM", () => {
    void gateway.drain().catch(() => {
      process.stderr.write(
        `${JSON.stringify({ event: "gateway_drain_failed" })}\n`,
      );
      process.exitCode = 1;
    });
  });
} catch {
  process.stderr.write(
    `${JSON.stringify({ event: "gateway_invalid_configuration" })}\n`,
  );
  process.exitCode = 1;
}

// SPDX-License-Identifier: Apache-2.0
import {
  createBootstrapRelay,
  readBootstrapRelayConfiguration,
} from "./bootstrap-relay.ts";

const arguments_ = process.argv.slice(2);
if (arguments_.length === 1 && arguments_[0] === "--help") {
  process.stdout.write(
    "PGCF bootstrap byte relay. Required environment names: PGCF_BOOTSTRAP_RELAY_REGION, PGCF_BOOTSTRAP_RELAY_ISSUER_REGION, PGCF_BOOTSTRAP_RELAY_HOST, PGCF_BOOTSTRAP_RELAY_PORT, PGCF_BOOTSTRAP_RELAY_PUBLIC_KEYS, PGCF_BOOTSTRAP_RELAY_ALLOWED_TARGET_REGIONS. Allowed target regions are a required JSON array of 1–16 unique region IDs with no default or wildcard. Issuer region must equal the relay region. Public keys are a JSON kid-to-base64url Ed25519 public-key map. Clients retain end-to-end SSH host-key or TLS certificate verification.\n",
  );
} else if (arguments_.length) {
  process.stderr.write(
    `${JSON.stringify({ event: "bootstrap_relay_invalid_arguments" })}\n`,
  );
  process.exitCode = 1;
} else {
  try {
    const configuration = await readBootstrapRelayConfiguration(),
      relay = createBootstrapRelay(configuration);
    let stopping: Promise<void> | undefined;
    const stop = () => {
      stopping ??= relay.close();
      void stopping.catch(() => {
        process.stderr.write(
          `${JSON.stringify({ event: "bootstrap_relay_stop_failed" })}\n`,
        );
        process.exitCode = 1;
      });
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    relay.server.on("error", () => {
      process.stderr.write(
        `${JSON.stringify({ event: "bootstrap_relay_listen_failed" })}\n`,
      );
      process.exitCode = 1;
      stop();
    });
    relay.server.listen(configuration.port, configuration.host, () =>
      process.stdout.write(
        `${JSON.stringify({ event: "bootstrap_relay_listening", region: configuration.region, port: configuration.port })}\n`,
      ),
    );
  } catch {
    process.stderr.write(
      `${JSON.stringify({ event: "bootstrap_relay_invalid_configuration" })}\n`,
    );
    process.exitCode = 1;
  }
}

#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { startBridge } from "./bridge.ts";
import { instructions, parseArgs } from "./options.ts";

const HELP =
  "Usage: pgcf connect --endpoint wss://db.<domain> --database <db-id> --user <role> [--port <localport>]\nThe default local port is ephemeral. Enter passwords in your PostgreSQL client.\n";

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(args);
  if (options === "help") {
    process.stdout.write(HELP);
    return;
  }
  const bridge = await startBridge(options);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void bridge.close().finally(() => {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.stdout.write(instructions(bridge.port));
}

main().catch((error: unknown) => {
  const code =
    error instanceof Error && /^[a-z][a-z0-9_]{0,50}$/.test(error.message)
      ? error.message
      : "connect_failed";
  process.stderr.write(`pgcf: ${code}\n`);
  process.exitCode = 1;
});

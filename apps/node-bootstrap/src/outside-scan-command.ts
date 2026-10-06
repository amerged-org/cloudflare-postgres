// SPDX-License-Identifier: Apache-2.0
import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { BootstrapError } from "./bootstrap-error.ts";
import {
  scanOutsideFamily,
  type OutsideScanInput,
  type OutsideScanMeasurement,
  type OutsideScanOptions,
} from "./outside-scan.ts";

/** Private-file CLI input carries public control verification keys, never a global signing key. */
export async function runOutsideScanCommand(
  args: readonly string[],
  options: OutsideScanOptions = {},
): Promise<OutsideScanMeasurement> {
  if (args.length !== 1 || !args[0])
    throw new BootstrapError("outside_scan_command_input_required");
  const file = await open(args[0], "r");
  let input: OutsideScanInput;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 512 * 1024 || (stat.mode & 0o077) !== 0)
      throw new BootstrapError("outside_scan_command_input_invalid");
    const bytes = Buffer.alloc(512 * 1024 + 1);
    let received = 0;
    while (received < bytes.length) {
      const result = await file.read(
        bytes,
        received,
        bytes.length - received,
        null,
      );
      if (!result.bytesRead) break;
      received += result.bytesRead;
    }
    if (received > 512 * 1024)
      throw new BootstrapError("outside_scan_command_input_limit");
    const value: unknown = JSON.parse(
      bytes.subarray(0, received).toString("utf8"),
    );
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).join(",") !== "input"
    )
      throw new BootstrapError("outside_scan_command_input_invalid");
    input = (value as { input: OutsideScanInput }).input;
  } finally {
    await file.close();
  }
  return scanOutsideFamily(input, options);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  /\/outside-scan-command\.(?:ts|mjs)$/.test(new URL(import.meta.url).pathname)
) {
  const abort = new AbortController();
  process.once("SIGTERM", () => abort.abort());
  process.once("SIGINT", () => abort.abort());
  runOutsideScanCommand(process.argv.slice(2), { signal: abort.signal })
    .then((measurement) => {
      const body = JSON.stringify(measurement);
      if (Buffer.byteLength(body) > 256 * 1024)
        throw new BootstrapError("outside_scan_command_output_limit");
      process.stdout.write(body + "\n");
    })
    .catch((error: unknown) => {
      const code =
        error instanceof BootstrapError &&
        /^outside_scan_[a-z0-9_]{1,100}$/.test(error.code)
          ? error.code
          : "outside_scan_failed";
      process.stderr.write(JSON.stringify({ error_code: code }) + "\n");
      process.exitCode = 1;
    });
}

// SPDX-License-Identifier: Apache-2.0
import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { pathToFileURL } from "node:url";
import { OperationId } from "@pgcf/contracts";
import {
  BootstrapError,
  BootstrapJob,
  validateInput,
  type BootstrapOptions,
} from "./bootstrap.ts";

const BODY_LIMIT = 512 * 1024;
export function authorized(header: string | undefined, bearer: string) {
  const expected = Buffer.from(`Bearer ${bearer}`);
  const actual = Buffer.from(header ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function body(request: IncomingMessage) {
  let size = 0;
  const parts: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > BODY_LIMIT) throw new BootstrapError("request_body_limit");
    parts.push(bytes);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
}
function reply(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}
export function createBootstrapServer(
  bearer: string,
  options: BootstrapOptions = {},
) {
  if (bearer.length < 32) throw new BootstrapError("server_bearer_required");
  const jobs = new Map<string, { job: BootstrapJob; running: boolean }>();
  const server = createServer((request, response) => {
    const handle = async () => {
      // Authentication precedes body collection and parsing of private material.
      if (!authorized(request.headers.authorization, bearer)) {
        request.resume();
        reply(response, 401, { error_code: "unauthorized" });
        return;
      }
      const path = request.url ?? "";
      if (request.method === "POST" && path === "/v1/jobs") {
        const input = validateInput(await body(request));
        const previous = jobs.get(input.spec.operation_id);
        if (previous && previous.job.input.input_hash !== input.input_hash)
          throw new BootstrapError("job_identity_conflict");
        if (previous?.running) {
          reply(response, 202, await previous.job.status());
          return;
        }
        if (Array.from(jobs.values()).some((entry) => entry.running))
          throw new BootstrapError("container_busy");
        const job = new BootstrapJob(input, options);
        const status = await job.status();
        const entry = { job, running: true };
        jobs.set(input.spec.operation_id, entry);
        // The HTTP request starts work; every meaningful progress point is external and durable.
        void job
          .start()
          .catch(() => {})
          .finally(() => {
            entry.running = false;
          });
        reply(response, 202, status);
        return;
      }
      const matched = /^\/v1\/jobs\/([^/]+)(\/(?:cancel|admit))?$/.exec(path);
      if (!matched || !OperationId.safeParse(matched[1]).success) {
        request.resume();
        reply(response, 404, { error_code: "route_unknown" });
        return;
      }
      const entry = jobs.get(matched[1]!);
      if (!entry) {
        request.resume();
        reply(response, 404, { error_code: "job_input_required" });
        return;
      }
      if (request.method === "GET" && !matched[2]) {
        reply(response, 200, await entry.job.status());
      } else if (request.method === "POST" && matched[2] === "/cancel") {
        request.resume();
        await entry.job.cancel();
        reply(response, 202, {
          operation_id: entry.job.input.spec.operation_id,
          status: "cancelled",
        });
      } else if (request.method === "POST" && matched[2] === "/admit") {
        request.resume();
        if (entry.running) throw new BootstrapError("container_busy");
        entry.running = true;
        try {
          reply(response, 200, await entry.job.admit());
        } finally {
          entry.running = false;
        }
      } else {
        request.resume();
        reply(response, 405, { error_code: "method_refused" });
      }
    };
    void handle().catch((error: unknown) => {
      const code =
        error instanceof BootstrapError ? error.code : "request_invalid";
      if (response.headersSent) {
        response.destroy();
        return;
      }
      reply(
        response,
        code === "request_body_limit"
          ? 413
          : code === "container_busy" || code === "job_identity_conflict"
            ? 409
            : 400,
        { error_code: code },
      );
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.maxHeadersCount = 32;
  const stop = () => {
    for (const entry of jobs.values()) entry.job.abort.abort();
    server.close();
  };
  return { server, stop };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const bearer = process.env.PGCF_BOOTSTRAP_SERVER_BEARER;
    const port = Number(process.env.PORT ?? 8080);
    if (!bearer || !Number.isInteger(port) || port < 1 || port > 65535)
      throw new BootstrapError("server_configuration_invalid");
    const runtime = createBootstrapServer(bearer, {
      operator_direct:
        process.env.PGCF_BOOTSTRAP_ALLOW_OPERATOR_DIRECT === "true",
    });
    process.once("SIGTERM", runtime.stop);
    process.once("SIGINT", runtime.stop);
    runtime.server.listen(port);
  } catch {
    process.stderr.write(
      `${JSON.stringify({ event: "bootstrap_invalid_configuration" })}\n`,
    );
    process.exitCode = 1;
  }
}

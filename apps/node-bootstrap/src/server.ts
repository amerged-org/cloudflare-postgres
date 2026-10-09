// SPDX-License-Identifier: Apache-2.0
import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { pathToFileURL } from "node:url";
import { OperationId } from "@pgcf/contracts";
import { NodeInspectionInput } from "@pgcf/contracts/node-installation";
import { runInspection } from "./inspector.ts";
import { NodeProofExecutionInput } from "@pgcf/contracts/node-proof";
import { runNodeProof } from "./node-proof-runner.ts";
import { runThinStorage } from "./thin-storage.ts";
import { runFleetPatch } from "./fleet-patch.ts";
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
  options: BootstrapOptions & {
    inspection?: typeof runInspection;
    proof?: typeof runNodeProof;
    patch?: typeof runFleetPatch;
    thinStorage?: typeof runThinStorage;
  } = {},
) {
  if (bearer.length < 32) throw new BootstrapError("server_bearer_required");
  const jobs = new Map<string, { job: BootstrapJob; running: boolean }>();
  let installationRegistration = false;
  let patchRunning = false;
  let patchRegistered = false;
  const inspections = new Map<
    string,
    {
      expected_generation: number;
      binding_sha256: string;
      network_plan_sha256: string;
      running: boolean;
      status: "running" | "reported" | "failed";
      error_code: string | null;
      abort: AbortController;
    }
  >();
  const proofs = new Map<
    string,
    {
      session_id: string;
      binding_sha256: string;
      plan_sha256: string;
      input_hash: string | null;
      running: boolean;
      status: "running" | "reported" | "failed";
      error_code: string | null;
      abort: AbortController;
    }
  >();
  const server = createServer((request, response) => {
    const handle = async () => {
      // Authentication precedes body collection and parsing of private material.
      if (!authorized(request.headers.authorization, bearer)) {
        request.resume();
        reply(response, 401, { error_code: "unauthorized" });
        return;
      }
      const path = request.url ?? "";
      if (request.method === "POST" && path === "/v1/thin-storage") {
        if (
          patchRunning ||
          installationRegistration ||
          [...jobs.values()].some((v) => v.running) ||
          [...inspections.values()].some((v) => v.running) ||
          [...proofs.values()].some((v) => v.running)
        )
          throw new BootstrapError("container_busy");
        patchRunning = true;
        patchRegistered = true;
        try {
          reply(
            response,
            200,
            await (options.thinStorage ?? runThinStorage)(await body(request), {
              run: options.run,
              request: options.request,
            }),
          );
        } finally {
          patchRunning = false;
        }
        return;
      }
      if (request.method === "POST" && path === "/v1/patches") {
        if (
          patchRunning ||
          installationRegistration ||
          [...jobs.values()].some((v) => v.running) ||
          [...inspections.values()].some((v) => v.running) ||
          [...proofs.values()].some((v) => v.running)
        )
          throw new BootstrapError("container_busy");
        patchRunning = true;
        patchRegistered = true;
        try {
          reply(
            response,
            200,
            await (options.patch ?? runFleetPatch)(await body(request), {
              run: options.run,
              request: options.request,
            }),
          );
        } finally {
          patchRunning = false;
        }
        return;
      }
      if (patchRegistered) throw new BootstrapError("patch_container_only");
      if (request.method === "POST" && path === "/v1/proofs") {
        const input = NodeProofExecutionInput.parse(await body(request)),
          key = `${input.claims.operation_id}:${input.claims.mode}`,
          previous = proofs.get(key);
        if (previous?.running) {
          if (
            previous.session_id !== input.claims.session_id ||
            previous.binding_sha256 !== input.claims.binding_sha256 ||
            previous.plan_sha256 !== input.claims.plan_sha256 ||
            previous.input_hash !== input.claims.input_hash
          )
            throw new BootstrapError("proof_identity_conflict");
          reply(response, 202, {
            operation_id: input.claims.operation_id,
            mode: input.claims.mode,
            status: previous.status,
            session_id: previous.session_id,
          });
          return;
        }
        if (
          installationRegistration ||
          [...jobs.values()].some((entry) => entry.running) ||
          [...inspections.values()].some((entry) => entry.running) ||
          [...proofs.values()].some((entry) => entry.running)
        )
          throw new BootstrapError("container_busy");
        const entry = {
          session_id: input.claims.session_id,
          binding_sha256: input.claims.binding_sha256,
          plan_sha256: input.claims.plan_sha256,
          input_hash: input.claims.input_hash,
          running: true,
          status: "running" as "running" | "reported" | "failed",
          error_code: null as string | null,
          abort: new AbortController(),
        };
        proofs.set(key, entry);
        void (options.proof ?? runNodeProof)(input, {
          run: options.run,
          request: options.request,
          signal: entry.abort.signal,
        })
          .then(() => {
            entry.status = "reported";
          })
          .catch((error: unknown) => {
            entry.status = "failed";
            entry.error_code =
              error instanceof BootstrapError &&
              /^[a-z0-9_]{1,100}$/.test(error.code)
                ? error.code
                : "node_proof_failed";
          })
          .finally(() => {
            entry.running = false;
          });
        reply(response, 202, {
          operation_id: input.claims.operation_id,
          mode: input.claims.mode,
          status: entry.status,
          session_id: entry.session_id,
        });
        return;
      }
      const proof =
        /^\/v1\/proofs\/(op_[a-z0-9]{20})\/(preparation|postjoin)$/.exec(path);
      if (proof && request.method === "GET") {
        const entry = proofs.get(`${proof[1]}:${proof[2]}`);
        if (!entry) {
          reply(response, 404, { error_code: "proof_input_required" });
          return;
        }
        reply(response, 200, {
          operation_id: proof[1],
          mode: proof[2],
          session_id: entry.session_id,
          status: entry.status,
          error_code: entry.error_code,
        });
        return;
      }
      if (request.method === "POST" && path === "/v1/inspections") {
        const input = NodeInspectionInput.parse(await body(request));
        const previous = inspections.get(input.operation_id);
        if (previous?.running) {
          if (
            previous.expected_generation !== input.expected_generation ||
            previous.binding_sha256 !== input.binding_sha256 ||
            previous.network_plan_sha256 !== input.network_plan_sha256
          )
            throw new BootstrapError("inspection_identity_conflict");
          reply(response, 202, {
            operation_id: input.operation_id,
            expected_generation: previous.expected_generation,
            binding_sha256: previous.binding_sha256,
            status: previous.status,
          });
          return;
        }
        if (
          installationRegistration ||
          Array.from(jobs.values()).some((entry) => entry.running) ||
          Array.from(inspections.values()).some((entry) => entry.running) ||
          Array.from(proofs.values()).some((entry) => entry.running)
        )
          throw new BootstrapError("container_busy");
        const entry = {
          expected_generation: input.expected_generation,
          binding_sha256: input.binding_sha256,
          network_plan_sha256: input.network_plan_sha256,
          running: true,
          status: "running" as "running" | "reported" | "failed",
          error_code: null as string | null,
          abort: new AbortController(),
        };
        inspections.set(input.operation_id, entry);
        void (options.inspection ?? runInspection)(input, {
          run: options.run,
          request: options.request,
          signal: entry.abort.signal,
        })
          .then(() => {
            entry.status = "reported";
          })
          .catch((error: unknown) => {
            entry.status = "failed";
            entry.error_code =
              error instanceof BootstrapError &&
              /^[a-z0-9_]{1,100}$/.test(error.code)
                ? error.code
                : "inspection_failed";
          })
          .finally(() => {
            entry.running = false;
          });
        reply(response, 202, {
          operation_id: input.operation_id,
          expected_generation: entry.expected_generation,
          binding_sha256: entry.binding_sha256,
          status: entry.status,
        });
        return;
      }
      const inspection = /^\/v1\/inspections\/(op_[a-z0-9]{20})$/.exec(path);
      if (inspection && request.method === "GET") {
        const entry = inspections.get(inspection[1]!);
        if (!entry) {
          reply(response, 404, { error_code: "inspection_input_required" });
          return;
        }
        reply(response, 200, {
          operation_id: inspection[1],
          expected_generation: entry.expected_generation,
          binding_sha256: entry.binding_sha256,
          network_plan_sha256: entry.network_plan_sha256,
          status: entry.status,
          error_code: entry.error_code,
        });
        return;
      }
      if (request.method === "POST" && path === "/v1/jobs") {
        const input = validateInput(await body(request));
        const previous = jobs.get(input.spec.operation_id);
        if (previous && previous.job.input.input_hash !== input.input_hash)
          throw new BootstrapError("job_identity_conflict");
        if (previous?.running) {
          reply(response, 202, await previous.job.status());
          return;
        }
        if (
          installationRegistration ||
          Array.from(jobs.values()).some((entry) => entry.running) ||
          Array.from(inspections.values()).some((entry) => entry.running) ||
          Array.from(proofs.values()).some((entry) => entry.running)
        )
          throw new BootstrapError("container_busy");
        installationRegistration = true;
        try {
          const job = new BootstrapJob(input, {
            ...options,
            serialized_executor: true,
          });
          const status = await job.status();
          const installation = ![
            "awaiting_verification",
            "quarantine_release_intent",
            "quarantine_released",
          ].includes(status.checkpoint.stage);
          const entry = { job, running: installation };
          jobs.set(input.spec.operation_id, entry);
          // The HTTP request starts work; every meaningful progress point is external and durable.
          if (installation)
            void job
              .start()
              .catch(() => {})
              .finally(() => {
                entry.running = false;
              });
          reply(response, 202, status);
        } finally {
          installationRegistration = false;
        }
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
        if (
          installationRegistration ||
          [...jobs.values()].some((value) => value.running) ||
          [...proofs.values()].some((value) => value.running) ||
          [...inspections.values()].some((value) => value.running)
        )
          throw new BootstrapError("container_busy");
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
          : code === "container_busy" ||
              code === "job_identity_conflict" ||
              code === "inspection_identity_conflict" ||
              code === "proof_identity_conflict"
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
    for (const entry of inspections.values()) entry.abort.abort();
    for (const entry of proofs.values()) entry.abort.abort();
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

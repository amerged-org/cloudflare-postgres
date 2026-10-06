// SPDX-License-Identifier: Apache-2.0
import { DurableObject } from "cloudflare:workers";
import { OperationId } from "@pgcf/contracts";
import type { Env } from "./env.ts";
import {
  bootstrapJobInput,
  bootstrapJobStatus,
  readBootstrapJob,
  admissionAuthority,
} from "./domain/bootstrap-jobs.ts";
import { readNodeAddition } from "./domain/node-state.ts";
import { hasVerifiedNodePreparation } from "./domain/node-network.ts";

const nativeAdmissionCodes = new Set([
  "container_busy",
  "job_input_required",
  "job_identity_conflict",
  "request_invalid",
  "unauthorized",
  "route_unknown",
  "method_refused",
  "admission_not_authorized",
  "admission_checkpoint_mismatch",
  "admission_binding_changed",
  "admission_bundle_missing",
  "admission_precondition_changed",
  "admission_node_identity_mismatch",
  "quarantine_taint_mismatch",
  "quarantine_release_unconfirmed",
  "cluster_uid_mismatch",
  "join_bundle_identity_mismatch",
  "kubeconfig_cluster_invalid",
  "kubeconfig_identity_invalid",
  "kubeconfig_credentials_invalid",
  "checkpoint_conflict",
  "checkpoint_not_committed",
  "authority_refused",
  "authority_identity_mismatch",
  "authority_response_limit",
  "job_unauthorized",
  "node_already_admitted",
  "job_cancelled",
  "checkpoint_invalid",
  "readback_invalid",
]);
async function nativeAdmissionCode(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(new Error("native_admission_body_timeout"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      signal.throwIfAborted();
      const part = await Promise.race([reader.read(), aborted]);
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 2048) return null;
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const code: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    )?.error_code;
    if (typeof code !== "string") return null;
    if (nativeAdmissionCodes.has(code)) return code;
    const command =
      /^native_command_failed_(?:ssh|ssh_keygen|talosctl|kubectl|helm)_([1-9][0-9]{0,2})$/.exec(
        code,
      );
    return command && Number(command[1]) <= 255 ? code : null;
  } catch {
    return null;
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
  }
}

export class NodeBootstrap extends DurableObject<Env> {
  async #registrationAuthority(operationId: string, admission: boolean) {
    const row = await readBootstrapJob(this.env.DB, operationId),
      addition = await readNodeAddition(this.env.DB, operationId);
    if (
      !row.authorized ||
      row.admitted ||
      row.cancelled ||
      !["audited", "bootstrapping"].includes(addition.status)
    )
      throw new Error("bootstrap_job_closed");
    if (admission) {
      if (!(await admissionAuthority(this.env, row)).admission_authorized)
        throw new Error("bootstrap_admission_not_authorized");
    } else if (
      !(await hasVerifiedNodePreparation(
        this.env.DB,
        operationId,
        addition.intent_hash,
      ))
    )
      throw new Error("bootstrap_network_preparation_required");
    return row;
  }
  async #waitForPort(container: NonNullable<DurableObjectState["container"]>) {
    const deadline = Date.now() + 30_000,
      signal = AbortSignal.timeout(30_000),
      port = container.getTcpPort(8080);
    while (!signal.aborted && Date.now() < deadline) {
      try {
        // An unauthenticated GET reaches the server without registering or running a job.
        const response = await port.fetch(
          new Request("http://localhost:8080/", { signal }),
        );
        await response.body?.cancel();
        if (!signal.aborted && Date.now() < deadline) return;
      } catch {
        // Only read-only probes may retry; registration POSTs retain their single attempt.
      }
      const remaining = deadline - Date.now();
      if (signal.aborted || remaining <= 0) break;
      try {
        await scheduler.wait(Math.min(200, remaining), { signal });
      } catch {
        break;
      }
    }
    throw new Error("bootstrap_container_port_timeout");
  }
  async #register(operationId: string, admission = false) {
    OperationId.parse(operationId);
    if (!this.ctx.id.equals(this.env.NODE_BOOTSTRAP.idFromName(operationId)))
      throw new Error("bootstrap_container_identity_mismatch");
    const row = await this.#registrationAuthority(operationId, admission);
    const input = await bootstrapJobInput(this.env, row),
      container = this.ctx.container;
    if (!container) throw new Error("bootstrap_container_unavailable");
    if (!container.running)
      container.start({
        enableInternet: true,
        env: {
          PORT: "8080",
          PGCF_BOOTSTRAP_SERVER_BEARER: input.callback.bearer,
        },
      });
    await container.setInactivityTimeout(600_000);
    await this.ctx.storage.setAlarm(Date.now() + 600_000);
    await this.#waitForPort(container);
    const current = await this.#registrationAuthority(operationId, admission);
    if (current.input_hash !== row.input_hash)
      throw new Error("bootstrap_container_input_changed");
    const response = await container.getTcpPort(8080).fetch(
      new Request("http://localhost:8080/v1/jobs", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.callback.bearer}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(30_000),
      }),
    );
    await response.body?.cancel();
    if (!response.ok) throw new Error("bootstrap_container_refused");
    return { input, container };
  }
  async start(operationId: string) {
    OperationId.parse(operationId);
    if (!this.ctx.id.equals(this.env.NODE_BOOTSTRAP.idFromName(operationId)))
      throw new Error("bootstrap_container_identity_mismatch");
    const row = await readBootstrapJob(this.env.DB, operationId);
    if (
      [
        "awaiting_verification",
        "quarantine_release_intent",
        "quarantine_released",
      ].includes(JSON.parse(row.checkpoint_json).stage)
    )
      return bootstrapJobStatus(row);
    await this.#register(operationId);
    return bootstrapJobStatus(await readBootstrapJob(this.env.DB, operationId));
  }
  async admit(operationId: string) {
    OperationId.parse(operationId);
    if (!this.ctx.id.equals(this.env.NODE_BOOTSTRAP.idFromName(operationId)))
      throw new Error("bootstrap_container_identity_mismatch");
    const row = await readBootstrapJob(this.env.DB, operationId);
    if (!(await admissionAuthority(this.env, row)).admission_authorized)
      throw new Error("bootstrap_admission_not_authorized");
    const { input, container } = await this.#register(operationId, true);
    const signal = AbortSignal.timeout(30_000);
    const response = await container.getTcpPort(8080).fetch(
      new Request(`http://localhost:8080/v1/jobs/${operationId}/admit`, {
        method: "POST",
        headers: { Authorization: `Bearer ${input.callback.bearer}` },
        signal,
      }),
    );
    if (!response.ok) {
      const code = await nativeAdmissionCode(response, signal);
      throw new Error(
        code
          ? `bootstrap_admission_unconfirmed_${response.status}_${code}`
          : "bootstrap_admission_unconfirmed",
      );
    }
    await response.body?.cancel();
    return bootstrapJobStatus(await readBootstrapJob(this.env.DB, operationId));
  }
  async status(operationId: string) {
    OperationId.parse(operationId);
    if (!this.ctx.id.equals(this.env.NODE_BOOTSTRAP.idFromName(operationId)))
      throw new Error("bootstrap_container_identity_mismatch");
    return bootstrapJobStatus(await readBootstrapJob(this.env.DB, operationId));
  }
  override async alarm() {
    await this.ctx.container?.destroy();
  }
}

// SPDX-License-Identifier: Apache-2.0
import { keyring } from "../crypto/keyring.ts";
import type { Env } from "../env.ts";
import {
  buildJobRequest,
  classifyJobResponse,
  type JobClassification,
} from "./schedule-outcome.ts";
import { parseRetryAfter } from "./webhook-retry.ts";

export interface JobSpec {
  databaseId: string;
  role: string;
  statements: readonly string[];
  timeoutMs: number;
}

export type JobRun =
  | { kind: "ran"; result: JobClassification }
  | { kind: "skipped"; reason: "suspended" | "gone" };

/** A wake is awaited for at most 60 s, and the statements may take their own timeout. */
const WAKE_ALLOWANCE_MS = 75_000;
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;

const classified = (
  outcome: JobClassification["outcome"],
  sqlstate: string,
): JobRun => ({
  kind: "ran",
  result: { outcome, sqlstate, retryAfterSeconds: null },
});

/**
 * One run of a schedule: the statements go as one transaction through the Edge's `/sql`, as the
 * schedule's role, so the Edge admits and wakes the database as for any request. A suspended or
 * deleted database is not woken. The request is sent once; an answer that is lost is an unknown
 * outcome and the caller never sends it again.
 */
export async function runScheduleJob(env: Env, job: JobSpec): Promise<JobRun> {
  const database = await env.DB.prepare(
    "SELECT desired_state, deleted_at FROM databases WHERE id = ?",
  )
    .bind(job.databaseId)
    .first<{ desired_state: string; deleted_at: string | null }>();
  if (
    !database ||
    database.deleted_at !== null ||
    database.desired_state === "deleted"
  )
    return { kind: "skipped", reason: "gone" };
  if (database.desired_state === "suspended")
    return { kind: "skipped", reason: "suspended" };
  const role = await env.DB.prepare(
    "SELECT password_ciphertext, password_iv, password_kid FROM roles WHERE database_id = ? AND name = ? AND deleted_at IS NULL",
  )
    .bind(job.databaseId, job.role)
    .first<{
      password_ciphertext: string;
      password_iv: string;
      password_kid: string;
    }>();
  if (!role) return classified("rejected", "role_gone");
  const host = env.DB_ENDPOINT_HOST;
  if (!env.EDGE || !HOST.test(host) || host.includes(".."))
    return classified("rejected", "edge_unconfigured");
  const password = await keyring(env.CREDENTIAL_KEYS).decrypt(
    job.databaseId,
    job.role,
    {
      ciphertext: role.password_ciphertext,
      iv: role.password_iv,
      kid: role.password_kid,
    },
  );
  const request = buildJobRequest({
    connectionString: `postgres://${encodeURIComponent(job.role)}:${encodeURIComponent(password)}@${host}/${job.databaseId}`,
    statements: job.statements,
    timeoutMs: job.timeoutMs,
  });
  let response: Response;
  try {
    response = await env.EDGE.fetch(`https://${host}/sql`, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(job.timeoutMs + WAKE_ALLOWANCE_MS),
    });
  } catch {
    return {
      kind: "ran",
      result: classifyJobResponse({
        status: null,
        body: null,
        retryAfterSeconds: null,
      }),
    };
  }
  let body: unknown = null;
  if (response.status === 400) {
    try {
      body = JSON.parse((await response.text()).slice(0, 8192));
    } catch {
      body = null;
    }
  } else await response.body?.cancel().catch(() => undefined);
  return {
    kind: "ran",
    result: classifyJobResponse({
      status: response.status,
      body,
      retryAfterSeconds: parseRetryAfter(
        response.headers.get("Retry-After"),
        Date.now(),
      ),
    }),
  };
}

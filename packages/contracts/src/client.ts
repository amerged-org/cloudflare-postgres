// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import {
  ConnectionUri,
  Database,
  DatabaseCreate,
  DatabaseResize,
  DatabaseRestore,
  DatabaseRestored,
  DatabaseWithOperation,
  IdempotencyKey,
  Operation,
  Role,
  RoleCreate,
  listEnvelope,
} from "./api.ts";
import { ApiKeyString } from "./auth.ts";
import { ErrorBody, type ErrorCode } from "./errors.ts";
import { DatabaseId, NodeId, OperationId, RoleName } from "./ids.ts";
import {
  NodeOperatorKubernetesQuery,
  nodeOperatorKubernetesPath,
  parseNodeOperatorKubernetesBinding,
  type NodeOperatorKubernetesBinding,
} from "./node-operator.ts";
import {
  NodeAddition,
  NodeAdditionRequest,
  NodeLoss,
  NodeMarkLost,
} from "./nodes.ts";

export type PgcfClientErrorCode =
  | ErrorCode
  | "invalid_configuration"
  | "transport_error"
  | "timeout"
  | "response_too_large"
  | "redirect_refused"
  | "invalid_response";

export class PgcfClientError extends Error {
  readonly code: PgcfClientErrorCode;
  readonly status: number | null;
  readonly requestId: string | null;
  constructor(
    code: PgcfClientErrorCode,
    status: number | null = null,
    requestId: string | null = null,
  ) {
    super(`PGCF request failed: ${code}`);
    this.name = "PgcfClientError";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

export interface PgcfClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetch?: typeof globalThis.fetch;
}

/** Private request options for a caller-owned WebSocket connector; never log the headers. */
export interface OperatorKubernetesRequest {
  url: string;
  headers: { Authorization: string };
}

function input<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new PgcfClientError("invalid_request");
  return parsed.data;
}

export class PgcfClient {
  #base: URL;
  #apiKey: string;
  #timeoutMs: number;
  #maxResponseBytes: number;
  #fetch: typeof globalThis.fetch;
  constructor(options: PgcfClientOptions) {
    let base: URL;
    try {
      base = new URL(options.baseUrl);
    } catch {
      throw new PgcfClientError("invalid_configuration");
    }
    const key = ApiKeyString.safeParse(options.apiKey);
    const timeoutMs = options.timeoutMs ?? 30_000;
    const maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
    if (
      base.protocol !== "https:" ||
      base.username !== "" ||
      base.password !== "" ||
      base.search !== "" ||
      base.hash !== "" ||
      base.pathname !== "/" ||
      !key.success ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 120_000 ||
      !Number.isSafeInteger(maxResponseBytes) ||
      maxResponseBytes < 1 ||
      maxResponseBytes > 8 * 1024 * 1024 ||
      (options.fetch !== undefined && typeof options.fetch !== "function")
    )
      throw new PgcfClientError("invalid_configuration");
    this.#base = base;
    this.#apiKey = key.data;
    this.#timeoutMs = timeoutMs;
    this.#maxResponseBytes = maxResponseBytes;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async #body(response: Response, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) {
      void response.body?.cancel().catch(() => undefined);
      throw new PgcfClientError("timeout");
    }
    const length = response.headers.get("Content-Length");
    if (
      length !== null &&
      /^[0-9]+$/.test(length) &&
      Number(length) > this.#maxResponseBytes
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw new PgcfClientError("response_too_large", response.status);
    }
    if (response.body === null)
      throw new PgcfClientError("invalid_response", response.status);
    const reader = response.body.getReader();
    const cancel = () => {
      void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener("abort", cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > this.#maxResponseBytes) {
          void reader.cancel().catch(() => undefined);
          throw new PgcfClientError("response_too_large", response.status);
        }
        chunks.push(chunk.value);
      }
    } finally {
      signal.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      throw new PgcfClientError("invalid_response", response.status);
    }
  }

  async #request<T extends z.ZodType>(
    path: string,
    method: string,
    status: number,
    schema: T,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<z.output<T>> {
    const headers = new Headers({
      Authorization: `Bearer ${this.#apiKey}`,
      Accept: "application/json",
    });
    if (idempotencyKey !== undefined)
      headers.set("Idempotency-Key", input(IdempotencyKey, idempotencyKey));
    if (body !== undefined) headers.set("Content-Type", "application/json");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new PgcfClientError("timeout"));
      }, this.#timeoutMs);
    });
    const exchange = async (): Promise<z.output<T>> => {
      const response = await this.#fetch(new URL(path, this.#base), {
        method,
        headers,
        redirect: "manual",
        signal: controller.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (
        response.redirected ||
        response.type === "opaqueredirect" ||
        (response.status >= 300 && response.status < 400)
      ) {
        void response.body?.cancel().catch(() => undefined);
        throw new PgcfClientError("redirect_refused", response.status);
      }
      const value = await this.#body(response, controller.signal);
      if (!response.ok) {
        const parsed = ErrorBody.safeParse(value);
        if (!parsed.success)
          throw new PgcfClientError("invalid_response", response.status);
        const id = z.uuid().safeParse(parsed.data.error.request_id);
        throw new PgcfClientError(
          parsed.data.error.code,
          response.status,
          id.success ? id.data : null,
        );
      }
      const parsed = schema.safeParse(value);
      if (response.status !== status || !parsed.success)
        throw new PgcfClientError("invalid_response", response.status);
      return parsed.data;
    };
    try {
      return await Promise.race([exchange(), deadline]);
    } catch (error) {
      if (error instanceof PgcfClientError) throw error;
      throw new PgcfClientError(
        controller.signal.aborted ? "timeout" : "transport_error",
      );
    } finally {
      clearTimeout(timer!);
    }
  }

  getDatabase(id: string): Promise<Database> {
    return this.#request(
      `/v1/databases/${input(DatabaseId, id)}`,
      "GET",
      200,
      Database,
    );
  }
  createDatabase(
    body: DatabaseCreate,
    idempotencyKey: string,
  ): Promise<DatabaseWithOperation> {
    return this.#request(
      "/v1/databases",
      "POST",
      202,
      DatabaseWithOperation,
      input(DatabaseCreate, body),
      input(IdempotencyKey, idempotencyKey),
    );
  }
  resizeDatabase(
    id: string,
    body: DatabaseResize,
    idempotencyKey: string,
  ): Promise<DatabaseWithOperation> {
    return this.#request(
      `/v1/databases/${input(DatabaseId, id)}`,
      "PATCH",
      202,
      DatabaseWithOperation,
      input(DatabaseResize, body),
      input(IdempotencyKey, idempotencyKey),
    );
  }
  suspendDatabase(
    id: string,
    idempotencyKey: string,
  ): Promise<DatabaseWithOperation> {
    return this.#request(
      `/v1/databases/${input(DatabaseId, id)}/suspend`,
      "POST",
      202,
      DatabaseWithOperation,
      undefined,
      input(IdempotencyKey, idempotencyKey),
    );
  }
  resumeDatabase(
    id: string,
    idempotencyKey: string,
  ): Promise<DatabaseWithOperation> {
    return this.#request(
      `/v1/databases/${input(DatabaseId, id)}/resume`,
      "POST",
      202,
      DatabaseWithOperation,
      undefined,
      input(IdempotencyKey, idempotencyKey),
    );
  }
  deleteDatabase(
    id: string,
    idempotencyKey: string,
  ): Promise<DatabaseWithOperation> {
    return this.#request(
      `/v1/databases/${input(DatabaseId, id)}`,
      "DELETE",
      202,
      DatabaseWithOperation,
      undefined,
      input(IdempotencyKey, idempotencyKey),
    );
  }
  restoreDatabase(
    id: string,
    body: DatabaseRestore,
    idempotencyKey: string,
  ): Promise<DatabaseRestored> {
    return this.#request(
      `/v1/databases/${input(DatabaseId, id)}/restore`,
      "POST",
      202,
      DatabaseRestored,
      input(DatabaseRestore, body),
      input(IdempotencyKey, idempotencyKey),
    );
  }
  createRole(
    id: string,
    body: RoleCreate,
    idempotencyKey: string,
  ): Promise<Role> {
    return this.#request(
      `/v1/databases/${input(DatabaseId, id)}/roles`,
      "POST",
      201,
      Role,
      input(RoleCreate, body),
      input(IdempotencyKey, idempotencyKey),
    );
  }
  listRoles(id: string): Promise<{ data: Role[]; next_cursor: string | null }> {
    return this.#request(
      `/v1/databases/${input(DatabaseId, id)}/roles`,
      "GET",
      200,
      listEnvelope(Role),
    );
  }
  resetRolePassword(
    id: string,
    role: string,
    idempotencyKey: string,
  ): Promise<Role> {
    return this.#request(
      `/v1/databases/${input(DatabaseId, id)}/roles/${input(RoleName, role)}/reset-password`,
      "POST",
      200,
      Role,
      undefined,
      input(IdempotencyKey, idempotencyKey),
    );
  }
  getConnectionUri(id: string, role: string): Promise<ConnectionUri> {
    return this.#request(
      `/v1/databases/${input(DatabaseId, id)}/roles/${input(RoleName, role)}/connection-uri`,
      "GET",
      200,
      ConnectionUri,
    );
  }
  getOperation(id: string): Promise<Operation> {
    return this.#request(
      `/v1/operations/${input(OperationId, id)}`,
      "GET",
      200,
      Operation,
    );
  }
  requestNodeAddition(
    body: NodeAdditionRequest,
    idempotencyKey: string,
  ): Promise<NodeAddition> {
    return this.#request(
      "/v1/nodes/additions",
      "POST",
      202,
      NodeAddition,
      input(NodeAdditionRequest, body),
      input(IdempotencyKey, idempotencyKey),
    );
  }
  getNodeAddition(operationId: string): Promise<NodeAddition> {
    return this.#request(
      `/v1/nodes/additions/${input(OperationId, operationId)}`,
      "GET",
      200,
      NodeAddition,
    );
  }
  markNodeLost(nodeId: string, body: NodeMarkLost): Promise<NodeLoss> {
    return this.#request(
      `/v1/nodes/${input(NodeId, nodeId)}/mark-lost`,
      "POST",
      200,
      NodeLoss,
      input(NodeMarkLost, body),
    );
  }

  operatorKubernetesRequest(
    nodeId: string,
    nodeUid: string,
  ): OperatorKubernetesRequest {
    const query = input(NodeOperatorKubernetesQuery, { node_uid: nodeUid });
    const url = new URL(
      nodeOperatorKubernetesPath(input(NodeId, nodeId)),
      this.#base,
    );
    url.protocol = "wss:";
    url.searchParams.set("node_uid", query.node_uid);
    return {
      url: url.href,
      headers: { Authorization: `Bearer ${this.#apiKey}` },
    };
  }

  parseOperatorKubernetesResponse(
    headers: Pick<Headers, "get">,
    expectedNodeUid: string,
  ): NodeOperatorKubernetesBinding {
    const expected = input(NodeOperatorKubernetesQuery, {
      node_uid: expectedNodeUid,
    });
    try {
      const binding = parseNodeOperatorKubernetesBinding(headers);
      if (binding.node_uid !== expected.node_uid)
        throw new PgcfClientError("invalid_response", 101);
      return binding;
    } catch {
      throw new PgcfClientError("invalid_response", 101);
    }
  }
}

// SPDX-License-Identifier: Apache-2.0
import { createServer } from "node:https";
import { once } from "node:events";
import {
  readFileSync,
  lstatSync,
  realpathSync,
  openSync,
  closeSync,
  fstatSync,
  constants,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { TLSSocket } from "node:tls";
import { capacityAdmission } from "./capacity-admission.ts";
import type { CapacityAdmissionContext } from "./capacity-admission.ts";
export interface CapacityAdmissionServerConfiguration {
  address: string;
  port: number;
  certificateFile: string;
  privateKeyFile: string;
  clientCaFile: string;
  apiServerFingerprint256: string;
  requestDeadlineMilliseconds?: number;
  context: (
    namespace: string,
    signal: AbortSignal,
  ) => Promise<CapacityAdmissionContext | null>;
}
const failure = () => new Error("capacity_admission_server_unavailable");
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(failure());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(failure());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
function privateFile(path: string): Buffer {
  if (
    !isAbsolute(path) ||
    path !== resolve(path) ||
    realpathSync(path) !== path
  )
    throw failure();
  const parent = lstatSync(dirname(path)),
    before = lstatSync(path);
  if (
    !parent.isDirectory() ||
    (parent.mode & 0o777) !== 0o700 ||
    !before.isFile() ||
    before.nlink !== 1 ||
    (before.mode & 0o777) !== 0o600 ||
    before.size > 65536 ||
    before.size === 0 ||
    (process.getuid &&
      (before.uid !== process.getuid() || parent.uid !== process.getuid()))
  )
    throw failure();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const opened = fstatSync(fd);
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.mode !== before.mode ||
      opened.uid !== before.uid ||
      opened.nlink !== 1
    )
      throw failure();
    bytes = readFileSync(fd);
    const final = fstatSync(fd);
    if (
      final.size !== before.size ||
      final.mtimeMs !== before.mtimeMs ||
      final.mode !== before.mode ||
      final.uid !== before.uid ||
      final.nlink !== 1
    )
      throw failure();
  } finally {
    closeSync(fd);
  }
  const after = lstatSync(path),
    parentAfter = lstatSync(dirname(path));
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.mode !== after.mode ||
    after.nlink !== 1 ||
    parentAfter.dev !== parent.dev ||
    parentAfter.ino !== parent.ino ||
    parentAfter.mode !== parent.mode ||
    parentAfter.uid !== parent.uid
  )
    throw failure();
  return bytes;
}
function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw failure();
  return v as Record<string, unknown>;
}
export async function startCapacityAdmissionServer(
  config: CapacityAdmissionServerConfiguration,
): Promise<{ port: number; close: () => Promise<void> }> {
  const expected = config.apiServerFingerprint256
    .replaceAll(":", "")
    .toLowerCase();
  const timeout = config.requestDeadlineMilliseconds ?? 15000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 15000)
    throw failure();
  if (
    !/^[a-f0-9]{64}$/.test(expected) ||
    !Number.isSafeInteger(config.port) ||
    config.port < 0 ||
    config.port > 65535 ||
    !config.address ||
    typeof config.context !== "function"
  )
    throw failure();
  let active = 0;
  const server = createServer(
    {
      key: privateFile(config.privateKeyFile),
      cert: privateFile(config.certificateFile),
      ca: privateFile(config.clientCaFile),
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
    },
    async (req, res) => {
      const send = (status: number, body: unknown) => {
        if (!res.destroyed && !res.headersSent) {
          res.writeHead(status, {
            "content-type": "application/json",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          });
          res.end(JSON.stringify(body));
        }
      };
      const socket = req.socket as TLSSocket;
      if (
        !socket.authorized ||
        socket
          .getPeerCertificate()
          .fingerprint256?.replaceAll(":", "")
          .toLowerCase() !== expected
      ) {
        send(403, { error: "capacity_admission_unavailable" });
        return;
      }
      if (
        req.method !== "POST" ||
        !["/mutate", "/validate"].includes(req.url ?? "") ||
        !/^application\/json(?:;\s*charset=utf-8)?$/i.test(
          req.headers["content-type"] ?? "",
        ) ||
        req.headers["content-encoding"] !== undefined
      ) {
        send(400, { error: "capacity_admission_unavailable" });
        return;
      }
      if (active >= 16) {
        send(429, { error: "capacity_admission_unavailable" });
        return;
      }
      active++;
      const cancellation = new AbortController(),
        deadline = Date.now() + timeout;
      const timer = setTimeout(() => cancellation.abort(), timeout);
      const closed = () => cancellation.abort();
      res.once("close", closed);
      res.once("finish", () => {
        if (cancellation.signal.aborted) req.destroy();
      });
      try {
        req.setTimeout(timeout, () => {
          cancellation.abort();
          req.destroy();
        });
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > 131072) {
            send(413, { error: "capacity_admission_unavailable" });
            return;
          }
          chunks.push(bytes);
        }
        const review = JSON.parse(Buffer.concat(chunks).toString("utf8")),
          request = record(record(review).request);
        const uid = String(request.uid ?? ""),
          namespace = String(request.namespace ?? "");
        if (
          record(review).apiVersion !== "admission.k8s.io/v1" ||
          record(review).kind !== "AdmissionReview" ||
          !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(uid)
        )
          throw failure();
        let response;
        if (!/^pgcf-[a-f0-9]{32}$/.test(namespace))
          response = { uid, allowed: true };
        else {
          const context = await bounded(
            config.context(namespace, cancellation.signal),
            cancellation.signal,
          );
          const check = () => {
            if (
              cancellation.signal.aborted ||
              Date.now() >= deadline ||
              res.destroyed
            )
              throw failure();
            context?.authority.check();
          };
          check();
          response = context
            ? await bounded(
                capacityAdmission(
                  review,
                  req.url === "/mutate" ? "mutate" : "validate",
                  {
                    ...context,
                    authority: {
                      check,
                      expiresAt: () =>
                        Math.min(deadline, context.authority.expiresAt()),
                    },
                    runtime: {
                      ...context.runtime,
                      read: (...args) =>
                        bounded(
                          context.runtime.read(...args),
                          cancellation.signal,
                        ),
                      list: (...args) =>
                        bounded(
                          context.runtime.list(...args),
                          cancellation.signal,
                        ),
                    },
                    transportAuthenticated: () =>
                      socket.authorized &&
                      socket
                        .getPeerCertificate()
                        .fingerprint256?.replaceAll(":", "")
                        .toLowerCase() === expected,
                  },
                ),
                cancellation.signal,
              )
            : {
                uid,
                allowed: false,
                status: { code: 403, message: "capacity_admission_unproven" },
              };
        }
        send(200, {
          apiVersion: "admission.k8s.io/v1",
          kind: "AdmissionReview",
          response,
        });
      } catch {
        send(cancellation.signal.aborted ? 503 : 400, {
          error: "capacity_admission_unavailable",
        });
      } finally {
        clearTimeout(timer);
        res.removeListener("close", closed);
        active--;
      }
    },
  );
  server.requestTimeout = 15000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.maxHeadersCount = 32;
  server.maxConnections = 64;
  server.listen(config.port, config.address);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("capacity_admission_server_unavailable");
  return {
    port: address.port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}

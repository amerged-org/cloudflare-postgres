// SPDX-License-Identifier: Apache-2.0
import { z } from "@hono/zod-openapi";
import { ErrorBody } from "@pgcf/contracts";
import type { ApiApp } from "./app.ts";

/** Metadata for the existing public raw-image handlers; no route or validator is installed. */
export function registerFleetImageDocumentation(app: ApiApp): void {
  const headers = {
    "Content-Type": {
      schema: {
        type: "string" as const,
        enum: ["application/octet-stream", "application/x-xz"],
      },
    },
    "Content-Length": {
      schema: { type: "string" as const, pattern: "^[0-9]+$" },
    },
    "Docker-Content-Digest": {
      schema: { type: "string" as const, pattern: "^sha256:[a-f0-9]{64}$" },
    },
    "Docker-Distribution-Api-Version": {
      schema: { type: "string" as const, const: "registry/2.0" },
    },
    ETag: {
      description: "Quoted immutable SHA-256 digest",
      schema: { type: "string" as const },
    },
    "Accept-Ranges": { schema: { type: "string" as const, const: "bytes" } },
    "Cache-Control": {
      schema: {
        type: "string" as const,
        const: "public, max-age=31536000, immutable",
      },
    },
  };
  const bytes = {
    "application/octet-stream": {
      schema: z.string().openapi({ format: "binary" }),
    },
    "application/x-xz": { schema: z.string().openapi({ format: "binary" }) },
  };
  for (const method of ["get", "head"] as const) {
    app.openAPIRegistry.registerPath({
      method,
      path: "/fleet-images/v1/raw/{digest}",
      tags: ["Fleet images"],
      description:
        "Unauthenticated immutable Talos image bytes are served only when their digest, byte length and format match an approved fleet release and R2 metadata. HEAD returns headers without a body and ignores Range. GET supports one byte range; malformed or unsatisfiable ranges return an empty 416. Other methods on this path return an empty 405 with Allow: GET, HEAD.",
      request: {
        params: z.object({ digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }),
        ...(method === "get"
          ? { headers: z.object({ Range: z.string().optional() }) }
          : {}),
      },
      responses: {
        200: {
          description: "Approved immutable image",
          headers,
          ...(method === "get" ? { content: bytes } : {}),
        },
        ...(method === "get"
          ? {
              206: {
                description: "Requested byte range",
                headers: {
                  ...headers,
                  "Content-Range": { schema: { type: "string" as const } },
                },
                content: bytes,
              },
              416: {
                description:
                  "Empty response for an invalid or unsatisfiable range",
                headers: {
                  "Content-Range": {
                    schema: {
                      type: "string" as const,
                      pattern: "^bytes \\*/[0-9]+$",
                    },
                  },
                },
              },
            }
          : {}),
        404: {
          description:
            "Empty response when the digest or approved artifact is absent or inconsistent",
        },
        500: {
          description: "Internal server error",
          ...(method === "get"
            ? { content: { "application/json": { schema: ErrorBody } } }
            : {}),
        },
      },
    });
  }
}

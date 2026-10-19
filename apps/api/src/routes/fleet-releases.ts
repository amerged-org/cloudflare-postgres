// SPDX-License-Identifier: Apache-2.0
import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import {
  ErrorBody,
  ListQuery,
  NodeId,
  RegionId,
  listEnvelope,
} from "@pgcf/contracts";
import {
  FleetReleaseId,
  FleetRelease,
  FleetReleaseRegistration,
  FleetReleaseVersion,
  RELEASE_FILE_PATH,
  RELEASE_HOST_FILES_DIRECTORY,
  RELEASE_IMAGE_FILE,
  ReleaseSignature,
  FleetRegionReleaseUpdate,
  FleetRegionReleaseStatus,
  FleetNodeReleaseStatus,
} from "@pgcf/contracts/releases";
import type { ApiApp } from "../app.ts";
import type { ApiContext } from "../env.ts";
import {
  getFleetRelease,
  listFleetReleases,
  approveFleetRelease,
  getFleetRegionRelease,
  assignFleetRegionRelease,
  getFleetNodeRelease,
} from "../domain/fleet-releases.ts";
import {
  serveHostFile,
  serveInstallerImage,
  serveReleaseFile,
} from "../domain/release-files.ts";
const json = (schema: z.ZodType) => ({ "application/json": { schema } });
const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 500].map((status) => [
    status,
    { description: "Request failed", content: json(ErrorBody) },
  ]),
);
const headers = z.object({
  "Idempotency-Key": z
    .string()
    .regex(/^[A-Za-z0-9._~-]{1,128}$/)
    .optional(),
});
const body = (schema: z.ZodType) => ({ required: true, content: json(schema) });
const responses = (schema: z.ZodType) => ({
  ...errors,
  200: { description: "Successful response", content: json(schema) },
});
const common = { tags: ["Fleet releases"], security: [{ bearerAuth: [] }] };
function register(
  app: ApiApp,
  route: RouteConfig,
  handler: (c: ApiContext) => Promise<Response>,
): void {
  app.openapi(createRoute(route), handler);
}
export function registerFleetReleases(app: ApiApp): void {
  register(
    app,
    {
      ...common,
      method: "get",
      path: "/v1/fleet/releases",
      operationId: "listFleetReleases",
      summary: "List approved fleet releases",
      description:
        "Lists immutable global release approvals, newest approved timestamp and release ID first.",
      request: { query: ListQuery },
      responses: {
        200: {
          description: "Immutable global release approvals",
          content: json(listEnvelope(FleetRelease)),
        },
        400: { description: "Invalid list query", content: json(ErrorBody) },
        401: {
          description: "Authentication required",
          content: json(ErrorBody),
        },
        403: {
          description: "Administrator scope required",
          content: json(ErrorBody),
        },
        500: {
          description: "Internal request failure",
          content: json(ErrorBody),
        },
      },
    },
    listFleetReleases,
  );
  register(
    app,
    {
      ...common,
      method: "put",
      path: "/v1/fleet/releases/{id}",
      description:
        "Registers an immutable release: one node image with its binaries, package lock and host files, the same for every node. The body holds the digest and size of each file the build produced, the host files of the image's tree (the systemd units, masks and configuration a release changes on a running node, each with its path, mode, digest and the way it takes effect, ascending by path) with the digest a node that holds them reports, and the signature CI made of the release with the release key (64 bytes as 128 hex digits, required). The signature covers the release's id, its image (the sha256 and size of the compressed image and of the raw image), the four binaries, the package lock, the Debian snapshot and the host files. The API verifies it with the release public key, a constant of this Worker's code that no request changes, against the manifest rebuilt from the registration's own facts, and answers 400 and stores nothing for a signature that is missing, made by another key, made for another release, or made for other digests than these; the stored signature is shown as `spec.signature`. The same check runs again when a node is installed from the release, and a node refuses a release whose signature its agent's key does not verify. The files must already be in the archive bucket under `node-images/{id}/` (each host file under `host-files/` by its sha256), uploaded with their sha256 for R2 to verify, and the Worker names every URL of the stored spec itself. The id is the image version the node enrolls as. This records desired configuration; assigning it to a region makes the region's nodes pull it.",
      request: {
        headers,
        params: z.object({ id: FleetReleaseVersion }),
        body: body(FleetReleaseRegistration),
      },
      responses: responses(FleetRelease),
    },
    async (c) =>
      approveFleetRelease(
        c,
        FleetReleaseVersion.parse(c.req.param("id")),
        FleetReleaseRegistration.parse(await c.req.json()),
      ),
  );
  register(
    app,
    {
      ...common,
      method: "get",
      path: "/v1/fleet/releases/{id}",
      request: { params: z.object({ id: FleetReleaseId }) },
      responses: responses(FleetRelease),
    },
    async (c) => getFleetRelease(c, FleetReleaseId.parse(c.req.param("id"))),
  );
  register(
    app,
    {
      ...common,
      method: "put",
      path: "/v1/regions/{id}/release",
      request: {
        headers,
        params: z.object({ id: RegionId }),
        body: body(FleetRegionReleaseUpdate),
      },
      responses: responses(FleetRegionReleaseStatus),
    },
    async (c) =>
      assignFleetRegionRelease(
        c,
        RegionId.parse(c.req.param("id")),
        FleetRegionReleaseUpdate.parse(await c.req.json()),
      ),
  );
  register(
    app,
    {
      ...common,
      method: "get",
      path: "/v1/regions/{id}/release",
      request: { params: z.object({ id: RegionId }) },
      responses: responses(FleetRegionReleaseStatus),
    },
    async (c) => getFleetRegionRelease(c, RegionId.parse(c.req.param("id"))),
  );
  register(
    app,
    {
      ...common,
      method: "get",
      path: "/v1/nodes/{id}/release",
      description:
        "Reports how the node stands against its region's release: whether its last hello named the release (its binaries) and its link is fresh. The operating system, which is the kernel, the packages and the host files, is `os_converged` of the node: a maintenance cycle that installs the packages needs a node that runs the release's binaries, so the two are told apart.",
      request: { params: z.object({ id: NodeId }) },
      responses: responses(FleetNodeReleaseStatus),
    },
    async (c) => getFleetNodeRelease(c, NodeId.parse(c.req.param("id"))),
  );
  const octets = {
    "application/octet-stream": {
      schema: z.string().meta({ format: "binary" }),
    },
  };
  const bytes = {
    200: { description: "The whole file", content: octets },
    206: { description: "The bytes of the requested range", content: octets },
    416: {
      description:
        "The range starts beyond the end of the file; `Content-Range` names its size",
    },
  };
  // A name that is no file of a registered release is not found, however it is spelled.
  const delivery = {
    tags: ["Node"],
    request: { params: z.object({ version: z.string() }) },
  };
  const method =
    "GET and HEAD answer with the size, ETag and `Accept-Ranges: bytes`; a single `Range` of bytes is answered with 206.";
  // A host file is named by its digest: no path, no wildcard.
  register(
    app,
    {
      ...delivery,
      method: "get",
      path: `${RELEASE_FILE_PATH}/{version}/${RELEASE_HOST_FILES_DIRECTORY}/{sha256}`,
      description: `A host file of a registered release (a systemd unit or a configuration file of the image, which the agent writes in place), streamed from the archive bucket by its sha256. Only a digest that the release's own list holds is found. The agent reads these without a credential and checks the size and sha256 its signed desired page pins; they are open artifacts. ${method}`,
      request: {
        params: z.object({ version: z.string(), sha256: z.string() }),
      },
      responses: {
        ...errors,
        ...bytes,
      },
    },
    async (c) =>
      serveHostFile(c, c.req.param("version")!, c.req.param("sha256")!),
  );
  // The image has its own route: it alone needs the installer's token, and OpenAPI shows that.
  register(
    app,
    {
      ...delivery,
      method: "get",
      path: `${RELEASE_FILE_PATH}/{version}/${RELEASE_IMAGE_FILE}`,
      security: [{ EnrollmentBearer: [] }],
      description: `The zstd-compressed node image of a registered release, streamed from the archive bucket to the pull installer in the Contabo rescue system. ${method} The credential is the progress token of the install, which is bound to one node and the version it was issued for and stops working when the installer reports \`rebooting\` or \`failed\`, when the node enrolls and when the token expires.`,
      responses: {
        ...errors,
        ...bytes,
      },
    },
    async (c) => serveInstallerImage(c, c.req.param("version")!),
  );
  register(
    app,
    {
      ...delivery,
      method: "get",
      path: `${RELEASE_FILE_PATH}/{version}/{file}`,
      description: `A binary (\`pgcf-agent\`, \`pgcf-native-gateway\`, \`pgcf-archive\`, \`pgcf-wal-fetch\`) or the \`packages.lock.json\` of a registered release, streamed from the archive bucket. The agent reads these without a credential and checks the size and sha256 its desired page pins; they are open artifacts. ${method} The name \`release.sig\` answers with the release's signature as 128 hex digits of text, from the stored spec, and no range applies to it: the agent checks it against the release key compiled into its binary before it installs anything of the release.`,
      request: {
        params: z.object({ version: z.string(), file: z.string() }),
      },
      responses: {
        ...errors,
        ...bytes,
        // `release.sig` is no object of the bucket: the text of the stored signature, and no range.
        200: {
          description:
            "The whole file; `release.sig` answers with the signature as 128 hex digits of text",
          content: {
            ...octets,
            "text/plain": { schema: ReleaseSignature },
          },
        },
      },
    },
    async (c) =>
      serveReleaseFile(c, c.req.param("version")!, c.req.param("file")!),
  );
}

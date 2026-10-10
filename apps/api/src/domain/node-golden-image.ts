// SPDX-License-Identifier: Apache-2.0
import { FleetReleaseSpec } from "@pgcf/contracts/releases";
import { NodeGoldenImage } from "@pgcf/contracts/node-bootstrap";
import type { Env } from "../env.ts";
import { ApiError } from "../app.ts";
import { installationHash } from "./node-installation.ts";
/** A selected release always owns the initial disk; fallback is only for a region with no selected release. */
export async function readSelectedNodeGoldenImage(
  env: Pick<Env, "DB">,
  regionId: string,
): Promise<NodeGoldenImage | null> {
  const row = await env.DB.prepare(
    "SELECT f.release_id,f.revision,r.spec_json,r.spec_sha256 FROM fleet_region_releases f JOIN fleet_releases r ON r.id=f.release_id WHERE f.region_id=?",
  )
    .bind(regionId)
    .first<{
      release_id: string;
      revision: number;
      spec_json: string;
      spec_sha256: string;
    }>();
  if (!row) return null;
  const spec = FleetReleaseSpec.parse(JSON.parse(row.spec_json));
  if (
    !spec.talos_raw_image ||
    (await installationHash(spec)) !== row.spec_sha256
  )
    throw new ApiError(
      "conflict",
      "Selected release requires its verified golden raw image before installation",
    );
  return NodeGoldenImage.parse({
    release_id: row.release_id,
    spec_sha256: row.spec_sha256,
    region_revision: row.revision,
    talos_version: spec.roles.customer.talos_version.replace(/^v/, ""),
    schematic_id: spec.roles.customer.talos_schematic_sha256,
    installer: spec.roles.customer.talos_installer,
    raw: spec.talos_raw_image,
  });
}

// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { Role, listEnvelope } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";

const keys: string[] = [];
afterEach(async () => {
  if (keys.length) await env.ARCHIVE.delete(keys.splice(0));
  await cleanupFixtures();
});
type Fixture = Awaited<ReturnType<typeof fixture>>;
const key = () => crypto.randomUUID();

/** A database with an archive that a restore can read, and two roles with attributes. */
async function source() {
  const f = await fixture();
  const created = (await (await f.create()).json()) as {
    database: { id: string };
  };
  const id = created.database.id;
  const archive = await env.DB.prepare(
    "SELECT archive_path FROM databases WHERE id=?",
  )
    .bind(id)
    .first<{ archive_path: string }>();
  const prefix =
    archive!.archive_path.replace(`s3://${env.ARCHIVE_BUCKET_NAME}/`, "") +
    "/database/";
  const start = Date.now() - 60 * 60 * 1000,
    begin = new Date(start).toISOString(),
    end = new Date(start + 120000).toISOString(),
    backupId = begin.replace(/[-:]/g, "").slice(0, 15);
  for (const [name, value] of [
    [
      `${prefix}base/${backupId}/backup.info`,
      `status=DONE\nbegin_time=${begin}\nend_time=${end}\nbegin_wal=00000001${"0".repeat(15)}1\nend_wal=00000001${"0".repeat(15)}1\nxlog_segment_size=16777216\n`,
    ],
    [`${prefix}base/${backupId}/data.tar.gz`, "payload"],
    [
      `${prefix}wals/00000001${"0".repeat(8)}/00000001${"0".repeat(15)}1.gz`,
      "wal",
    ],
  ] as const) {
    keys.push(name);
    await env.ARCHIVE.put(name, value);
  }
  const until = new Date(Date.now() + 86_400_000).toISOString();
  for (const body of [
    { name: "reader" },
    {
      name: "report_job",
      valid_until: until,
      connection_limit: 7,
      member_of: ["reader"],
      bypass_rls: true,
    },
  ])
    expect(
      (
        await request(
          `/v1/databases/${id}/roles`,
          f.integrator,
          "POST",
          body,
          key(),
        )
      ).status,
    ).toBe(201);
  return { ...f, id, until };
}
const restore = (f: Fixture & { id: string }, name: string) =>
  request(
    `/v1/databases/${f.id}/restore`,
    f.integrator,
    "POST",
    { name, mode: "full" },
    key(),
  );
async function targetRoles(f: Fixture, response: Response) {
  expect(response.status).toBe(202);
  const target = (
    (await response.json()) as { target_database: { id: string } }
  ).target_database.id;
  return {
    id: target,
    roles: listEnvelope(Role).parse(
      await (
        await request(`/v1/databases/${target}/roles`, f.integrator)
      ).json(),
    ).data,
  };
}
const attributes = (until: string) => ({
  name: "report_job",
  valid_until: until,
  connection_limit: 7,
  member_of: ["reader"],
  bypass_rls: true,
});

it("a restore copy carries the attributes of every live role", async () => {
  const f = await source();
  const { roles } = await targetRoles(f, await restore(f, "copy-live"));
  expect(roles.map((role) => role.name)).toEqual([
    "app",
    "reader",
    "report_job",
  ]);
  expect(roles.find((role) => role.name === "report_job")).toMatchObject(
    attributes(f.until),
  );
  expect(roles.find((role) => role.name === "reader")).toMatchObject({
    valid_until: null,
    connection_limit: null,
    member_of: [],
    bypass_rls: false,
  });
});

it("a role being deleted is not copied into a restore", async () => {
  const f = await source();
  await env.DB.prepare(
    "UPDATE roles SET deleted_at=?,delete_operation_id=NULL WHERE database_id=? AND name='report_job'",
  )
    .bind(new Date().toISOString(), f.id)
    .run();
  const { roles } = await targetRoles(f, await restore(f, "copy-without"));
  expect(roles.map((role) => role.name)).toEqual(["app", "reader"]);
});

it("the retained archive of a deleted database keeps the attributes for a later restore", async () => {
  const f = await source();
  expect(
    (
      await request(
        `/v1/databases/${f.id}`,
        f.integrator,
        "DELETE",
        undefined,
        key(),
      )
    ).status,
  ).toBe(202);
  const retained = await env.DB.prepare(
    "SELECT roles_json FROM retained_archives WHERE source_database_id=?",
  )
    .bind(f.id)
    .first<{ roles_json: string }>();
  const stored = JSON.parse(retained!.roles_json) as Record<string, unknown>[];
  expect(stored.find((role) => role.name === "report_job")).toMatchObject({
    valid_until: f.until,
    connection_limit: 7,
    member_of: ["reader"],
    bypass_rls: 1,
  });
  const { roles } = await targetRoles(f, await restore(f, "copy-retained"));
  expect(roles.find((role) => role.name === "report_job")).toMatchObject(
    attributes(f.until),
  );
});

it("an archive retained before roles had attributes restores plain roles", async () => {
  const f = await source();
  expect(
    (
      await request(
        `/v1/databases/${f.id}`,
        f.integrator,
        "DELETE",
        undefined,
        key(),
      )
    ).status,
  ).toBe(202);
  // The shape written by the release that introduced retained archives: no attribute keys.
  await env.DB.prepare(
    `UPDATE retained_archives SET roles_json=(SELECT json_group_array(json_remove(value,'$.valid_until','$.connection_limit','$.member_of','$.bypass_rls')) FROM json_each(roles_json)) WHERE source_database_id=?`,
  )
    .bind(f.id)
    .run();
  const { roles } = await targetRoles(f, await restore(f, "copy-legacy"));
  expect(roles.find((role) => role.name === "report_job")).toMatchObject({
    valid_until: null,
    connection_limit: null,
    member_of: [],
    bypass_rls: false,
  });
});

// SPDX-License-Identifier: Apache-2.0
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";

const directory = new URL("../../../apps/api/migrations/", import.meta.url);
const migrations = readdirSync(directory)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const MIGRATION = "0084_single_archive_bucket.sql";
const NOW = "2026-10-19T10:00:00.000Z";
let db: DatabaseSync;

/** D1 applies a migration as one transaction. */
const apply = (name: string) => {
  db.exec("BEGIN");
  try {
    db.exec(readFileSync(new URL(name, directory), "utf8"));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
};
const columns = () =>
  (db.prepare("PRAGMA table_info(regions)").all() as { name: string }[]).map(
    (column) => column.name,
  );

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of migrations.filter((value) => value < MIGRATION))
    apply(name);
});
afterEach(() => db.close());

it("takes the archive bucket and its endpoint off the regions and keeps every region with its children", () => {
  // Three regions as the live installation has them: the bucket of the EU jurisdiction with its .eu.
  // endpoint, and us-dev with the account's general endpoint for the same bucket, which no API could correct.
  const eu = `https://${"a".repeat(32)}.eu.r2.example.com`;
  const general = `https://${"a".repeat(32)}.r2.example.com`;
  for (const [id, endpoint] of [
    ["eu-test", eu],
    ["us-test", general],
  ] as const) {
    db.prepare(
      `INSERT INTO regions(id,provider,provider_region,gateway_url,gateway_binding,backup_bucket,backup_endpoint_url,created_at,updated_at)
       VALUES(?,'contabo','EU',?,NULL,'pgcf-test-eu',?,?,?)`,
    ).run(id, `https://${id}.example.com/pg`, endpoint, NOW, NOW);
    db.prepare(
      "INSERT INTO node_region_policies(region_id,max_nodes) VALUES(?,3)",
    ).run(id);
  }
  expect(columns()).toContain("backup_bucket");
  expect(columns()).toContain("backup_endpoint_url");
  apply(MIGRATION);
  expect(columns()).not.toContain("backup_bucket");
  expect(columns()).not.toContain("backup_endpoint_url");
  expect(
    db
      .prepare(
        "SELECT id,provider,provider_region,gateway_url,created_at,updated_at FROM regions ORDER BY id",
      )
      .all(),
  ).toEqual(
    ["eu-test", "us-test"].map((id) => ({
      id,
      provider: "contabo",
      provider_region: "EU",
      gateway_url: `https://${id}.example.com/pg`,
      created_at: NOW,
      updated_at: NOW,
    })),
  );
  expect(
    db.prepare("SELECT count(*) n FROM node_region_policies").get(),
  ).toEqual({ n: 2 });
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  // A region is made without either column.
  db.prepare(
    `INSERT INTO regions(id,provider,provider_region,gateway_url,created_at,updated_at)
     VALUES('us-new','contabo','US',?,?,?)`,
  ).run("https://us-new.example.com/pg", NOW, NOW);
});

const RUNBOOK = readFileSync(
  new URL("../../../docs/operations/operator-installation.md", import.meta.url),
  "utf8",
);
const MOVE = RUNBOOK.slice(
  RUNBOOK.indexOf("### Moving to another archive bucket"),
  RUNBOOK.indexOf("### Keeping the DatabaseActors warm"),
);
/** The runbook's installation inputs: where the region endpoint check lives. */
const INPUTS = RUNBOOK.slice(
  RUNBOOK.indexOf("## Reviewed deployment inputs"),
  RUNBOOK.indexOf("### The node firewall"),
);
/** The one fenced SQL block of a runbook section that holds `needle`, with its placeholders filled. */
function runbookSql(
  needle: string,
  values: Record<string, string>,
  section = MOVE,
) {
  const blocks = [...section.matchAll(/^ *```sql\n([\s\S]*?)^ *```/gm)]
    .map((match) => match[1]!)
    .filter((block) => block.includes(needle));
  expect(blocks).toHaveLength(1);
  let sql = blocks[0]!.trim().replace(/;$/, "");
  for (const [placeholder, value] of Object.entries(values))
    sql = sql.replaceAll(placeholder, value);
  return sql;
}

it("runs the SQL of the bucket-move runbook on the migrated schema and selects what the steps say", () => {
  db.close();
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of migrations) apply(name);
  const OLD = "pgcf-old";
  const id = (letter: string) => `${letter}${"1".repeat(19)}`;
  const operation = (letter: string) => `op_${letter.repeat(20)}`;
  const project = `prj_${"a".repeat(20)}`;
  const node = `nod_${"a".repeat(20)}`;
  const run = (sql: string, ...params: (string | number | null)[]) =>
    db.prepare(sql).run(...params);
  run(
    "INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,?,?,?)",
    project,
    "p",
    NOW,
    NOW,
  );
  run(
    `INSERT INTO regions(id,provider,provider_region,gateway_url,created_at,updated_at)
     VALUES('eu-test','contabo','EU',?,?,?)`,
    `https://${["gateway", "example", "com"].join(".")}`,
    NOW,
    NOW,
  );
  run(
    `INSERT INTO nodes(id,region_id,hostname,allocatable_memory_mib,allocatable_cpu_millicores,created_at,updated_at)
     VALUES(?,'eu-test','eu1',0,0,?,?)`,
    node,
    NOW,
    NOW,
  );
  run(
    `INSERT INTO size_classes(id,memory_mib,cpu_millicores,storage_gib,max_connections,archive_timeout_seconds,backup_retention_days,created_at,updated_at)
     VALUES('small',512,500,10,100,60,7,?,?)`,
    NOW,
    NOW,
  );
  const database = (
    letter: string,
    bucket: string,
    desired: string,
    extra: Record<string, string | number | null> = {},
  ) => {
    const columns = {
      id: id(letter),
      project_id: project,
      region_id: "eu-test",
      node_id: node,
      name: `db-${letter}`,
      size_class_id: "small",
      desired_state: desired,
      archive_path: `s3://${bucket}/eu-test/${id(letter)}/g1-${operation(letter)}`,
      created_at: NOW,
      updated_at: NOW,
      ...extra,
    };
    run(
      `INSERT INTO databases(${Object.keys(columns).join(",")}) VALUES(${Object.keys(
        columns,
      )
        .map(() => "?")
        .join(",")})`,
      ...Object.values(columns),
    );
  };
  const credential = (
    letter: string,
    access: string,
    issued: string,
    expires: string,
  ) =>
    run(
      `INSERT INTO archive_credentials(id,node_id,database_id,archive_path,access,issued_at,expires_at)
       SELECT ?,?,id,archive_path,?,?,? FROM databases WHERE id=?`,
      `crd_${letter.repeat(20)}`,
      node,
      access,
      issued,
      expires,
      id(letter),
    );
  // a, b, c, f run; d is suspended by hand; e is deleted and confirmed; g names another bucket.
  database("a", OLD, "running");
  database("b", OLD, "running");
  database("c", OLD, "running");
  database("d", OLD, "suspended", { suspension_reason: "manual" });
  database("e", OLD, "running");
  database("f", OLD, "running");
  database("g", "pgcf-elsewhere", "suspended", { suspension_reason: "manual" });
  run(
    "UPDATE databases SET desired_state='deleted',observed_state='deleted',observed_generation=generation,deleted_at=? WHERE id=?",
    NOW,
    id("e"),
  );
  const T = "2026-10-22T10:00:00.000Z";
  const before = "2026-10-22T09:00:00.000Z";
  const after = "2026-10-22T11:00:00.000Z";
  const later = "2026-10-29T11:00:00.000Z";
  credential("a", "read_write", after, later);
  credential("b", "read_write", before, "2026-10-29T09:00:00.000Z");
  credential("f", "read_only", after, later);

  // Step 3: the archives of the databases that are not deleted and name the old bucket, and no other.
  expect(
    db
      .prepare(runbookSql("SELECT substr(archive_path", { "<old>": OLD }))
      .all()
      .map((row) => Object.values(row)[0])
      .sort(),
  ).toEqual(
    ["a", "b", "c", "d", "f"].map(
      (letter) => `eu-test/${id(letter)}/g1-${operation(letter)}`,
    ),
  );

  // Step 1: the live databases that name another bucket than the one the Worker will use. g is the only
  // one: step 3's list above leaves it out, so the check is what tells the operator before the deploy.
  // The deleted database e names the old bucket and a deleted row is never counted.
  expect(
    db
      .prepare(
        runbookSql("SELECT count(*) FROM databases WHERE deleted_at IS NULL", {
          "<old>": OLD,
        }),
      )
      .all()
      .map((row) => Object.values(row)[0]),
  ).toEqual([1]);

  // Step 7: the databases that cannot have switched yet are awake or possibly awake and hold no
  // read-write credential issued after the time: b (an older one), c (none) and f (read-only);
  // a (newer), d (suspended by hand) and e (deleted) are not counted.
  expect(
    db.prepare(runbookSql("SELECT d.node_id,count(*) n", { "<T>": T })).all(),
  ).toEqual([{ node_id: node, n: 3 }]);

  // Step 11: the last credential issued before T_KEY, then the forced refresh that removes those rows
  // and keeps the newer ones.
  expect(
    db
      .prepare(runbookSql("SELECT max(expires_at)", { "<T_KEY>": T }))
      .all()
      .map((row) => Object.values(row)[0]),
  ).toEqual(["2026-10-29T09:00:00.000Z"]);
  db.exec(runbookSql("DELETE FROM archive_credentials", { "<T_KEY>": T }));
  expect(
    db
      .prepare("SELECT id FROM archive_credentials ORDER BY id")
      .all()
      .map((row) => row.id),
  ).toEqual([`crd_${"a".repeat(20)}`, `crd_${"f".repeat(20)}`]);
});

it("takes the archive endpoint from the Worker's variable, with no SQL that edits a region's", () => {
  // A region row holds no endpoint, so the runbook has no check or correction of one in D1: it names the
  // variable, the example configuration that sets it and the refusal of the old body.
  expect(INPUTS).toMatch(/`ARCHIVE_ENDPOINT_URL`/);
  expect(INPUTS).toMatch(/apps\/api\/wrangler\.example\.jsonc/);
  expect(INPUTS).toMatch(/whatever the node's region/);
  expect(INPUTS).toMatch(
    /answer 400 for\s+a body that names `backup_bucket` or `backup_endpoint_url`/,
  );
  const sql = [...RUNBOOK.matchAll(/^ *```sql\n([\s\S]*?)^ *```/gm)].map(
    (match) => match[1]!,
  );
  expect(sql.length).toBeGreaterThan(0);
  for (const block of sql)
    expect(block).not.toMatch(/backup_endpoint_url|backup_bucket/);
  // The variable is in place with the Worker of step 1, before 0084 drops the columns the old Worker reads.
  const step = FORWARD.get(1)!;
  expect(step).toMatch(
    /Then deploy the Worker with `ARCHIVE_ENDPOINT_URL` set/,
  );
  const at = (text: RegExp) => step.search(text);
  expect(at(/ARCHIVE_ENDPOINT_URL/)).toBeGreaterThan(-1);
  expect(at(/ARCHIVE_ENDPOINT_URL/)).toBeLessThan(at(/only then apply `0084`/));
  // The example configuration sets it, and the move leaves it alone (same account and jurisdiction).
  expect(
    readFileSync(
      new URL("../../../apps/api/wrangler.example.jsonc", import.meta.url),
      "utf8",
    ),
  ).toMatch(
    /"ARCHIVE_ENDPOINT_URL": "https:\/\/<CLOUDFLARE_ACCOUNT_ID>\.eu\.r2\.cloudflarestorage\.com"/,
  );
  expect(FORWARD.get(2)!).toMatch(/`ARCHIVE_ENDPOINT_URL` stays as it is/);
  expect(FORWARD.get(4)!).not.toMatch(/endpoint/);
});

it("makes the prefix list again for the last warm round, so a database created after it is inside the window of the passes by time", () => {
  const steps = MOVE.slice(MOVE.indexOf("\n3. Copy"), MOVE.indexOf("\n4. "));
  const text = steps.replace(/\s+/g, " ");
  // The last round makes its own list at its start and starts copying within an hour of it.
  expect(text).toMatch(/last round.{0,100}makes its own list at its start/);
  expect(text).toMatch(/within an hour of making the list/);
  // The claim that the passes by time catch a later database is tied to that list, not to any list.
  expect(text).not.toMatch(
    /they catch a database created after the list was made/,
  );
});

/** The numbered steps of a runbook section: the ones that start a line, keyed by their number. */
function numberedSteps(section: string) {
  const steps = new Map<number, string>();
  for (const chunk of section.split(/\n(?=\d+\. )/)) {
    const match = /^\s*(\d+)\. /.exec(chunk);
    if (match) steps.set(Number(match[1]), chunk.replace(/\s+/g, " ").trim());
  }
  return steps;
}
const FORWARD = numberedSteps(
  MOVE.slice(MOVE.search(/\n1\. /), MOVE.indexOf("If a step fails.")),
);
const ROLLBACK = numberedSteps(MOVE.slice(MOVE.indexOf("If a step fails.")));

it("names the flag that lets a copy go on where the destination holds keys the source lacks", () => {
  // The copy refuses (exit 2, "Nothing was copied") when the destination holds a key the source lacks. That
  // is true of step 8 (the maintenance cycle archived the final WAL into the new bucket only, and a
  // database created after the deploy exists only there), of every chained pass of step 10 and of its gap
  // repair, of every warm round after the first, and of the rollback's mirror into the old bucket.
  const flag = "--allow-extra-destination-keys";
  const copyNaming = new RegExp(`\`copy [^\`]*${flag}[^\`]*\``);
  for (const [name, step] of [
    ["step 3", FORWARD.get(3)],
    ["step 8", FORWARD.get(8)],
    ["step 10", FORWARD.get(10)],
    ["the rollback's step 4", ROLLBACK.get(4)],
  ] as const) {
    expect(step, name).toMatch(copyNaming);
  }
  // No inline copy command of a pass by time or of the mirror leaves it out.
  const spans = [...MOVE.replace(/\s+/g, " ").matchAll(/`copy [^`]*`/g)].map(
    (match) => match[0],
  );
  expect(spans.length).toBeGreaterThanOrEqual(4);
  for (const span of spans)
    if (/--since|--add-only/.test(span)) expect(span).toContain(flag);
  // The copies of the first round alone go without it, so that each refuses a bucket that already holds keys.
  expect(FORWARD.get(3)).toMatch(/copies of the first round take no flag/);
  // Step 10's chain and its gap repair both name it, and so does the second attempt's warm copy.
  expect(
    FORWARD.get(10)!.match(new RegExp(flag, "g"))?.length,
  ).toBeGreaterThanOrEqual(2);
  expect(FORWARD.get(3)).toMatch(/second attempt/);
});

it("applies 0082 with its Worker before this move's Worker, so that 0084 is the only pending migration", () => {
  // `wrangler d1 migrations apply` takes every pending file. 0082 needs its own Worker straight after it
  // (and a fresh D1 export before it); 0084 needs its Worker before it. One command cannot do both.
  const step = FORWARD.get(1)!;
  expect(step).toMatch(/`0082`/);
  expect(step).toMatch(/wrangler d1 migrations list/);
  expect(step).toMatch(/only `0084`/);
  expect(step).toMatch(/every pending (migration|file)/);
  expect(step).toMatch(/fresh (daily )?D1 export/);
  // 0083 is additive and goes before the Worker that reads its column.
  expect(step).toMatch(/`0083`[^.]*additive[^.]*before\s+the\s+Worker/);
  // The check comes before the Worker is deployed, and 0084 after it.
  const at = (text: RegExp) => step.search(text);
  expect(at(/migrations list/)).toBeGreaterThan(-1);
  expect(at(/migrations list/)).toBeLessThan(at(/Then deploy the Worker/));
  expect(at(/Then deploy the Worker/)).toBeGreaterThan(-1);
  expect(at(/Then deploy the Worker/)).toBeLessThan(
    at(/only then apply `0084`/),
  );
});

it("keeps the previous parent token alive until step 11 and retires every earlier parent token there", () => {
  // Until step 6 every node archives into old-bucket paths with credentials signed by the previous token (a
  // credential's access key is the parent's), so deleting it at step 2 ends them all.
  const two = FORWARD.get(2)!;
  expect(two).toMatch(/keep the previous token/i);
  expect(two).toMatch(/database_archive_failing/);
  expect(two).not.toMatch(/Replace the parent key/);
  expect(two).toMatch(/step 11/);
  // Step 11 names both earlier parent tokens, not "the parent key that names the old bucket".
  const eleven = FORWARD.get(11)!;
  expect(eleven).not.toMatch(/the parent key that names the old bucket/);
  expect(eleven).toMatch(/previous (parent )?token/);
  expect(eleven).toMatch(/step 2/);
  expect(FORWARD.get(10)!).not.toMatch(/revoking the old parent key/);
  expect(MOVE.replace(/\s+/g, " ")).not.toMatch(
    /until step 11 revokes the old parent key,/,
  );
});

/** The bullets of the runbook's list of what can be rolled back, keyed by their bold label. */
const WINDOWS = (() => {
  const start = MOVE.indexOf("What can be rolled back, step by step.");
  const end = MOVE.indexOf("If a step fails.");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const windows = new Map<string, string>();
  for (const chunk of MOVE.slice(start, end)
    .split(/\n(?=- \*\*)/)
    .slice(1)) {
    const label = /^- \*\*([^*]+)\*\*/.exec(chunk)![1]!;
    windows.set(label, chunk.replace(/\s+/g, " ").trim());
  }
  return windows;
})();

it("says what can and what cannot be rolled back at each step of the cutover", () => {
  expect([...WINDOWS.keys()]).toEqual([
    "Step 1.",
    "Steps 2 to 4.",
    "Steps 5 to 10.",
    "Steps 11.1 to 11.3.",
    "Step 11.4 and after (the revocation).",
    "Step 12.",
  ]);
  // The migration has no way back, and the Worker only until it is applied.
  expect(WINDOWS.get("Step 1.")).toMatch(/until `0084` is applied/);
  expect(WINDOWS.get("Step 1.")).toMatch(/`0084` cannot be rolled back/);
  expect(WINDOWS.get("Step 1.")).toMatch(/Time Travel/);
  // Before anything reads the new bucket, giving up needs no rollback; the old bucket stays in every parent token.
  expect(WINDOWS.get("Steps 2 to 4.")).toMatch(
    /old bucket stays in the policy/,
  );
  // From the deploy of step 5 the whole procedure applies; the old configuration alone undoes nothing.
  expect(WINDOWS.get("Steps 5 to 10.")).toMatch(/whole rollback applies/);
  expect(WINDOWS.get("Steps 5 to 10.")).toMatch(/undoes nothing/);
  // 11.1 sets a parent key without the old bucket: the rollback must put the old one back until 11.4.
  const keyed = WINDOWS.get("Steps 11.1 to 11.3.")!;
  expect(keyed).toMatch(
    /whole rollback still applies, with one addition to its step 1/,
  );
  expect(keyed).toMatch(
    /parent key goes back to the token that names the old bucket/,
  );
  expect(keyed).toMatch(
    /`R2_PARENT_ACCESS_KEY_ID` and `R2_PARENT_SECRET_ACCESS_KEY`/,
  );
  expect(keyed).toMatch(/until 11\.4/);
  // The revocation ends it, and so does deleting the old bucket.
  expect(WINDOWS.get("Step 11.4 and after (the revocation).")).toMatch(
    /There is no rollback/,
  );
  expect(WINDOWS.get("Step 11.4 and after (the revocation).")).toMatch(
    /fixed forward/,
  );
  expect(WINDOWS.get("Step 12.")).toMatch(/cannot be undone/);
});

const PLAN = readFileSync(
  new URL(
    "../../../docs/architecture/cloudflare-convergence-and-serverless-plan.md",
    import.meta.url,
  ),
  "utf8",
);

it("says that a second parent token set at step 2 is in production from then on, and how a given-up move retires it", () => {
  // Option (b) of step 2 sets R2_PARENT_* to a second token, which is the access key of every credential
  // delivered from then on (crypto/r2-credentials.ts). "Nothing uses the new token" is false for it:
  // an operator who gives the move up before step 5 and deletes that token with the empty bucket ends every
  // credential issued since step 2, archiving fails and no database can sleep until the rows renew.
  const window = WINDOWS.get("Steps 2 to 4.")!;
  expect(window).not.toMatch(/Nothing in production uses the new/i);
  expect(window).toMatch(
    /depends on how step 2 gave the Worker its parent key/,
  );
  // (b): the token is in production, as the parent key and as the access key of the credentials.
  expect(window).toMatch(/in production from step 2 on/);
  expect(window).toMatch(/access key of every credential the Worker delivers/);
  expect(window).toMatch(/database_archive_failing/);
  // Giving up keeps it as the parent key, or puts the previous token back in one `secret bulk`, and retires the
  // token the Worker stops signing with as 11.2 does: one credential lifetime, or the forced refresh with the barrier.
  expect(window).toMatch(/keep the second token as the parent key/i);
  expect(window).toMatch(
    /puts? the previous token back[^.]*one `secret bulk`/i,
  );
  expect(window).toMatch(/one credential lifetime/);
  expect(window).toMatch(/forced refresh[^.]*barrier/);
  expect(window).toMatch(/Only then delete that token/);
  // (a): the new bucket leaves the policy only once nothing uses it, and the old bucket never does.
  expect(window).toMatch(/only once the bucket is unused/);
  expect(window).toMatch(/old bucket stays in the policy/);
  // Step 1's way back puts the bindings that step 1 removed back.
  expect(WINDOWS.get("Step 1.")).toMatch(/`ARCHIVE_US`/);
  expect(WINDOWS.get("Step 1.")).toMatch(/`ARCHIVE_BINDINGS`/);
  // Neither the runbook nor the plan repeats the false sentence.
  for (const [name, text] of [
    ["the runbook", RUNBOOK],
    ["the plan", PLAN],
  ] as const) {
    const flat = text.replace(/\s+/g, " ");
    expect(flat, name).not.toMatch(
      /nothing (in production )?uses the new bucket or (the )?(new )?token/i,
    );
    expect(flat, name).not.toMatch(/nothing uses the new bucket yet/i);
  }
  expect(PLAN.replace(/\s+/g, " ")).toMatch(/in production from step 2 on/);
});

it("gives every pass of the cutover its own output files in the one directory made for it, because the tool refuses a file that exists", () => {
  // The tool writes a list only as a new 0600 file (it never overwrites), so a fixed name for a repeated pass
  // died with FileExistsError after the copy had been done, and the file still held the first pass's keys.
  const text = MOVE.replace(/\s+/g, " ");
  expect(text).toMatch(/one directory for the whole cutover/);
  expect(text).toMatch(
    /refuses a file that exists, before it lists or copies anything/,
  );
  expect(text).toMatch(/delete it at the end/);
  // Every output file of a command names the pass, so no two passes share one.
  const flags = [...text.matchAll(/--(copied|missing|extras)-file (\S+)/g)].map(
    (match) => match[2]!,
  );
  expect(flags.length).toBeGreaterThanOrEqual(6);
  for (const argument of flags)
    expect(argument).toMatch(/^"\$D\/[a-z-]+<pass>\.txt"[`.,;:)]*$/);
  // The steps that repeat a pass name them: step 8, step 10, the rollback's step 4 (verify, mirror) and its step 7.
  expect(FORWARD.get(8)).toMatch(/--copied-file "\$D\/copied-<pass>\.txt"/);
  expect(FORWARD.get(10)).toMatch(/--copied-file "\$D\/copied-<pass>\.txt"/);
  expect(FORWARD.get(10)).toMatch(/--missing-file "\$D\/missing-<pass>\.txt"/);
  expect(ROLLBACK.get(4)).toMatch(/--missing-file "\$D\/missing-<pass>\.txt"/);
  expect(ROLLBACK.get(4)).toMatch(/--extras-file "\$D\/extras-<pass>\.txt"/);
  expect(ROLLBACK.get(4)).toMatch(/--copied-file "\$D\/copied-<pass>\.txt"/);
  // A pass that wrote no file found no key: an absent file is no unread one.
  expect(text).toMatch(/a pass that finds no key writes no file/i);
});

it("puts the parent key back in the rollback's first step whenever step 11.1 has run, and keeps the new key until the new credentials expire", () => {
  const one = ROLLBACK.get(1)!;
  expect(one).toMatch(
    /When step 11\.1 has run, set `R2_PARENT_ACCESS_KEY_ID` and `R2_PARENT_SECRET_ACCESS_KEY`/,
  );
  expect(one).toMatch(/in the same deploy/);
  // The token that named the old bucket before 11.1: step 2's, or the previous one, both alive until 11.4.
  expect(one).toMatch(/the token of step 2, or the previous token/);
  expect(one).toMatch(/alive until 11\.4/);
  // What a rollback that leaves the 11.1 token in place does.
  expect(one).toMatch(/R2 refuses every upload/);
  expect(one).toMatch(/database_archive_failing/);
  expect(one).toMatch(/Keep the 11\.1 token until X_NEW/);
  // X_NEW is read in the same step, before step 2 deletes the rows that record it.
  expect(one).toMatch(/X_NEW/);
  // And the forward step says so where the key is set.
  expect(numberedSteps(MOVE).get(11)!).toMatch(
    /a rollback also puts the parent key\s+back/,
  );
});

it("retires the old keys in the order new parent key, credential refresh, WAL archive, base backup and restore read, then revoke", () => {
  const eleven = FORWARD.get(11)!;
  const order = [
    "Create the new parent token",
    "Replace the credentials the nodes hold",
    "With the old keys still alive, check on the new key",
    "a WAL archive",
    "a base backup",
    "a restore read",
    "Only when all three pass, revoke the old keys",
    "After the revocation, repeat the WAL archive check",
  ].map((text) => eleven.indexOf(text));
  for (const at of order) expect(at).toBeGreaterThan(-1);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(eleven).toMatch(/From here there is no rollback to the old bucket/);
});

it("keeps the token of the copy through the last pass after the revocation, and deletes it only then", () => {
  // 11.5 runs step 10's last pass after the revocation, and that pass reads the old bucket and writes the new one
  // with the copy token: revoking it in 11.4 would leave the last copy without a key.
  const eleven = FORWARD.get(11)!;
  const revoke = eleven.slice(
    eleven.indexOf("Only when all three pass"),
    eleven.indexOf("Keep the token of the copy"),
  );
  expect(revoke.length).toBeGreaterThan(0);
  expect(revoke).not.toMatch(/token of the copy/);
  expect(eleven).toMatch(/Keep the token of the copy for 11\.5/);
  const lastPass = eleven.indexOf(
    "After the revocation, repeat the WAL archive check",
  );
  expect(lastPass).toBeGreaterThan(-1);
  expect(eleven.indexOf("Then delete the token of the copy")).toBeGreaterThan(
    lastPass,
  );
});

// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { command, HarnessError, record } from "./core.ts";
import { type Eu1Fixture, withEu1Fixture } from "./extension-acceptance.ts";

const original = `CREATE TABLE public.profiles(id uuid, organization_id text, note text);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_row ON public.profiles FOR ALL TO authenticated USING (id = (SELECT auth.uid()));
CREATE POLICY organization ON public.profiles AS RESTRICTIVE TO authenticated
  USING (organization_id = auth.jwt()->'app_metadata'->>'organization_id');
CREATE POLICY public_read ON public.profiles FOR SELECT TO anon USING (note = 'public');`;

const alice = "11111111-1111-4111-8111-111111111111";
const bob = "22222222-2222-4222-8222-222222222222";
const seed = `INSERT INTO public.profiles VALUES
  ('${alice}','org_a','owned'), ('${bob}','org_b','other'), ('${bob}','org_a','public')`;

async function convert(script: string): Promise<string[]> {
  if (!isAbsolute(script))
    throw new HarnessError("absolute_rls_converter_path_required");
  const dir = await mkdtemp(join(tmpdir(), "pgcf-rls-"));
  try {
    const input = join(dir, "source.sql");
    const review = join(dir, "review.json");
    const output = join(dir, "baseline.sql");
    await writeFile(input, original, { mode: 0o600, flag: "wx" });
    await writeFile(
      review,
      JSON.stringify({
        backendRlsTables: ["public.profiles"],
        userIdMapping: "uuid",
        claimMappings: [
          {
            sourcePath: ["app_metadata", "organization_id"],
            targetPath: ["organization_id"],
            trust: "server-verified",
          },
        ],
      }),
      { mode: 0o600, flag: "wx" },
    );
    const args = [
      script,
      "--input",
      input,
      "--authorization-mode",
      "preserve-rls",
      "--rls-options",
      review,
    ];
    const options = { cwd: dir, env: {} };
    const report = record(
      JSON.parse(
        await command(process.execPath, [...args, "--report-only"], options),
      ),
    );
    if (
      report.canGenerate !== true ||
      report.completeInventory !== true ||
      report.sourcePolicies !== 3 ||
      report.blocked !== 0
    )
      throw new HarnessError("rls_report_mismatch");
    const summary = record(
      JSON.parse(
        await command(process.execPath, [...args, "--output", output], options),
      ),
    );
    if (summary.emittedPolicyCount !== 3 || summary.omittedPolicyCount !== 0)
      throw new HarnessError("rls_generation_mismatch");
    // The fixture's source has no semicolons inside literals or function bodies. The
    // identity helpers below are separate statements, outside the generated baseline.
    return (await readFile(output, "utf8"))
      .replace(/^--[^\n]*\n/u, "")
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function notes(result: unknown): string {
  const rows = record(result).results;
  if (!Array.isArray(rows) || rows.length !== 2)
    throw new HarnessError("invalid_rls_result");
  const values = record(rows[1]).rows;
  if (
    !Array.isArray(values) ||
    values.some(
      (row) =>
        !Array.isArray(row) || row.length !== 1 || typeof row[0] !== "string",
    )
  )
    throw new HarnessError("invalid_rls_result");
  return values.map((row) => row[0]).join(",");
}

async function verify(fixture: Eu1Fixture, isSource: boolean): Promise<void> {
  const reader = isSource ? "authenticated" : "import_runtime";
  const anon = isSource ? "anon" : reader;
  const select = "SELECT note FROM public.profiles ORDER BY note";
  async function query(
    role: string,
    sub: string | null,
    organization: string,
    text: string,
    expected: string,
  ) {
    const claims = JSON.stringify({
      sub,
      role: sub === null ? "anon" : "authenticated",
      organization_id: organization,
      app_metadata: { organization_id: organization },
    });
    const statements = [
      `SELECT set_config('ohmyhost.request_claims', '${claims}', true)`,
      text,
    ];
    const result = await fixture.roleBatch(
      role,
      statements,
      expected === "42501" ? expected : undefined,
    );
    if (expected !== "42501" && notes(result) !== expected)
      throw new HarnessError("rls_access_decision_mismatch");
  }
  await query(anon, null, "org_a", select, "public");
  await query(reader, alice, "org_a", select, "owned");
  await query(reader, bob, "org_b", select, "other");
  await query(reader, alice, "org_b", select, "");
  await query(
    reader,
    alice,
    "org_a",
    "UPDATE public.profiles SET note='changed' WHERE note='owned' RETURNING note",
    "changed",
  );
  await query(
    reader,
    alice,
    "org_a",
    "UPDATE public.profiles SET note='wrong' WHERE note='other' RETURNING note",
    "",
  );
  await query(
    reader,
    alice,
    "org_a",
    "UPDATE public.profiles SET organization_id='org_b' WHERE note='changed' RETURNING note",
    "42501",
  );
  await query(reader, bob, "org_b", select, "other");
}

export async function comparePolicyImport(
  script: string,
  withFixture: typeof withEu1Fixture,
): Promise<void> {
  const baseline = await convert(script);
  const startPolicies = baseline.findIndex((statement) =>
    /^alter table .*enable row level security$/iu.test(statement),
  );
  if (startPolicies < 0) throw new HarnessError("missing_rls_enforcement");
  const claims = `COALESCE(NULLIF(current_setting('ohmyhost.request_claims', true), '')::jsonb, '{}'::jsonb)`;
  await withFixture("rls-source", async (fixture) => {
    await fixture.createRole("authenticated");
    await fixture.createRole("anon");
    await fixture.batch([
      "CREATE SCHEMA auth",
      `CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT (${claims}->>'sub')::uuid $$`,
      `CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT ${claims} $$`,
      "GRANT USAGE ON SCHEMA auth TO authenticated, anon",
      ...original
        .split(";")
        .map((statement) => statement.trim())
        .filter(Boolean),
      seed,
      "GRANT SELECT, UPDATE ON public.profiles TO authenticated, anon",
    ]);
    await verify(fixture, true);
  });
  await withFixture("rls-target", async (fixture) => {
    await fixture.createRole("import_runtime");
    await fixture.batch([
      "CREATE SCHEMA ohmyhost",
      `CREATE FUNCTION ohmyhost.user_id() RETURNS text LANGUAGE sql STABLE AS $$ SELECT ${claims}->>'sub' $$`,
      `CREATE FUNCTION ohmyhost.claims() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT ${claims} $$`,
      "GRANT USAGE ON SCHEMA ohmyhost TO import_runtime",
      ...baseline.slice(0, startPolicies),
      seed,
      ...baseline.slice(startPolicies),
      "GRANT SELECT, UPDATE ON public.profiles TO import_runtime",
    ]);
    await verify(fixture, false);
  });
  console.log(
    JSON.stringify({
      suite: "eu1_rls_import",
      policies: 3,
      equivalentDecisions: 8,
    }),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv[2] !== "run") process.exitCode = 2;
  else {
    try {
      await comparePolicyImport(
        process.env.PGCF_RLS_BASELINE_SCRIPT ?? "",
        withEu1Fixture,
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          suite: "eu1_rls_import",
          failure:
            error instanceof HarnessError ? error.code : "unexpected_failure",
        }),
      );
      process.exitCode = 1;
    }
  }
}

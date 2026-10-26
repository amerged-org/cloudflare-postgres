// SPDX-License-Identifier: Apache-2.0
// A cold Durable Object evaluates every export of the Worker before it answers (measured 2026-10-18:
// the whole API graph took about 150 ms of every cold DatabaseActor). This pins what is evaluated.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const root = fileURLToPath(new URL("../../", import.meta.url));
const contracts = resolve(root, "packages/contracts");
const exportsMap = JSON.parse(
  readFileSync(resolve(contracts, "package.json"), "utf8"),
).exports as Record<string, string>;

/** The files and packages a module evaluates before its own code runs: static value imports and re-exports. */
function staticImports(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.ES2023,
  );
  const specifiers: string[] = [];
  for (const statement of source.statements) {
    if (
      (ts.isImportDeclaration(statement) ||
        ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      !(ts.isImportDeclaration(statement)
        ? statement.importClause?.isTypeOnly
        : statement.isTypeOnly)
    )
      specifiers.push(statement.moduleSpecifier.text);
  }
  return specifiers;
}

function resolveSpecifier(from: string, specifier: string): string | null {
  if (specifier.startsWith(".")) return resolve(dirname(from), specifier);
  if (specifier === "@pgcf/contracts")
    return resolve(contracts, exportsMap["."]!);
  if (specifier.startsWith("@pgcf/contracts/")) {
    const target =
      exportsMap["./" + specifier.slice("@pgcf/contracts/".length)];
    assert.ok(target, `${specifier} is not an export of @pgcf/contracts`);
    return resolve(contracts, target);
  }
  return null;
}

/** Every first-party file and every package reachable from `entry` through static imports. */
function closure(entry: string) {
  const files = new Set<string>();
  const packages = new Set<string>();
  const pending = [resolve(root, entry)];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of staticImports(file)) {
      const target = resolveSpecifier(file, specifier);
      if (target === null) packages.add(specifier);
      else pending.push(target);
    }
  }
  return {
    files: [...files].map((file) => relative(root, file)).sort(),
    packages: [...packages].sort(),
  };
}

// The three zod-free modules are the cores that ids.ts, route-token.ts and database-admission.ts
// re-export (the Edge loads the cores and no zod); they define constants and functions only.
test("a cold DatabaseActor evaluates only its admission modules and dependency-free maintenance gate", () => {
  assert.deepEqual(closure("apps/api/src/control-maintenance.ts"), {
    files: ["apps/api/src/control-maintenance.ts"],
    packages: [],
  });
  const graph = closure("apps/api/src/database-actor.ts");
  assert.deepEqual(graph.packages, ["cloudflare:workers", "zod"]);
  assert.deepEqual(graph.files, [
    "apps/api/src/control-maintenance.ts",
    "apps/api/src/database-actor.ts",
    "apps/api/src/domain/admission-state.ts",
    "packages/contracts/src/database-admission.ts",
    "packages/contracts/src/edge-policy.ts",
    "packages/contracts/src/encoding.ts",
    "packages/contracts/src/ids-core.ts",
    "packages/contracts/src/ids.ts",
    "packages/contracts/src/route-token-core.ts",
    "packages/contracts/src/route-token.ts",
    "packages/contracts/src/timestamp.ts",
  ]);
});

test("the actor loads what writes D1 only by dynamic import", () => {
  const lazy = "apps/api/src/database-actor-d1.ts";
  assert.ok(
    readFileSync(resolve(root, "apps/api/src/database-actor.ts"), "utf8").match(
      /import\("\.\/database-actor-d1\.ts"\)/,
    ),
  );
  assert.ok(!closure("apps/api/src/database-actor.ts").files.includes(lazy));
});

// A ticket claim starts in a microtask while the answer is being returned, and a Durable Object
// sends its answer only after the microtasks have drained: what the claim imports is evaluated
// before the answer leaves (measured 2026-10-19 in local workerd, first answer of a fresh isolate:
// 79 modules beyond the Worker's own added about 7 ms, these 8 add under 1 ms). This pins how
// little that is.
test("a ticket claim evaluates only a few modules beyond the Worker's own, never the router", () => {
  const loaded = new Set(closure("apps/api/src/index.ts").files);
  const claim = closure("apps/api/src/database-actor-d1.ts");
  assert.deepEqual(
    claim.files.filter((file) => !loaded.has(file)),
    [
      "apps/api/src/api-error.ts",
      "apps/api/src/database-actor-d1.ts",
      "apps/api/src/domain/admission-mutations.ts",
      "apps/api/src/domain/database-actor-sync.ts",
      "apps/api/src/domain/database-admission-snapshot.ts",
      "apps/api/src/domain/node-hints.ts",
      "apps/api/src/domain/placement.ts",
      "apps/api/src/domain/power-transition.ts",
    ],
  );
  assert.deepEqual(claim.packages, ["cloudflare:workers", "zod"]);
});

test("the Worker entry evaluates no router, cron, provider or Workflow implementation", () => {
  const graph = closure("apps/api/src/index.ts");
  // The domain modules a Durable Object class needs itself.
  const own = [
    "apps/api/src/domain/admission-state.ts",
    "apps/api/src/domain/cron-health.ts",
  ];
  const heavy = graph.files.filter(
    (file) =>
      /^apps\/api\/src\/(app|cron|openapi[^/]*)\.ts$/.test(file) ||
      /^apps\/api\/src\/(routes|providers|middleware|platform)\//.test(file) ||
      /^apps\/api\/src\/workflows\/(?!entrypoints\.ts)/.test(file) ||
      (file.startsWith("apps/api/src/domain/") && !own.includes(file)),
  );
  assert.deepEqual(heavy, []);
  assert.deepEqual(graph.packages, ["cloudflare:workers", "zod"]);
});

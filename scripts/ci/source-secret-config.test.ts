// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { installScanner } from "./image-qualification.ts";
import { runPass, type ScanInput, type ScanPass } from "./scanner.ts";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const config = join(repository, ".gitleaks.toml");
const paths = [
  "apps/native-bootstrap-relay/tests/transport.rs",
  "packages/contracts/native/controller-vectors.generated.json",
];
let directory: string, scanner: string;
let fixtures: Array<[string, Buffer]>;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "pgcf-source-secret-config-"));
  scanner = await installScanner(directory);
  fixtures = await Promise.all(
    paths.map(
      async (path) =>
        [path, await readFile(join(repository, path))] as [string, Buffer],
    ),
  );
});
after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function scan(
  name: string,
  files: Array<[string, Buffer]>,
  configured = true,
) {
  const cwd = join(directory, name);
  await mkdir(cwd, { mode: 0o700 });
  for (const [path, bytes] of files) {
    const target = join(cwd, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes);
  }
  const report = join(directory, name + ".json");
  const result = spawnSync(
    scanner,
    [
      "dir",
      ...(configured ? ["--config", config] : []),
      "--max-decode-depth=2",
      "--redact=100",
      "--no-banner",
      "--log-level=error",
      "--exit-code=99",
      "--report-format=json",
      "--report-path",
      report,
      ".",
    ],
    {
      cwd,
      timeout: 30_000,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !key.startsWith("GITLEAKS_"),
        ),
      ),
    },
  );
  assert.ok(
    result.status === 0 || result.status === 99,
    "actual scanner completed",
  );
  const findings = JSON.parse(await readFile(report, "utf8")) as Array<{
    RuleID: string;
    File: string;
  }>;
  return { exit: result.status, findings };
}

test("source exceptions require the exact reviewed file and exact value while preserving other detectors", async () => {
  const baseline = await scan("baseline", fixtures, false);
  assert.equal(baseline.exit, 99);
  assert.ok(baseline.findings.length > 0);
  const accepted = await scan("reviewed", fixtures);
  assert.equal(accepted.exit, 0);
  assert.equal(accepted.findings.length, 0);
  const changed = Buffer.from(fixtures[1]![1]);
  const document = JSON.parse(changed.toString());
  const password = document[5].manifests[14].data.password as string;
  const altered = Buffer.from(
    changed
      .toString()
      .replace(password, (password[0] === "A" ? "B" : "A") + password.slice(1)),
  );
  const mutation = await scan("changed", [[paths[1]!, altered]]);
  assert.equal(mutation.exit, 99);
  assert.ok(mutation.findings.some((f) => f.RuleID === "generic-api-key"));
  const unrelated = Buffer.from(
    `\napi_key = "${randomBytes(32).toString("base64url")}"\ngithub_token = "${String.fromCharCode(103, 104, 112, 95) + randomBytes(18).toString("hex")}"\n`,
  );
  const other = await scan("unrelated", [
    [paths[1]!, Buffer.concat([changed, unrelated])],
  ]);
  assert.equal(other.exit, 99);
  assert.ok(other.findings.some((f) => f.RuleID === "generic-api-key"));
  assert.ok(other.findings.some((f) => f.RuleID === "github-pat"));
  const wrongPath = await scan("wrong-path", [
    ["copied/controller-vectors.generated.json", changed],
  ]);
  assert.equal(wrongPath.exit, 99);
  assert.ok(wrongPath.findings.length > 0);
});

test("image runPass cannot inherit repository source exceptions", async () => {
  const parent = join(directory, "image");
  await mkdir(parent, { mode: 0o700 });
  await writeFile(join(parent, ".gitleaks.toml"), await readFile(config));
  const cwd = join(parent, "isolated");
  await mkdir(cwd, { mode: 0o700 });
  const document = JSON.parse(fixtures[1]![1].toString());
  const bytes = Buffer.from(JSON.stringify(document[0].manifests[10].data));
  const name = paths[1]!,
    diskPath = join(cwd, name);
  await mkdir(dirname(diskPath), { recursive: true, mode: 0o700 });
  await writeFile(diskPath, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const input: ScanInput = {
    kind: "layer-file",
    layer: 0,
    tarEntry: 0,
    path: name,
    sha256,
    size: bytes.length,
    sourcePath: diskPath,
  };
  const pass: ScanPass = {
    directory: cwd,
    aliases: [
      { name, diskPath, prefixLines: 0, input, detectorSha256: sha256 },
    ],
    expectedBytes: bytes.length,
    requireExactBytes: true,
  };
  const previous = process.env.GITLEAKS_CONFIG;
  process.env.GITLEAKS_CONFIG = config;
  try {
    const result = await runPass(scanner, pass, parent, "isolated");
    assert.equal(result.exit, 2);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]!.RuleID, "generic-api-key");
  } finally {
    if (previous === undefined) delete process.env.GITLEAKS_CONFIG;
    else process.env.GITLEAKS_CONFIG = previous;
  }
});

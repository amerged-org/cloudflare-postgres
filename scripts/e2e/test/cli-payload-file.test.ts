// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  chmod,
  writeFile,
  readFile,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Kubernetes } from "../src/clients.ts";

test("the guarded agent patch gives native kubectl a private real payload file and removes it", async () => {
  const client = process.env.PGCF_TEST_KUBECTL;
  assert.ok(client, "the verified pinned kubectl is required");
  const directory = await mkdtemp(join(tmpdir(), "pgcf-e2e-file-test-"));
  await chmod(directory, 0o700);
  const originalPath = process.env.PATH;
  const original = process.env.PGCF_PAYLOAD_FILE_TEST;
  const manifest = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: "pgcf-agent",
      namespace: "pgcf-system",
      uid: randomUUID(),
      resourceVersion: "9",
    },
    spec: { template: { spec: { containers: [{ name: "agent", env: [] }] } } },
  };
  const source = join(directory, "source.json"),
    report = join(directory, "report.json");
  await writeFile(source, JSON.stringify(manifest), { mode: 0o600 });
  await writeFile(
    join(directory, "kubectl"),
    `#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');const data=JSON.parse(process.env.PGCF_PAYLOAD_FILE_TEST),args=process.argv.slice(2);if(args.includes('get')){console.log(JSON.stringify({items:[JSON.parse(fs.readFileSync(data.source,'utf8'))]}));}else{const file=args.find(a=>a.startsWith('--patch-file=')).slice(13);if(file==='/dev/stdin')throw Error('fileflag_reopens_socket');const payload=JSON.parse(fs.readFileSync(file,'utf8'));fs.writeFileSync(data.report,JSON.stringify({file,fileMode:fs.statSync(file).mode&511,directoryMode:fs.statSync(path.dirname(file)).mode&511,payload}));const r=cp.spawnSync(data.client,['patch','--local=true','--filename',data.source,'--type=strategic','--patch-file='+file,'--dry-run=client','--output=json'],{encoding:'utf8'});if(r.status!==0)process.exit(1);process.stdout.write(r.stdout);}\n`,
    { mode: 0o700 },
  );
  process.env.PATH = directory + ":" + originalPath;
  process.env.PGCF_PAYLOAD_FILE_TEST = JSON.stringify({
    client,
    source,
    report,
  });
  try {
    const kube = new Kubernetes(
      join(directory, "unused-kubeconfig"),
      "unit-only",
    );
    kube.setMutationGuard(async () => {});
    await kube.patchAgentUrl(
      "pgcf-system",
      "pgcf-agent",
      manifest.metadata.uid,
      "agent",
      { name: "PGCF_API_URL", value: "https://api.invalid" },
    );
    const actual = JSON.parse(await readFile(report, "utf8"));
    assert.equal(actual.fileMode, 0o600);
    assert.equal(actual.directoryMode, 0o700);
    assert.equal(actual.payload.metadata.uid, manifest.metadata.uid);
    assert.equal(actual.payload.metadata.resourceVersion, "9");
    await assert.rejects(access(actual.file));
  } finally {
    process.env.PATH = originalPath;
    if (original === undefined) delete process.env.PGCF_PAYLOAD_FILE_TEST;
    else process.env.PGCF_PAYLOAD_FILE_TEST = original;
    await rm(directory, { recursive: true, force: true });
  }
});

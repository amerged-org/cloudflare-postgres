#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Publish an already assembled, credential-free installer; never rebuild its inputs.
import assert from "node:assert/strict";
import console from "node:console";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import process from "node:process";
import { setTimeout, clearTimeout } from "node:timers";
import { pathToFileURL } from "node:url";
import {
  fileIdentity,
  loadedInstallerId,
  installerRegistryPresence,
  PUBLICATION_LIMITS,
  verifyInstallerTransport,
} from "../../infra/talos/sandbox/publish-artifacts.ts";
import { verifyTalosInstallerRegistry } from "../ci/registry.ts";
import versions from "../../infra/platform/versions.lock.json" with { type: "json" };

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export function verifyInstallerSourceCi(input, ci, jobs) {
  assert.equal(ci.head_sha, input.source_commit);
  assert.equal(ci.status, "completed");
  assert.equal(ci.conclusion, "success");
  assert.ok(Array.isArray(jobs.jobs));
  for (const name of ["check", "native_runtime_images"]) {
    const selected = jobs.jobs.filter((job) => job.name === name);
    assert.equal(
      selected.length,
      1,
      "Required source qualification job is missing or ambiguous",
    );
    assert.equal(selected[0].status, "completed");
    assert.equal(selected[0].conclusion, "success");
  }
}
export function installerPublicationBinding(input, release) {
  assert.equal(input.version, 1);
  assert.equal(input.assembly_verified, true);
  assert.match(input.source_commit, /^[a-f0-9]{40}$/);
  assert.match(input.recipe_sha256, /^[a-f0-9]{64}$/);
  assert.match(input.manifest_digest, /^sha256:[a-f0-9]{64}$/);
  assert.match(input.archive_sha256, /^[a-f0-9]{64}$/);
  assert.ok(
    Number.isSafeInteger(input.archive_bytes) && input.archive_bytes > 0,
  );
  assert.ok(Number.isSafeInteger(input.source_ci) && input.source_ci > 0);
  assert.equal(release.targetCommitish, input.source_commit);
  assert.equal(release.isDraft, false);
  assert.equal(input.talos_version, versions.target.talosVersion);
  return {
    tag:
      "talos-r2-sandbox-" +
      input.source_commit.slice(0, 12) +
      "-" +
      input.manifest_digest.slice(7, 19),
    transportReport: {
      passed: input.assembly_verified,
      source_commit: input.source_commit,
      installer: input.installer,
    },
  };
}
function github(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
async function docker(args, directory, name) {
  const out = join(directory, name + ".log");
  const { open } = await import("node:fs/promises");
  const file = await open(out, "wx", 0o600);
  try {
    const child = spawn("docker", args, {
      stdio: ["ignore", file.fd, file.fd],
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), 600000);
    const code = await new Promise((done, fail) => {
      child.once("error", fail);
      child.once("close", done);
    }).finally(() => clearTimeout(timer));
    return { code, output: await readFile(out, "utf8") };
  } finally {
    await file.close();
  }
}
export async function publishSelectedInstaller(releaseTag, directory) {
  assert.match(releaseTag, /^[A-Za-z0-9_.-]{1,128}$/);
  assert.match(
    process.env.GITHUB_REPOSITORY ?? "",
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
  );
  assert.ok(process.env.GH_TOKEN && process.env.GITHUB_ACTOR);
  assert.match(
    process.env.IMAGE ?? "",
    /^ghcr\.io\/[a-z0-9._-]+\/[a-z0-9._-]+$/,
  );
  directory = resolve(directory);
  await mkdir(directory, { mode: 0o700 });
  const release = JSON.parse(
    github([
      "release",
      "view",
      releaseTag,
      "--repo",
      process.env.GITHUB_REPOSITORY,
      "--json",
      "targetCommitish,isDraft,assets",
    ]),
  );
  for (const [name, maximum] of [
    ["installer-amd64.transport.tar", PUBLICATION_LIMITS.asset_bytes],
    ["installer-binding.json", PUBLICATION_LIMITS.metadata_bytes],
  ]) {
    const matches = release.assets.filter((asset) => asset.name === name);
    assert.equal(matches.length, 1, "Selected installer asset is ambiguous");
    assert.ok(matches[0].size > 0 && matches[0].size <= maximum);
  }
  // The supported gh client confines authenticated asset downloads to this selected repository.
  execFileSync(
    "gh",
    [
      "release",
      "download",
      releaseTag,
      "--repo",
      process.env.GITHUB_REPOSITORY,
      "--pattern",
      "installer-amd64.transport.tar",
      "--pattern",
      "installer-binding.json",
      "--dir",
      directory,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 600000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  const archive = join(directory, "installer-amd64.transport.tar"),
    input = JSON.parse(
      await readFile(join(directory, "installer-binding.json"), "utf8"),
    ),
    selected = installerPublicationBinding(input, release),
    identity = await fileIdentity(archive);
  assert.equal(identity.sha256, input.archive_sha256);
  assert.equal(identity.size, input.archive_bytes);
  const ci = JSON.parse(
    github([
      "api",
      "repos/" +
        process.env.GITHUB_REPOSITORY +
        "/actions/runs/" +
        input.source_ci,
    ]),
  );
  const jobs = JSON.parse(
    github([
      "api",
      `repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${input.source_ci}/jobs?filter=latest&per_page=100`,
    ]),
  );
  verifyInstallerSourceCi(input, ci, jobs);
  const transport = await verifyInstallerTransport(
    archive,
    selected.transportReport,
    input.source_commit,
  );
  assert.equal(transport.manifestDigest, input.manifest_digest);
  const image = process.env.IMAGE + ":" + selected.tag,
    before = await installerRegistryPresence(image, input.manifest_digest, {
      actor: process.env.GITHUB_ACTOR,
      token: process.env.GH_TOKEN,
    });
  let attempted = false;
  if (before === "absent") {
    const loaded = await docker(
      ["load", "--input", archive],
      directory,
      "load",
    );
    assert.equal(loaded.code, 0);
    const id = loadedInstallerId(loaded.output);
    const tagged = await docker(["tag", id, image], directory, "tag");
    assert.equal(tagged.code, 0);
    attempted = true;
    await docker(["push", image], directory, "push");
    // Resolve the actual bytes after every push outcome. Never retry a push in this invocation.
  }
  const registry = await verifyTalosInstallerRegistry(
    image,
    input.installer,
    input.talos_version,
    join(directory, "registry.json"),
  );
  assert.equal(registry.manifestDigest, input.manifest_digest);
  const receipt = {
    source_commit: input.source_commit,
    source_ci: input.source_ci,
    recipe_sha256: input.recipe_sha256,
    binding_sha256: sha256(
      await readFile(join(directory, "installer-binding.json")),
    ),
    archive_sha256: identity.sha256,
    reference: process.env.IMAGE + "@" + registry.digest,
    push_attempted: attempted,
    registry,
    node_writes: 0,
    raw_image_built: false,
    native_images_rebuilt: false,
  };
  await writeFile(
    join(directory, "publication.json"),
    JSON.stringify(receipt, null, 2) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    JSON.stringify({
      reference: receipt.reference,
      source_commit: receipt.source_commit,
      push_attempted: attempted,
      verified_layers: registry.layersVerified,
      node_writes: 0,
    }),
  );
  return receipt;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await publishSelectedInstaller(process.argv[2], process.argv[3]);
  } catch {
    console.error("preassembled_installer_publication_unconfirmed");
    process.exitCode = 1;
  }
}

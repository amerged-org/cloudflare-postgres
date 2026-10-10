#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Publish an already assembled, credential-free installer; never rebuild its inputs.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
import process from "node:process";
import { setTimeout, clearTimeout } from "node:timers";
import { pathToFileURL } from "node:url";
import {
  fileIdentity,
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
      input.manifest_digest.slice(7, 19) +
      "-oci",
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
export async function copyInstallerArchive(
  archive,
  destination,
  directory,
  authFile,
) {
  archive = await realpath(archive);
  // CI and the caller already verify this exact archive and its qualified source.
  // Restrict Skopeo's local-source trust to that one file; every other source is rejected.
  const policy = join(directory, "archive-policy.json"),
    digestFile = join(directory, "copied.digest"),
    log = join(directory, "archive-copy.log");
  await writeFile(
    policy,
    JSON.stringify({
      default: [{ type: "reject" }],
      transports: {
        "oci-archive": {
          [resolve(archive)]: [{ type: "insecureAcceptAnything" }],
        },
      },
    }),
    { mode: 0o600, flag: "wx" },
  );
  const { open } = await import("node:fs/promises"),
    file = await open(log, "wx", 0o600);
  try {
    const child = spawn(
      "skopeo",
      [
        "--policy",
        policy,
        "copy",
        "--preserve-digests",
        "--retry-times",
        "0",
        "--digestfile",
        digestFile,
        ...(authFile ? ["--dest-authfile", authFile] : []),
        "oci-archive:" + resolve(archive),
        destination,
      ],
      { stdio: ["ignore", file.fd, file.fd] },
    );
    const timer = setTimeout(() => child.kill("SIGTERM"), 600000);
    const code = await new Promise((done, fail) => {
      child.once("error", fail);
      child.once("close", done);
    }).finally(() => clearTimeout(timer));
    const digest = await readFile(digestFile, "utf8")
      .then((value) => value.trim())
      .catch(() => null);
    return { code, digest };
  } finally {
    await file.close();
    await rm(policy, { force: true });
  }
}
export async function publishSelectedInstaller(releaseTag, directory) {
  let stage = "input",
    attempted = false,
    copy = null;
  directory = resolve(directory);
  await mkdir(directory, { mode: 0o700 });
  try {
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
    stage = "release_metadata";
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
    stage = "asset_download";
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
    stage = "source_qualification";
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
    stage = "archive_validation";
    const transport = await verifyInstallerTransport(
      archive,
      selected.transportReport,
      input.source_commit,
    );
    assert.equal(transport.manifestDigest, input.manifest_digest);
    stage = "registry_preflight";
    const registryHost = process.env.IMAGE.split("/")[0];
    const registryAuth = {
      actor: process.env.GITHUB_ACTOR,
      token: process.env.GH_TOKEN,
    };
    const image = process.env.IMAGE + ":" + selected.tag,
      before = await installerRegistryPresence(
        image,
        input.manifest_digest,
        registryAuth,
      );
    if (before === "absent") {
      stage = "archive_copy";
      const auth = join(directory, "registry-auth.json");
      await writeFile(
        auth,
        JSON.stringify({
          auths: {
            [registryHost]: {
              auth: Buffer.from(
                registryAuth.actor + ":" + registryAuth.token,
              ).toString("base64"),
            },
          },
        }),
        { mode: 0o600, flag: "wx" },
      );
      try {
        attempted = true;
        copy = await copyInstallerArchive(
          archive,
          "docker://" + image,
          directory,
          auth,
        );
      } finally {
        await rm(auth, { force: true });
      }
      // Always resolve the published bytes after the one transfer, including a lost/error reply.
      // A transfer digest is not registry acceptance, and no copy is repeated in this invocation.
    }
    stage = "registry_readback";
    const registry = await verifyTalosInstallerRegistry(
      image,
      input.installer,
      input.talos_version,
      join(directory, "registry.json"),
    );
    assert.equal(registry.manifestDigest, input.manifest_digest);
    if (copy?.code === 0)
      assert.equal(
        copy.digest,
        input.manifest_digest,
        "OCI copy returned an unexpected selected manifest",
      );
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
      transfer: "skopeo_preserve_digests",
      copy_exit_code: copy?.code ?? null,
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
        transfer: "skopeo_preserve_digests",
        copy_exit_code: copy?.code ?? null,
        verified_layers: registry.layersVerified,
        node_writes: 0,
      }),
    );
    return receipt;
  } catch (error) {
    const failure = {
      stage,
      copy_attempted: attempted,
      copy_exit_code: copy?.code ?? null,
      copied_digest:
        copy?.digest && /^sha256:[a-f0-9]{64}$/.test(copy.digest)
          ? copy.digest
          : null,
      error_code:
        typeof error.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code)
          ? error.code
          : "publication_unconfirmed",
      node_writes: 0,
    };
    await writeFile(
      join(directory, "failure.json"),
      JSON.stringify(failure, null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    ).catch(() => {});
    error.publicationStage = stage;
    throw error;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await publishSelectedInstaller(process.argv[2], process.argv[3]);
  } catch (error) {
    console.error(
      "preassembled_installer_publication_unconfirmed_" +
        (error.publicationStage ?? "initialization"),
    );
    process.exitCode = 1;
  }
}

// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const image = process.env.PGCF_TEST_STORAGE_IMAGE;
const sources = JSON.parse(
  readFileSync(new URL("sources.lock.json", import.meta.url), "utf8"),
);
function run(script) {
  assert.ok(image, "PGCF_TEST_STORAGE_IMAGE must name the actual built image");
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--platform=linux/amd64",
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--user=65534",
      "--cpus=1",
      "--memory=128m",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,mode=1777,size=32m",
      "--entrypoint=sh",
      image,
      "-eu",
      "-c",
      script,
    ],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  assert.equal(result.status, 0, result.stderr || "storage image test failed");
  return result.stdout;
}

test("the storage extension preserves official driver and LVM bytes, configuration and licenses", () => {
  assert.ok(image, "PGCF_TEST_STORAGE_IMAGE must name the actual built image");
  const inspected = spawnSync("docker", ["image", "inspect", image], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(
    inspected.status,
    0,
    (
      inspected.error?.message ||
      inspected.stderr ||
      "storage image inspection failed"
    ).slice(0, 4096),
  );
  const images = JSON.parse(inspected.stdout);
  assert.equal(images.length, 1, "one actual built image must be inspected");
  const [actual] = images;
  assert.equal(actual.Os, "linux", "storage image must target Linux");
  assert.equal(actual.Architecture, "amd64", "storage image must target AMD64");
  const config = Object.fromEntries(
    Object.keys(sources.driver.runtime_config).map((key) => [
      key,
      key === "WorkingDir"
        ? actual.Config[key] || "/"
        : key === "User"
          ? actual.Config[key] || ""
          : (actual.Config[key] ?? null),
    ]),
  );
  assert.deepEqual(config, sources.driver.runtime_config);
  const output = run(`
printf '%s  %s\\n' ${sources.driver.binary_sha256} /usr/local/bin/lvm-driver ${sources.driver.lvm_binary_sha256} /sbin/lvm ${sources.thin_tools.binary_sha256} /usr/sbin/pdata_tools ${sources.thin_tools.license_sha256} /usr/share/licenses/pgcf-thin-tools/COPYING ${sources.thin_tools.source_archive_sha256} ${sources.container_assembly.corresponding_source_path} | sha256sum -c - > /tmp/hashes
test "$(thin_check --version)" = ${sources.thin_tools.version}
test "$(thin_repair --version)" = ${sources.thin_tools.version}
test "$(readlink /usr/sbin/thin_check)" = pdata_tools
test "$(readlink /usr/sbin/thin_repair)" = pdata_tools
lvmconfig --type full global/thin_check_executable | grep -F 'thin_check_executable="/usr/sbin/thin_check"' > /tmp/config
cat /usr/share/pgcf/storage-sources.lock.json
`);
  assert.deepEqual(JSON.parse(output), sources);
});

test("real thin tools restore valid metadata, repair explicit geometry and reject corruption", () => {
  const output = run(`
cat > /tmp/source.xml <<'XML'
<superblock uuid="" time="1" transaction="1" data_block_size="128" nr_data_blocks="1024">
<device dev_id="1" mapped_blocks="3" transaction="1" creation_time="1" snap_time="1">
<range_mapping origin_begin="0" data_begin="1" length="3" time="1"/>
</device></superblock>
XML
truncate -s 4M /tmp/metadata /tmp/repaired /tmp/corrupt
thin_restore -i /tmp/source.xml -o /tmp/metadata
thin_check /tmp/metadata > /tmp/check.log
thin_dump /tmp/metadata > /tmp/dump.xml
grep -F 'mapped_blocks="3"' /tmp/dump.xml > /tmp/mapping
thin_repair -i /tmp/metadata -o /tmp/repaired --data-block-size 128 --nr-data-blocks 1024 --transaction-id 1
thin_check /tmp/repaired > /tmp/repaired-check.log
thin_dump /tmp/repaired > /tmp/repaired.xml
cmp /tmp/dump.xml /tmp/repaired.xml
if thin_check /tmp/corrupt > /tmp/corrupt.log 2>&1; then exit 1; fi
printf 'valid-metadata-and-repair-checked;corruption-rejected\\n'
`);
  assert.equal(
    output.trim(),
    "valid-metadata-and-repair-checked;corruption-rejected",
  );
});

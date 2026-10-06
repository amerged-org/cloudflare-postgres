// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { URL } from "node:url";
import test from "node:test";

const image = process.env.PGCF_TEST_POSTGRES_IMAGE;
const sources = JSON.parse(
  readFileSync(new URL("sources.lock.json", import.meta.url), "utf8"),
);
const upstream = `${sources.postgresql.upstream_image}@${sources.postgresql.image_index_digest}`;

test("the published assembly snapshots only the patched official root filesystem", () => {
  const dockerfile = readFileSync(
    new URL("Dockerfile", import.meta.url),
    "utf8",
  );
  assert.deepEqual(
    dockerfile.split(/\r?\n/).filter((line) => /^FROM\b/.test(line)),
    [`FROM ${upstream} AS postgres`, "FROM scratch"],
  );
  assert.match(dockerfile, /^COPY --from=postgres \/ \/$/m);
});

test("the flattened image preserves the verified upstream effective runtime configuration", () => {
  assert.ok(
    image,
    "PGCF_TEST_POSTGRES_IMAGE must name the actual locally built image",
  );
  const inspected = spawnSync(
    "docker",
    ["image", "inspect", image],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  assert.equal(inspected.status, 0, "image runtime metadata inspection failed");
  const images = JSON.parse(inspected.stdout);
  assert.equal(images.length, 1, "one built image must be inspected");
  assert.equal(images[0].Os, "linux");
  assert.equal(images[0].Architecture, "amd64");
  const config = images[0].Config;
  const actual = Object.fromEntries(
    Object.keys(sources.postgresql.runtime_config).map((key) => [
      key,
      key === "WorkingDir" ? config[key] || "/" : (config[key] ?? null),
    ]),
  );
  assert.deepEqual(actual, sources.postgresql.runtime_config);
});

test("the PostgreSQL security image preserves its engine and runs patched pgvector", () => {
  assert.ok(
    image,
    "PGCF_TEST_POSTGRES_IMAGE must name the actual locally built image",
  );
  // Root checks avoid treating an unreadable /etc/ssl/private directory as an absent key.
  const absent = spawnSync(
    "docker",
    [
      "run",
      "--platform=linux/amd64",
      "--rm",
      "--network=none",
      "--read-only",
      "--user=0",
      "--entrypoint=sh",
      image,
      "-c",
      "test ! -e /etc/ssl/private/ssl-cert-snakeoil.key && test ! -e /etc/ssl/certs/ssl-cert-snakeoil.pem",
    ],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  assert.equal(absent.status, 0, "unused upstream key or certificate remains");
  const script = `
set -euo pipefail
export PATH=/usr/lib/postgresql/18/bin:$PATH
sha256sum --check --status /usr/share/pgcf/postgres-engine.sha256
test "$(stat --format=%s /usr/lib/postgresql/18/bin/postgres)" = ${sources.postgresql.engine_bytes}
printf '%s  %s\\n' ${sources.postgresql.engine_sha256} /usr/lib/postgresql/18/bin/postgres | sha256sum --check --status
test ! -e /etc/ssl/private/ssl-cert-snakeoil.key
test ! -e /etc/ssl/certs/ssl-cert-snakeoil.pem
test "$(id -u)" = 26
test "$(dpkg-query --show --showformat='\${Version}' postgresql-18)" = 18.6-1.pgdg13+2
test "$(dpkg-query --show --showformat='\${Version}' postgresql-18-pgvector)" = 0.8.7-1.pgdg13+1
grep --quiet "default_version = '0.8.7'" /usr/share/postgresql/18/extension/vector.control
test -f /usr/share/doc/postgresql-18-pgvector/copyright
initdb --pgdata=/tmp/pgcf-image-test --auth-local=trust --auth-host=reject > /tmp/initdb.log
pg_ctl --pgdata=/tmp/pgcf-image-test --log=/tmp/postgres.log --options="-c listen_addresses='' -c unix_socket_directories=/tmp -c shared_buffers=16MB" --wait start > /tmp/start.log
trap 'pg_ctl --pgdata=/tmp/pgcf-image-test --mode=fast --wait stop > /tmp/stop.log' EXIT
psql --host=/tmp --username=postgres --dbname=postgres --no-psqlrc --set=ON_ERROR_STOP=1 --command='CREATE EXTENSION vector' > /tmp/extension.log
psql --host=/tmp --username=postgres --dbname=postgres --no-psqlrc --set=ON_ERROR_STOP=1 --tuples-only --no-align --command="SELECT current_setting('server_version_num'), (SELECT extversion FROM pg_extension WHERE extname = 'vector'), '[1,2,3]'::vector <-> '[4,5,6]'::vector"
printf '\nPGCF_SOURCES\n'
cat /usr/share/pgcf/postgres-sources.lock.json
`;
  const result = spawnSync(
    "docker",
    [
      "run",
      "--platform=linux/amd64",
      "--rm",
      "--network=none",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,mode=1777,size=256m",
      "--entrypoint",
      "bash",
      image,
      "-c",
      script,
    ],
    { encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024 },
  );
  assert.equal(
    result.status,
    0,
    result.stderr || "image runtime verification failed",
  );
  const [resultLine, recorded] = result.stdout.trim().split("\nPGCF_SOURCES\n");
  const [serverVersion, vectorVersion, distance] = resultLine.trim().split("|");
  assert.equal(serverVersion, "180006");
  assert.equal(vectorVersion, "0.8.7");
  assert.ok(Math.abs(Number(distance) - Math.sqrt(27)) < 1e-12);
  assert.deepEqual(JSON.parse(recorded), sources);
});

#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Installs the pinned PostgreSQL 18 from PGDG for the tests that start a real server, and exports
# PGCF_TEST_POSTGRES_BINDIR to the later steps of the job. The Rust tests of the node agent and the
# end-to-end package's tests need it; the job that runs either calls this script.
set -euo pipefail

PGCF_TEST_POSTGRESQL_VERSION=18.6-1.pgdg24.04+2
PGCF_PGDG_KEY_FINGERPRINT=B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8

PGCF_PGDG_DIR="$RUNNER_TEMP/pgcf-pgdg"
mkdir -m 700 "$PGCF_PGDG_DIR"
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  --connect-timeout 15 --max-time 60 --output "$PGCF_PGDG_DIR/key.asc" \
  https://www.postgresql.org/media/keys/ACCC4CF8.asc
test "$(gpg --show-keys --with-colons "$PGCF_PGDG_DIR/key.asc" | awk -F: '$1 == "fpr" { print $10; exit }')" = "$PGCF_PGDG_KEY_FINGERPRINT"
gpg --dearmor < "$PGCF_PGDG_DIR/key.asc" > "$PGCF_PGDG_DIR/key.gpg"
sudo install -m 644 "$PGCF_PGDG_DIR/key.gpg" /usr/share/keyrings/pgcf-pgdg.gpg
# No match is the common case on a fresh runner: grep's status 1 must not end the script under pipefail.
{ grep -rl 'apt.postgresql.org' /etc/apt/sources.list.d/ || true; } | xargs -r sudo rm -f
echo "deb [signed-by=/usr/share/keyrings/pgcf-pgdg.gpg] https://apt.postgresql.org/pub/repos/apt noble-pgdg main" \
  | sudo tee /etc/apt/sources.list.d/pgcf-pgdg.list > /dev/null
sudo install -d /etc/postgresql-common/createcluster.d
echo 'create_main_cluster = false' | sudo tee /etc/postgresql-common/createcluster.d/pgcf.conf > /dev/null
sudo apt-get update --quiet
sudo DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
  "postgresql-18=$PGCF_TEST_POSTGRESQL_VERSION" "postgresql-client-18=$PGCF_TEST_POSTGRESQL_VERSION"
test "$(dpkg-query --show --showformat='${Version}' postgresql-18)" = "$PGCF_TEST_POSTGRESQL_VERSION"
rm -rf "$PGCF_PGDG_DIR"
printf 'PGCF_TEST_POSTGRES_BINDIR=%s\n' /usr/lib/postgresql/18/bin >> "$GITHUB_ENV"

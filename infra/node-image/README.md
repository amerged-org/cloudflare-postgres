# Node image

One Debian 13 ("trixie") disk image for every PGCF node: EU1, US1 and every later VPS run the same
image release, so OS patches, PostgreSQL upgrades and agent releases are identical everywhere
([ULTRA plan](../../docs/architecture/cloudflare-convergence-and-serverless-plan.md) 5.4, 9.1,
9.6). Nodes differ only in configuration that the installer and the agent write: network, hostname,
enrollment seed, keys and credentials. These are the image's builder notes; the agent's own notes
are in [apps/node-agent/README.md](../../apps/node-agent/README.md).

## Pinned inputs

Everything that goes into the image is pinned in [packages.lock.json](packages.lock.json):

| Input | Pin |
| --- | --- |
| Builder base | `debian:trixie-20260918-slim` by multi-platform digest |
| Builder tools | Debian packages from the same snapshot as the image |
| mkosi | tag `v27.1`, fetched by commit and checked |
| Debian | snapshot.debian.org at `20261022T203737Z` (trixie, trixie-updates, trixie-security) |
| PGDG | `apt-archive.postgresql.org` `trixie-pgdg-archive`, key [keys/pgdg.asc](keys/pgdg.asc) by sha256 and fingerprint |
| cloudflared | the `2026.10.0` release `.deb` by URL, size and sha256 |
| Packages | every installed `.deb` with name, version, architecture, URL, size and sha256 |

`SOURCE_DATE_EPOCH` is the snapshot time, and [mkosi.conf](mkosi.conf) fixes the repart seed
(partition and filesystem identifiers) and the root filesystem's directory hash seed. The snakeoil
key and certificate that `ssl-cert` generates at install time are removed with their random hash
link. Two independent builds of the same lock and definition produce byte-identical raw images, and
zstd writes the same compressed bytes for any number of threads.

## Building

From the repository root, with Docker:

```sh
node infra/node-image/node-image.ts resolve   # only when changing the snapshot or the package set
node infra/node-image/node-image.ts advisories # does the lock lag Debian security, updates or PGDG?
node infra/node-image/node-image.ts build --binaries DIR --release NAME
node infra/node-image/boot-test.ts --image .local/node-image/out/pgcf-node.raw --accel kvm
```

- **resolve** builds once from the snapshot and the PGDG archive with network access, maps every
  installed package to the signed index entry apt verified, and rewrites the `packages` list of the
  lock. PostgreSQL, pgvector, barman-cli-cloud and `libpq5` are pinned to exact versions in
  `mkosi.conf`, so a new snapshot never moves them silently. `libpq5` needs its own pin: apt takes the
  highest version, and the PGDG archive also holds the release candidates of the next major version
  (it once handed the image `19~rc1`). `validateLock` refuses every locked version that contains
  `~alpha`, `~beta` or `~rc`.
- **advisories** asks whether the lock lags the archives it was resolved from. In the builder it
  runs `apt-get update` against the live `trixie-security` and `trixie-updates` suites of
  `deb.debian.org` and `trixie-pgdg` of `apt.postgresql.org`, verified with the container's
  `debian-archive-keyring` and with `keys/pgdg.asc` for the locked fingerprint. It prints
  `name locked available suite` for every package in the lock (`packages` and `extra`) that one of
  these suites lists at a newer Debian version, and exits 1 if there is any. A package pinned in
  `mkosi.conf` counts only within its major series: PGDG's `main` component carries `libpq5` of the
  newest major only, so once PostgreSQL 19 is released `libpq5` 19 there is not an update of the
  `libpq5` 18 that goes with the server. Nothing is installed or written to the lock. The remedy for
  a Debian package is `resolve` with a newer snapshot (the first
  [snapshot.debian.org](https://snapshot.debian.org/archive/debian-security/) timestamp whose
  `trixie-security` index lists the new versions); for a package pinned in `mkosi.conf` (the PGDG
  set) it is to raise that pin, because a snapshot never moves it, and then `resolve`. Either way a
  new image release follows. The check holds no secret.
- **build** downloads every locked `.deb` (size and sha256 checked, three attempts each), serves
  them as the only repository (mkosi `LocalMirror=`) and builds offline. The build fails if the
  installed set differs from the lock in any package or version. It writes `pgcf-node.raw`,
  `pgcf-node.raw.zst`, `SHA256SUMS` and `pgcf-node.json` (release name, snapshot, lock sha256, raw
  and compressed size and sha256, and the size and sha256 of each binary) to `<work>/out`. The
  image is compressed with zstd because the Contabo rescue system that installs it has no `xz`
  (Stage 1). `--binaries` is required: the directory holding `pgcf-agent`, `pgcf-native-gateway`,
  `pgcf-archive` and `pgcf-wal-fetch`, all four non-empty or the build stops before it downloads
  anything. Exactly these four land in `/var/lib/pgcf/bin/<release>/` with `current` linking to
  it, and their digests go into `pgcf-node.json`, because the registration must pin the files the
  nodes installed from the image run.
- The work directory defaults to `.local/node-image`. With Docker in a VM (Colima, Docker Desktop)
  it must be under a directory the VM shares, such as the home directory.
- The builder runs natively: amd64 in CI, arm64 on Apple silicon, where mkosi builds the x86-64
  image across architectures through binfmt (Rosetta or QEMU user mode). An emulated amd64 builder
  does not work: Rosetta lacks `mount_setattr`, which mkosi's sandbox needs.

The CI job `node-image` in [.github/workflows/ci.yml](../../.github/workflows/ci.yml) runs the unit
tests, builds the four binaries with the pinned Rust toolchain, builds the image and runs the boot
test with KVM. Compression and checksums are part of the build. After the boot test it collects the
files a registration takes and runs the registration script's `--dry-run` on them, so a missing file
or a binary that is not the one in the image fails the job; on a push to `main` it then keeps them for
7 days as the workflow artifact `pgcf-node-release-<commit sha>-<run attempt>`. The job holds no
secret, so it uploads nothing to R2 and registers nothing: that is the operator's step
([Registering a release](#registering-a-release)).

The CI job `advisories` runs `advisories` every day at 05:23 UTC (the workflow's `schedule`) and on a
manual dispatch with the input `advisories`; the other jobs skip on both. A red run means that a
Debian security update, a `trixie-updates` change or a PGDG release is waiting for a new lock.

## Registering a release

A node installs from, and updates to, a release the operator registered (plan 9.1, 9.2). One release
is one image build with the four binaries it was built with and the package lock; it is the same for
every node and every region. Its name is the `--release` of the build, which is also the image
version of the nodes installed from it: lower-case letters, digits, `.`, `_` and `-`, at most 64
characters (CI uses `sha-<12 hex digits of the commit>`).

### From the CI artifact

Every push to `main` of this repository (not of a fork) whose `node-image` job passed keeps the
release files for 7 days as the workflow artifact `pgcf-node-release-<commit sha>-<run attempt>`: `pgcf-node.raw.zst`,
`pgcf-node.json`, `packages.lock.json`, the four binaries and a `SHA256SUMS` of these seven files.
The uncompressed image (about 1.7 GB) is not part of it, and no credential is. The job `sign-release`
(which holds no key and runs only when `check` and `node-image` both passed: it has the signer Worker sign
that release with the identity token of its run) keeps the signature as the artifact `pgcf-node-signature-<commit sha>-<run attempt>`, one file,
`release.sig`: [release-signing.md](../../docs/operations/release-signing.md). The release is named
`sha-<first 12 hex digits of the commit>`. The artifact belongs to the commit that built it, so the
package lock comes from the artifact, not from the checkout, and the registration runs from a checkout
of exactly that commit: it checks the signature with the release key of its checkout
(`apps/node-agent/release-signing.pub`), which must be the key the build's agent carries. Only the
`push` run carries the artifacts: a manually dispatched run of the same commit (the external probe, for
one) uploads nothing, which is why the lookup below filters on `--event push`.

```sh
git fetch origin main && sha=$(git rev-parse origin/main)   # or any commit on main whose CI run passed
git switch --detach "$sha"                                   # the registration needs this commit's release key
run=$(gh run list --workflow ci.yml --branch main --event push --commit "$sha" --status success --json databaseId --jq '.[0].databaseId')
# --pattern extracts each artifact into a directory named after it; a re-run adds one per attempt.
gh run download "$run" --pattern "pgcf-node-release-$sha-*" --pattern "pgcf-node-signature-$sha-*" --dir .local/node-release
release=$(ls -d .local/node-release/pgcf-node-release-"$sha"-* | tail -n 1)
signature=$(ls -d .local/node-release/pgcf-node-signature-"$sha"-* | tail -n 1)
(cd "$release" && sha256sum --check SHA256SUMS)   # shasum -a 256 -c SHA256SUMS on macOS
node scripts/operations/register-node-image.ts --image-dir "$release" --binaries "$release" --lock "$release/packages.lock.json" --signature "$signature/release.sig"
```

The artifact expires after 7 days. Register within that time, or re-run all jobs of that CI run to
get a new one. The attempts of one commit are separate builds, and a registered release is never
overwritten, so register one attempt and keep using it.

### Or build it locally

When there is no artifact (it expired, or the release comes from a commit that is not on `main`),
build the release yourself with the local Docker builder. A local build is **not signed**: CI holds no
key, the signer Worker holds it, and the Worker signs only for the job `sign-release` of a push to
`main` (`.github/workflows/ci.yml`). The nodes refuse a release that is not signed, so the registration
refuses it too: use this path for the lab and for `--dry-run`, and register only what CI built.

```sh
# 1. The four binaries, built for linux/amd64 with the pinned Rust toolchain (CI does this too):
cargo build --release --locked --bin pgcf-agent --bin pgcf-native-gateway --bin pgcf-archive --bin pgcf-wal-fetch
mkdir -p .local/node-image/binaries
for binary in pgcf-agent pgcf-native-gateway pgcf-archive pgcf-wal-fetch; do install -m 0755 "target/release/$binary" .local/node-image/binaries/; done
# 2. The image, with the local Docker builder (see Building above):
node infra/node-image/node-image.ts build --binaries .local/node-image/binaries --release sha-0123456789ab
# 3. Check the files (a registration needs the signature that only CI makes):
node scripts/operations/register-node-image.ts --image-dir .local/node-image/out --binaries .local/node-image/binaries --dry-run
```

Step 1 builds on Linux; on another host build in a linux/amd64 container with the same toolchain.

### The registration

Both paths run `register-node-image.ts`. It reads these variables, in memory only, and never prints
their values:

| Variable | Holds |
| --- | --- |
| `PGCF_R2_ENDPOINT` | the archive bucket's S3 endpoint: `https://<account>.r2.cloudflarestorage.com`, or `https://<account>.eu.r2.cloudflarestorage.com` for an EU-jurisdiction bucket |
| `PGCF_R2_BUCKET` | the archive bucket the API binds as `ARCHIVE` |
| `PGCF_R2_ACCESS_KEY_ID`, `PGCF_R2_SECRET_ACCESS_KEY` | an R2 API token with object read and write on that bucket |
| `PGCF_API_URL`, `PGCF_API_KEY` | the management API's origin and an administrator key |

`--dry-run` reads the files, prints the manifest and stops before any network call; it reports whether
the release is signed and whether its signature verifies, and refuses for neither.
`--signature FILE` names the signature (default `<image-dir>/release.sig`), and `--release-key FILE`
the public key it must verify with (default `apps/node-agent/release-signing.pub`, the key of the
agents built from this checkout).

What the script does, and what the API checks:

- It refuses a build whose compressed image, package lock or any of the four binaries is not the
  one `pgcf-node.json` describes (so binaries rebuilt since the image was built are refused: build
  the image again), and a release name that is no version. It also derives the release's host
  files from the checkout's `mkosi.extra` ([host-files.ts](host-files.ts)) and refuses a tree whose
  list is not the one the summary states (`host_files_sha256`): check out the commit that was
  built (`--tree DIR` names another tree).
- It reads the signature and checks it against the release key before it uploads a byte: a release
  without a signature, or with one that does not verify (the signature covers the image's compressed
  and raw sha256 and size too), is refused, because the API and every node would refuse it.
- It uploads `pgcf-node.raw.zst`, `packages.lock.json` and the four binaries to
  `node-images/<version>/`, and every host file that has content to
  `node-images/<version>/host-files/<sha256>` (two files of the same bytes are one object), with
  `x-amz-checksum-sha256`, so R2 itself verifies each digest. A file
  that is already there with the same content (size, md5 and the sha256 R2 reports for it) is
  skipped, so a run that stopped half way is repeated. A file with the same size and md5 that R2
  holds no sha256 for, because another tool stored it, is sent again with the checksum: the API
  refuses a file without it. One with another content stops the run, because a registered release
  is never overwritten.
- It calls `PUT /v1/fleet/releases/<version>` with the digest and size of each file, the host
  files (path, mode, sha256, size and how each takes effect) with the digest a node that holds them
  reports, and the signature. The API refuses a registration without a well-formed signature (64
  bytes in hex), one whose signature is not the release key's signature of the registration's own
  manifest (400: it verifies with the public key built into its code, so a signature of another
  key, of another release or of other digests, an image's included, is refused and nothing is
  stored), one whose host files digest is not the list's own, and one unless the bucket holds every
  file and every host file at that size with that sha256, and it names
  every URL of the stored, immutable spec itself, as `/node/v1/releases/<version>/<file>` on its
  own origin (`NODE_API_ORIGIN`). Nothing in the registration is a URL or a credential. The script
  prints the release id and spec sha256 of the answer, and fails if the stored spec is another
  version or pins other digests than the ones it registered.
- `PUT /v1/regions/<region>/release` then assigns the release to a region: its nodes pull it, and
  AddNode installs new nodes from it. It is a compare-and-set on the region's revision:

  ```sh
  (
    # The key goes through a 0600 header file in a 0700 directory, never into curl's arguments,
    # which other users and process accounting can read (printf is a shell builtin).
    umask 077
    dir=$(mktemp -d) && trap 'rm -rf "$dir"' EXIT
    printf 'Authorization: Bearer %s\n' "$PGCF_API_KEY" >"$dir/auth.header"
    curl -sS "$PGCF_API_URL/v1/regions/<region>/release" -H "@$dir/auth.header"   # revision
    curl -sS -X PUT "$PGCF_API_URL/v1/regions/<region>/release" -H "@$dir/auth.header" \
      -H 'Content-Type: application/json' -d '{"expected_revision":<revision>,"release_id":"<version>"}'
  )
  ```

The Worker serves the files from its R2 binding. `GET` and `HEAD` of `/node/v1/releases/<version>/<file>`
answer with the size, an ETag and `Accept-Ranges: bytes`, and a single `Range` with 206. The image is
read with the install's progress token (`Authorization: Bearer`, from the installer's 0600 header
file): the token is bound to one node and the version it was issued for, and stops working when the
installer reports `rebooting` or `failed`, when the node enrolls and after 30 minutes. The binaries
and the lock need no credential: they are open artifacts, which the agent checks against the size and
sha256 its signed page pins.

## Disk layout

| Partition | Label | Size | Contents |
| --- | --- | --- | --- |
| BIOS boot | `pgcf-bios` | 1 MiB | GRUB's BIOS core image |
| ESP (vfat) | `pgcf-esp` | 512 MiB | GRUB's EFI binary, its modules, `grub/grub.cfg`, `grub/grubenv` |
| Root (ext4) | `pgcf-root` | built minimal, grown to 8 GiB at first boot | everything, including `/boot` and `/var` |
| LVM | `pgcf-lvm` | the rest of the disk, added at first boot | the agent's volume group `pgcf` and thin pool |

`systemd-repart` reads [usr/lib/repart.d](mkosi.extra/usr/lib/repart.d) at every boot: on the first
it grows the root partition to 8 GiB (`/etc/fstab` grows the filesystem with `x-systemd.growfs`) and
adds the LVM partition behind it; afterwards it changes nothing. The installer moves the backup GPT
to the end of the disk before the first boot.

## Boot

GRUB boots on BIOS (SeaBIOS) and on UEFI from the same disk. mkosi installs only GRUB's core images;
the kernel and initrd are Debian's own (`linux-image-amd64`, initramfs-tools with `MODULES=most`),
so apt kernel updates need nothing from mkosi. The static [grub.cfg](mkosi.extra/efi/grub/grub.cfg)
boots `/vmlinuz` and `/initrd.img`, which Debian's kernel packages point at the newest kernel, and
offers the previous kernel through the `.old` links. A one-shot boot of the previous kernel:
`grub-editenv /efi/grub/grubenv set next_entry=previous`, then reboot. The kernel console is on
`tty0` (Contabo VNC) and `ttyS0`. Both entries carry `systemd.ssh_auto=no`.

## What ships with the image, what with a release

A node gets files two ways. The image is written once, at an install or a reinstall. A release
reaches every running node, signed by CI (plan 9.3), and carries more than binaries.

| Reaches a running node with a release, no reinstall | Needs a new image |
| --- | --- |
| The four binaries (`pgcf-agent`, `pgcf-native-gateway`, `pgcf-archive`, `pgcf-wal-fetch`) | The bootloader and the kernel command line (`efi/grub/grub.cfg`) |
| The Debian packages of the lock, in a maintenance cycle | The partition layout and first-boot partitioning (`mkosi.repart`, `usr/lib/repart.d`), `fstab` |
| **The host files**: the systemd units and masks (`/usr/lib/systemd/system`, `/etc/systemd/system`) and the sshd, journald, sysctl, tmpfiles, sysusers and modprobe configuration (the allow-listed directories of [host-files.ts](host-files.ts)) | The firewall (`nftables.conf`), sshd's data files (`pgcf_revoked.krl`, `principals/`), the generator mask `systemd-ssh-generator`, the presets (which units are enabled), the links `/usr/libexec/pgcf/*`, `mkosi.skeleton` (package configuration at install) |
| | The initial boot and cloud-init, the installer and the installer's userData |
| | The first agent that can write host files (an agent of an earlier build refuses a page whose release lists them), and a change of the mount topology (see the rules below: nothing refuses it, and it must not reach a running node) |

Everything in `mkosi.extra` is one or the other, and the build stops at a file that is neither:
`HOST_FILE_APPLY` in [host-files.ts](host-files.ts) says how each host file takes effect, and
`IMAGE_ONLY` lists the rest with the reason. [host-files.test.ts](host-files.test.ts) and
[units.test.ts](units.test.ts) hold the tables to the tree.

### Changing a unit or a configuration file without a new image

1. Edit the file in `infra/node-image/mkosi.extra` (a new file in an allow-listed directory also
   needs its row in `HOST_FILE_APPLY`; the registration says so if it is missing). Nothing else.
2. Merge. CI builds the image, whose summary pins the digest of the host files of that tree, runs
   the registration's dry run, and the `sign-release` job has the signer sign the release: the
   signed text carries every host file with its digest and how it takes effect.
3. Register the signed build (`register-node-image.ts`, from a checkout of the commit that was
   built) and assign it to the region (`PUT /v1/regions/<region>/release`).
4. Each node's agent installs the binaries first, and then writes the files that differ: if the
   agent's own binary changed, the agent that runs after its restart writes them. It holds the
   signed list to its own rules just before it writes (a list its rules do not allow is refused for
   its files only, the binaries are installed all the same), runs `systemd-sysusers` and
   `systemd-tmpfiles --create` on the files that say so (`sysusers`, `tmpfiles`), reads systemd's
   units again once, and then restarts what changed (the gateway, cloudflared, ssh, journald,
   systemd-sysctl; the agent's own last). The agent's own unit is first written to
   `/run/systemd/system`, which systemd reads before `/usr/lib/systemd/system` and which a boot
   empties; the agent that runs it moves it to its place once it has read its first page, and a
   node whose new unit cannot start is restarted from the API (Contabo) and runs the unit it had
   ([recovery](../../docs/operations/recovery.md#the-agent-does-not-come-back-after-a-release)).
   What a running per-database unit (`pgcf-pg@.service`, `next_start`) takes from the new template
   is measured on Debian 13's systemd 257 (the lab test `a_reload_changes_what_the_next_stop_does_and_a_start_what_a_running_instance_is_made_of`):
   the reload loads the file, so `KillSignal=`, `TimeoutStopSec=` and `ExecStop=` (the stop
   settings the lab measured) are those of the instance's next stop and `systemctl show` already reports the new
   resource settings, but the running process, its exec and namespace settings (`ExecStart=`,
   `MountImages=`, `PrivateMounts=`, `User=`) and the limits its cgroup enforces (`MemoryMax=`,
   `TasksMax=`, `CPUWeight=`) stay as they were until the database's next start. The slot template
   (`pgcf-slot@.service`, below) is `next_start` the same way, and the agent stops its idle slots after the reload and
   builds them again from the new file (plan 11.2, package P; the agent code is not written yet). A failed reload,
   run or restart stays in the record and is tried again with a growing wait (5 s up to 5 min),
   not with every page; one unit that fails to restart does not keep the others from theirs, and
   the node does not report the release's files as held until all of it is done.
5. Check `GET /v1/nodes/{id}`: `os.host_files_sha256` is the release's `spec.os.host_files_sha256`
   and `os_converged` is true. A refused or failed apply is a node event with a class and no
   contents: `release_refused` with `host_file_path_refused`, `host_file_mode_refused`,
   `host_file_apply_refused` or `host_files_invalid` when the signed list breaks the agent's own
   rules (once per release), `host_files_not_applied` for a file that could not be read, written
   or told to systemd, and `agent_unit_promoted` when the agent's new unit has moved to its place.

Three rules keep a release safe on a node that already runs. They hold because the order of an
update is fixed (the binaries first, the host files after them, the packages of the lock only in
the maintenance cycle), and nothing but the author of the change checks them:

- **A new agent starts under the previous agent unit.** The binary is switched before the unit is
  written, so the new `pgcf-agent` first runs under the unit of the release before. A binary that
  needs its new unit (a path, a user, a directory, a socket activation, a changed `Type=`) would
  crash-loop and never write that unit. Ship such a change in two releases: the first is an agent
  that runs under both units, the second changes the unit.
- **A host file works with the packages of the release before.** The files land before the
  packages of the lock, which wait for the maintenance cycle. A flag of cloudflared or an option of
  sshd that only the new lock's version understands fails at its restart, and the tunnel or sshd is
  down until the cycle. Ship such a change in two releases: the lock first (a cycle), the file
  after.
- **A change of the mount topology must not reach a running node.** A release that changes
  `MountImages=` or `PrivateMounts=` in these files is written to every running node, and nothing
  refuses it: the running databases keep the topology they started with, the next start of each
  takes the new one, and a node holds both until every database has slept. Do not assign such a
  release to a region that has running nodes; V4h's change reached EU1 with a reinstall.

The agent runs the `sysusers` and `tmpfiles` files of a release before it reads systemd's units
again and before any restart in the same release, so a unit may need the users and directories
that the release makes, and a unit with `Restart=always` that crashes after the reload comes back
under its new definition with them in place.

## Units

| Unit | Runs as | Notes |
| --- | --- | --- |
| `pgcf-pg@<id>.service` | `pgcf-<id>` | One PostgreSQL per database, in `pgcf.slice`; started only by the agent |
| `pgcf-slot@<n>.service` | `pgcf-slot-<n>` | The sandbox of a database unit built before a wake, for no database; a supervisor waits in it for the agent's order ([The slot unit](#the-slot-unit)); started only by the agent |
| `pgcf.slice` | | All databases; the agent sets the awake-database memory budget, 80 % of RAM until then |
| `pgcfbackup.slice` | | barman-cloud jobs (transient units the agent starts); 512 MiB, CPU and IO weight 20; no dash in the name, because systemd nests `pgcf-backup.slice` inside `pgcf.slice` and the jobs would run under the databases' memory ceiling |
| `pgcf-agent.service` | root | `pgcf-agent run`, `Type=notify`; a mount namespace of its own, `PrivateMounts=yes` (see [The agent unit](#the-agent-unit)); creates `/run/pgcf/agent` |
| `pgcf-gateway.service` | `pgcf-gateway` | `pgcf-native-gateway` in local mode on loopback; starts once `/var/lib/pgcf/credentials/gateway.env` exists |
| `pgcf-cloudflared.service` | `pgcf-cloudflared` | The Tunnel; starts once `/var/lib/pgcf/credentials/tunnel-token.cred` exists |
| `ssh.service` | root | Loopback only, user certificates only (no CA ships, so no login until the agent writes the operator's CA key, which it does only while the shell is on); host keys are created at first boot |

A preset allowlist ([10-pgcf.preset](mkosi.extra/usr/lib/systemd/system-preset/10-pgcf.preset))
enables exactly these plus networkd, timesyncd, getty and LVM monitoring. Everything else a package
would enable stays off, in particular PostgreSQL's default cluster service, apt's automatic updates,
the weekly `fstrim` of every mount (the agent trims database volumes) and `e2scrub_all`, which would
snapshot every ext4 logical volume. `/etc/postgresql-common/createcluster.d/pgcf.conf` stops the
package from creating a default cluster.

### The PostgreSQL unit

[pgcf-pg@.service](mkosi.extra/usr/lib/systemd/system/pgcf-pg@.service) is the lab's hardened unit
(plan 5.5; `systemd-analyze security` rates it SAFE, which the boot test asserts):

- **Start:** `Type=notify`, `NotifyAccess=main`, `ExecStart=postgres -D /var/lib/pgcf/db/<id>/data`.
  Never `pg_ctl`: it polls every 100 ms and hangs under `Type=notify`. PGDG builds `--with-systemd`,
  so the postmaster sends `READY=1` when it accepts connections. `listen_addresses` is empty and the
  socket directory is `/run/pgcf/<id>` on the command line, so no configuration file can change
  either. `TimeoutStartSec=infinity`: `READY=1` follows crash recovery or a restore's replay, which
  outlasts systemd's default 90 s (Stage 1 replayed a restore for 97 s), so the agent owns the start
  deadline.
- **User:** `pgcf-<id>`, a fixed uid from the agent's node-local range in `/etc/passwd`. Never
  `DynamicUser`, which recycles uids.
- **Socket directory:** `/run/pgcf/<id>`, owner `pgcf-<id>`, group `pgcf-gateway`, mode 0750, so
  only the database and the gateway reach the socket. The agent creates it when it creates the
  database and, for every database, when it starts (`/run` is empty after a boot), and removes it
  with the database; a start without it fails. It is not a `RuntimeDirectory=`, because systemd
  resets such a directory's group to the unit's own before every start, and no `ExecStartPre=`
  creates it, because that process costs about 35 ms on every start (measured on EU1 in the
  Stage 1 lab).
- **Volume and device link:** the unit mounts its own volume:
  `MountImages=/run/pgcf/dev/<id>:/var/lib/pgcf/db/<id>:root:nosuid,nodev,noexec,noatime`, and
  `AssertPathExists=/run/pgcf/dev/<id>` fails a start without the link (`Condition…` would "succeed"
  with the unit inactive; a dangling link fails it too). `/run/pgcf/dev/<id>` is a symlink that the
  agent keeps, and it exists only while the agent has the volume attached:
  - It points to the device of the generation that is attached (`/dev/mapper/pgcf-db_<id>_g<n>`),
    and the agent makes it by rename once it has mounted the volume in its own namespace.
  - It is removed first of all before a volume is unmounted, repaired (`recover_volume`) or
    removed, when the pool's failure marks a volume as suspect, and for every volume when the agent
    starts. It is retargeted to the next generation only after that one is attached, and never made
    for a volume that is not attached or is suspect. A unit that is running does not need it: it
    keeps its own mount.
  - `/run/pgcf/dev` is root's alone (mode 0700; the agent makes it and refuses a directory that
    another user owns or has another mode), because the root executor follows what is in it and
    mounts whatever it names into the unit's namespace. It is never a socket directory or a volume.
  - The second mount of a filesystem that is mounted already costs next to nothing, and both mounts
    are one superblock: what the agent writes while the database is stopped (its configuration),
    and its resize and `fstrim` while it runs, are seen by both at once. The mount options stay
    those of the agent's (no `ro`: a second mount of a read-write filesystem fails with it).
  - There is no mount unit and no `After=…mount`: no volume is in PID 1's mount namespace. The
    stop of a database before the node goes down is the unit's own, as the boot test shows.
  - Why: systemd's executor copies PID 1's mount namespace for every unit it starts and reads
    `/proc/self/mountinfo` about 64 times (`umount_recursive_full` and
    `bind_remount_recursive_with_mountinfo`), so the start of a unit grew with every volume
    mounted there. Lab (systemd 257.13, Debian 13, one container): the executor's handoff took 36
    to 243 ms for 17 to 1,000 volumes mounted, and 35 to 40 ms for the same volumes in the agent's
    namespace. EU1 measured 105 ms at 17 volumes and 245 ms at 164, about 1 ms per volume, which is
    6.6 times the lab's slope; the live effect of the change is not measured yet.
- **Stop and restart:** `KillMode=mixed`, `KillSignal=SIGINT` (fast shutdown), `TimeoutStopSec=30`,
  `Restart=no`: every start goes through the agent's admission.
- **Limits:** `MemorySwapMax=0`, `TasksMax=64` and, until the agent applies the database's size, the
  smallest class (`MemoryMax=256M`, `MemoryHigh=230M`). The agent sets `MemoryMax`, `MemoryHigh` (90 %),
  `CPUWeight`, `IOWriteBandwidthMax`, `IOWriteIOPSMax` and `TasksMax` as persistent unit properties
  (`SetUnitProperties`), never by `daemon-reload`. `CPUQuota` is set only after ready (for a wake, after the policy's `cpu_boost_ms`, so that the
  start-up and the first requests are not throttled) and cleared
  at stop with the empty assignment `CPUQuota=` (`CPUQuotaPerSecUSec` = `UINT64_MAX` over D-Bus
  `SetUnitProperties`): a unit property outlives the stop and would throttle the next start.
  `CPUQuota=infinity` is no value: systemd rejects it ("Invalid CPU quota") and ignores a drop-in
  that holds it, so the quota stays.
- **OOM:** `OOMPolicy=continue`, `OOMScoreAdjust=-900`, `PG_OOM_ADJUST_FILE=/proc/self/oom_score_adj`,
  `PG_OOM_ADJUST_VALUE=0`: the postmaster is protected, backends are not.
- **Sandbox:** `PrivateNetwork`, `RestrictAddressFamilies=AF_UNIX`, `IPAddressDeny=any`;
  `ProtectSystem=strict` with only the unit's own volume (a mount of its own) and the socket
  directory writable; `ProtectHome`, `PrivateDevices`, and a private `/dev/shm` of 64 MiB, `/tmp`
  and `/var/tmp` of 16 MiB and 1,024 files each, mounted `noexec,nosuid,nodev` (`TemporaryFileSystem`,
  not `PrivateTmp`, which is a directory on the host's disk; a database's own `/dev/shm` size goes
  in a drop-in that applies at its next start);
  `ProtectKernelTunables/Modules/Logs`, `ProtectControlGroups`, `ProtectClock`, `ProtectHostname`,
  `ProtectProc=invisible`, `ProcSubset=pid`; `RestrictNamespaces`, `RestrictRealtime`,
  `RestrictSUIDSGID`, `LockPersonality`, `NoNewPrivileges`, an empty `CapabilityBoundingSet`,
  `RemoveIPC`, `PrivateIPC` and `InaccessiblePaths=-/run/lock -/dev/mqueue -/dev/pts
  -/var/log/journal -/run/log/journal` (below);
  `SystemCallFilter=@system-service` minus `@privileged @resources` and minus what
  kernel exploits use as a second stage and PostgreSQL does not need (`@keyring`,
  `io_uring_setup/enter/register`, `userfaultfd`, the SysV message queues and semaphores `msg*` and
  `sem*`, the POSIX message queues `mq_*`; `shmget`, `shmat`, `shmdt` and `shmctl` stay; a forbidden
  call kills the process), `MemoryDenyWriteExecute=yes` (needs `jit=off`), `UMask=0077`.
- **Nothing writable is shared with another unit** (`PrivateIPC=yes`, `InaccessiblePaths=-/run/lock
  -/dev/mqueue -/dev/pts -/var/log/journal -/run/log/journal`, and `/tmp` and `/var/tmp` as tmpfs of
  the unit). Found on EU1 by the node lab, 2026-10-20: inside the full directive set a database's
  user could create files in `/run/lock` (a 5 MiB tmpfs of the whole node, mode 1777) and in
  `/dev/mqueue` (the host's queues, mode 1777). The enumeration of what the user can write, made in
  the lab for this change, found a third: `/dev/pts` is the host's devpts, bound into the private
  `/dev`, and one user allocated 3072 of the kernel's 4096 ptys from it (the listing shows every
  unit's). Every unit shared them: a place where one tenant leaves what another reads, files that
  outlive the unit in a tmpfs that LVM keeps its lock directory in, and a pty table one tenant can
  fill. PostgreSQL uses none of them. Measured on systemd 257.13 (Debian 13, privileged container
  with systemd as PID 1, the repository's unit with the volume bound from a directory):
  `PrivateIPC=yes` gives the unit a new IPC namespace and a mqueue instance of its own (a different
  `st_dev`, a file made in one is not in the other) but leaves the directory writable, so
  `/dev/mqueue` is inaccessible as well: the filter denies `mq_open`, and creating a file in the
  directory makes the same queue. The inaccessible directories answer `EACCES`, and `/var/lock`, a
  link to `/run/lock`, with them. PostgreSQL 18.6 starts and serves in the unit (DDL, DML, a
  parallel query through dynamic shared memory in the private `/dev/shm`, a clean stop and a start
  after it): its SysV segment (56 bytes) is in the unit's namespace and in no other, and semaphores
  are the unnamed POSIX ones in shared memory. `RemoveIPC=yes` stays: it removes the objects of the
  user in the host's namespace, where a job of the same user could leave some. What
  `PrivateIPC=yes` costs the interlock is under Not set below.
  **The journal.** journald's `SplitMode=uid` (the default) keeps
  `/var/log/journal/<machine>/user-<uid>.journal` (and `/run/log/journal/...` before the flush) for
  every database uid, with a POSIX ACL that grants that uid read access, in a directory every user
  may traverse (EU1: 371 files, read-only check of 2026-10-20). The unit's user reads its own file
  (the lab shows it): its PostgreSQL log, DETAIL lines with data values included. That is a leak
  between tenants as soon as a uid is used twice, and the agent does that: `Users::release` frees a
  database's uid when the database leaves the node, `remove_account` deletes no journal file, and
  `allocate` gives the uid to a later database whose SHA-256 preference or linear probe lands on
  it, which then reads the former owner's `user-<uid>.journal` and its archived files by the
  numeric ACL (in the lab the deleted databases left eight such files behind, and a process with
  the uid of one read it while another uid could not). Both journal directories
  are inaccessible in the unit now; PostgreSQL logs through `/run/systemd/journal/stdout`, which
  stays (the lab shows its lines in the journal by invocation, the way the agent reads them).
  [pgcf-split.conf](mkosi.extra/usr/lib/systemd/journald.conf.d/pgcf-split.conf) sets
  `SplitMode=none` and removes the files at the source: journald makes no new per-uid file (lab,
  systemd 257.13: without the file `user-301000.journal` appears with the first line a slot logs,
  readable by uid 301000 and not by an unrelated uid; with it the line is in the system journal). The files
  made before stay until journald vacuums them by age, and the unit does not see them. The boot test
  makes a user of its own with the last uid of the agent's database range (299,999; the scratch
  database's user is a system account, which journald never splits), has it log a line, requires the
  line in a `system.journal` file and no `user-*.journal` file in either directory, removes the user,
  and requires the agent's own lines in `journalctl --boot=0`.
  **Scratch space.** `PrivateTmp=yes` made `/tmp` and `/var/tmp` directories on the host's root
  filesystem (8 GiB, no quota), and disk blocks are no memory that `MemoryMax` counts: an awake
  tenant could fill the root filesystem, which stops the journal and the agent's state writes for the
  whole node. They are tmpfs of the unit now, 16 MiB and 1,024 files each (`TemporaryFileSystem`,
  `noexec,nosuid,nodev`, as the 64 MiB of `/dev/shm`), their pages count in the unit's memory, and
  a write past the limit fails (the boot test writes 17 MiB). PostgreSQL uses neither directory.
  **Not bounded: the socket directory.** `/run/pgcf/<id>` is a directory on the node's `/run`
  tmpfs, and the unit's user writes there (the socket and its lock file). Lab, 2026-10-20 (a unit
  with `MemoryMax` 256 MiB, `MemoryHigh` 230 MiB and no swap): a file a tenant writes there is the
  unit's memory while the unit runs (the writer is throttled at `MemoryHigh` and stops near
  245 MiB), and it stays when the unit stops, charged to `pgcf.slice` and counted in `/run` (215
  MiB used after the stop). A tenant can leave up to its `MemoryMax` in `/run` for good, and enough
  databases fill `/run`: the device links under `/run/pgcf/dev`, systemd's runtime files and LVM's
  locks stop working, and no database on the node can wake. This is open (plan 11.2): the files
  have to leave with the unit, either by the agent emptying the directory at every stop or by a
  tmpfs of its own with a size and an inode limit; a tmpfs per database in PID 1's namespace would
  cost every start about 1 ms per database (Stage 1), so the pool's design (package P)
  decides.
  **What a database's user can still write**, enumerated inside the running unit as that user
  (`find / -writable`, symbolic links resolved): its own volume, its socket directory and the socket
  and lock file in it, the private `/tmp`, `/var/tmp` and `/dev/shm`, and the pressure file of its
  own cgroup (systemd hands it to the unit's user); the character devices of the private `/dev`
  (`null`, `zero`, `full`, `random`, `urandom`, `tty`), which hold nothing; and sockets, each on the
  boot test's explicit list and each answered by a service that checks its caller:
  - journald's `/run/systemd/journal/socket`, `dev-log` and `stdout` (the unit's log goes there);
  - systemd's notify socket `/run/systemd/notify` (only the main process of a unit with
    `NotifyAccess=main` counts) and its varlink sockets, `io.systemd.*` in `/run/systemd` and in its
    `userdb`, `netif` and `resolve` directories (PID 1, networkd and hostnamed make them; each
    answers by the caller's rights);
  - D-Bus's system bus socket `/run/dbus/system_bus_socket`, where the bus policy and polkit refuse
    a change;
  - **the agent's archive socket `/run/pgcf/agent/archive.sock`** (mode 0666 in the agent's
    `RuntimeDirectory=pgcf/agent`, mode 0755; `archive/server.rs`). It is the endpoint every
    database's archive command calls (`pgcf-archive`, `pgcf-wal-fetch`), and it authorizes a call by
    the kernel's report of the caller's uid (`SO_PEERCRED`) alone, which names one database while a
    uid belongs to one. A uid used by a second database (the pool, plan 11.2) needs more than the
    uid: the slot's cgroup and invocation.
  The gateway's socket `/run/pgcf/agent/gateway.sock` is mode 0600 and not on the list. The boot
  test enumerates the directories, regular files, sockets and FIFOs a database's user can write and
  fails on any other than the unit's own or those on the list (a FIFO is never expected), so the
  image's sockets and the next one anyone adds are seen. The backup jobs (`archive/job.rs`) run as
  the database's user with a smaller set and still see the host's `/run/lock` and `/dev/mqueue`;
  they run the node's barman, not a tenant's code, so they are not closed here.
- **Device policy:** with `PrivateDevices=yes` the policy is closed, and systemd adds to the policy of
  every unit with `MountImages=` the devices that image dissection touches: `block-device-mapper`,
  `block-blkext` and `block-loop` (`rwm`), `/dev/mapper/control` and `/dev/loop-control` (`rw`), next
  to `ProtectClock`'s `char-rtc` (`r`), which the unit had. `systemctl show -p DeviceAllow` lists
  exactly these six, and the boot test and the units' lab assert it. Nothing else widens it. It is
  one layer less between a compromised postmaster and every other database's raw volume, and it
  cannot be avoided while `MountImages=` is used. What neutralises it: the unit's private `/dev`
  has no block device node (the user cannot open one), the empty `CapabilityBoundingSet=` rules out
  `mknod`, `NoNewPrivileges=yes` keeps it so, and the device nodes are `root:disk 0660`. The units'
  lab and the boot test check this as the unit's user: `find /dev -type b` lists nothing (and
  `-type c` lists the character nodes, so the search sees what is there), `mknod` of a block node
  fails, and neither a device-mapper node by its number nor the volume's device by its name can be
  opened. The lab probe fails with 35 block nodes when `PrivateDevices=` is turned off.
- **What a database's user sees of the others:** its mount table lists its own volume only (the
  agent's mounts and the other units' are in namespaces of their own), the other databases'
  directories under `/var/lib/pgcf/db` are empty directories it cannot write, and `/var/lib/pgcf/db`
  cannot be listed. The ids of the other databases stay visible, as before and in both designs: in
  `/etc/passwd`, under `/run/pgcf`, in `/sys/block/dm-*/dm/name` (every volume's name, so every id
  and generation), in the cgroup tree (`/sys/fs/cgroup/pgcf.slice/pgcf-pg@<id>.service`) with a
  neighbour's `memory.current` and `cgroup.procs`, and in `/sys/block/dm-*/stat` and
  `/sys/fs/ext4/dm-*` (a neighbour's I/O and write counters). The isolation does not hide other
  databases; it keeps their data and their volumes out of reach. A database's own tenant data
  cannot make a volume made with the gap unmountable (every such filesystem ends 4 MiB before its
  volume, see below); a volume made before the gap existed has no such protection until it grows
  (see the rollout below).
- **Not set:** `PrivatePIDs`, because PostgreSQL's `postmaster.pid` interlock needs the units to
  share the PID namespace: a second postmaster on a running database's directory finds the first
  with `kill(pid, 0)`. `unix_socket_group`, because PostgreSQL would call `chown`, which the filter
  kills.
- **What `PrivateIPC=yes` takes from the interlock, and what replaces it.** PostgreSQL refuses a
  second postmaster on a data directory in two ways: the pid in `postmaster.pid` is alive
  (`kill(pid, 0)`), and the SysV segment named there is still attached. The second way is what
  protects a database from a backend that outlives its postmaster, and a new IPC namespace at every
  start blinds it. Lab (systemd 257.13, PostgreSQL 18.6): a backend was stopped (`SIGSTOP`), its
  postmaster killed (`SIGKILL`), and the segment stayed attached (`nattch` 1). A second postmaster in
  the same IPC namespace was refused ("pre-existing shared memory block ... is still in use"); one
  in a new IPC namespace, which `PrivateIPC=yes` gives every start, ran "database system was not
  properly shut down; automatic recovery in progress" while the old backend was alive. The real path
  to it is a backend in uninterruptible sleep through both stop timeouts ("Processes still around
  after final SIGKILL"): the unit is `failed` with a process in its cgroup, the sleep proof fails,
  the agent starts the unit to recover the database, and systemd starts a unit over a process of its
  cgroup ("Found left-over process ... while starting unit. Ignoring."; reproduced in the lab, where
  the new postmaster recovered the data directory beside the stopped backend). The same start is
  accepted earlier, while the unit is still `deactivating`: when the postmaster dies on its own,
  systemd stops what is left (`stop-sigkill`, then `final-sigkill`, each of them
  `TimeoutStopSec`, up to 60 s with the template's 30 s) with no main process and no job, and job
  mode `fail` refuses a start only against a pending job. The start is accepted as a job that
  waits, and it runs over the process when the unit has failed (lab, systemd 257.13: a backend in
  uninterruptible sleep on a frozen filesystem, `fsfreeze`). **The agent refuses that start:**
  `Units::start` reads the unit's `cgroup.events`, and a unit whose cgroup says `populated 1` is
  not started unless it is `active`, `reloading`, `activating` or `refreshing`: `failed`,
  `inactive` and `deactivating` are refused (`Error::StrayProcesses`, the diagnostic class
  `units_stray_processes`); the wake or the recovery fails like any failed start, is tried again,
  and goes through when the process is gone. A start asked for while a stop job is pending failed
  at systemd before (job mode `fail`), so no legitimate start changes; a unit that runs, starts or
  reloads is passed on to systemd as before. A stopped unit has no cgroup, so the common case is
  one failed `open`. The lab test
  `a_start_is_refused_while_the_unit_stops_over_a_process_no_signal_ends` (`units/lab.rs`) freezes
  a database's filesystem so that a process of the unit sleeps in the kernel, kills the
  postmaster, and asks for a start in each of the two states (`deactivating`, then `failed`); it
  fails without the refusal (the start is accepted and waits behind the stop) and passes with it,
  and the start goes through after the filesystem thaws. The pid half
  still refuses a second postmaster of the same user
  while a postmaster lives (the boot test asserts it). Neither half refuses one of another user:
  `kill` answers `EPERM`, which PostgreSQL reads as a stale file (`miscinit.c`), and an unreadable
  segment as foreign (`sysv_shmem.c`, `EACCES`): a database has one user, so the agent's one writer
  per database is what stops a second start today, and a pooled slot user needs the supervisor's
  lock (plan 11.2, package P).

### The slot unit

[pgcf-slot@.service](mkosi.extra/usr/lib/systemd/system/pgcf-slot@.service) is the sandbox of a
database unit built before a wake, for no database (plan 3.1, 5.5; package P). The agent keeps idle
slots, one unit per number `n`; a wake takes one instead of making systemd's executor build the
sandbox while the request waits (what that costs is in plan 11.1). An idle slot runs the supervisor, `pgcf-archive
slot <n>`, which binds `control` in its `RuntimeDirectory=`, sends `READY=1` and waits for root.
The agent then binds the database (its limits as unit properties, its volume and socket directory
as mounts moved into the slot's mount namespace, each a clone that maps the slot's user to the
database's uid on disk), and sends one order, `exec <id> <major>`; the supervisor locks the data
directory and executes the postgres command line of `pgcf-pg@.service` in place. A slot serves one
database for one awake period and ends with its stop. The agent's pool (`apps/node-agent/src/units/slots.rs`)
starts every slot and takes every start of PostgreSQL through one: a wake, a create, a restore, a move
target, a recovery, and the health check, which has the slot number 1023 to itself. The unit file,
its tests and the host files are this directory's; the supervisor is `apps/pgcf-archive`, and the
slot lab (`apps/node-agent/src/units/slot_lab.rs`) runs the pool against the unit.

- **The sandbox is the database unit's, directive by directive (D13).** `units.test.ts` holds three
  tables, each row with its reason, and fails when a directive of `pgcf-pg@.service` is missing
  from the slot unit, differs, or when the slot unit has one that the tables do not name. Not
  carried: `AssertPathExists=`, `MountImages=` and `ReadWritePaths=` for a database, because the
  volume and the socket directory arrive after the start. Changed: the description, the user and
  group, `ExecStart=` (the supervisor) and the idle limits (`MemoryMax=32M`, `MemoryHigh=28M`,
  `CPUWeight=10`; `MemorySwapMax=0` and `TasksMax=64` as before): the agent sets the database's own
  at the bind and these again when it builds the slot for its next incarnation, because a runtime
  property outlives a stop. The 32M was a placeholder until the slot lab measured it (plan 11.1): an
  idle slot holds 0.4 MiB, and 2.4 MiB at most while its unit is built, so the ceiling holds each
  with room to spare and stays. Added: `StartLimitIntervalSec=0` (slot numbers restart all the
  time, and systemd's limit of five starts in ten seconds would refuse them) and
  `RuntimeDirectory=pgcf/slot/%i` with mode 0700. Everything else is carried, and the tests that
  state the isolation of a database unit (no start process, the system-call filter, `/dev/shm`,
  `PrivateIPC` with the five inaccessible paths, the tmpfs `/tmp` and `/var/tmp`) run against both
  units.
- **A pooled user per slot.** `pgcf-slot-<n>`, uid and gid `300000 + n` (`n` from 0 to 1023): below
  systemd's container range at 524288, above the agent's database range 200000 to 299999, and
  outside the dynamic range. Files on disk keep the database's own uid (the mounts map it), so
  the plan's "a fixed user per database" holds for everything that is stored; the one exception
  is the process, which runs under a uid that a second database uses after the first. That is
  acceptable only while nothing keeps something by uid for the next tenant to find, and that is
  what the rest of this section closes and the boot test enumerates. It asserts the same of a
  second incarnation as of the first: the closed places below, journald's split, and the kernel
  keyrings read as the uid.
- **What keeps things by uid, and how each is closed.** The IPC namespace (`PrivateIPC=yes`, and
  `RemoveIPC=yes` for the host's); `/run/lock` and `/dev/mqueue` (inaccessible); `/dev/pts`
  (inaccessible); the journal (`SplitMode=none` as a host file, and the two directories
  inaccessible in the unit); the kernel keyrings (`@keyring` is denied by the filter, so no process
  of the unit adds a key; the one keyring the uid holds while a slot runs is the anonymous session
  keyring `_ses` that systemd gives every service (`KeyringMode=private`) and the kernel frees
  after the stop. The user keyring `_uid.<uid>` and every key in it would stay in the kernel after
  the last process of the uid has exited, and `/proc/keys` lists only the keys that its reader may
  view, root none of another uid's: the boot test reads it **as the uid** and requires none after
  each stop); the writable
  mounts and files (`/tmp`, `/var/tmp` and `/dev/shm` are tmpfs of the unit, the control directory
  is its `RuntimeDirectory=`, which systemd removes at the stop; only the leaf goes, the
  directories above it belong to the other slots); files in the cgroup tree (the unit's own
  pressure files, which go with the cgroup).
- **Second postmaster.** PostgreSQL's own guard fails between two uids (see Not set above), so the
  supervisor's `flock` on the data directory is what refuses a second postmaster, in a slot or
  beside a legacy database unit; the PID namespace stays shared as in the database unit.
- **Device policy.** With no `MountImages=` the policy is `closed` with `char-rtc r` alone (from
  `ProtectClock`), where the database unit's holds six entries.
- **Boot test.** `slot_unit_sandbox` (rated SAFE and no worse than the database unit),
  `slot_unit_device_allow`, the start and system-call-filter checks of the database unit run against
  the slot as well (`database_unit_waits_for_recovery`, `database_unit_has_no_start_pre`,
  `database_unit_syscall_filter`), `journal_not_split`, and three that
  enumerate what a uid keeps. Two start the real template with a runtime drop-in that replaces
  `ExecStart=` with a process that logs a line and waits (the supervisor is not under test); the
  third needs no unit:
  - `slot_isolation` starts slot 1000 twice, as two databases in turn. In each incarnation, as the
    slot's user in the namespaces of its unit with no capability: `/run/lock`, `/dev/mqueue` and
    `/dev/pts` refuse a file and a listing, both journal directories refuse a listing, the unit is
    not in PID 1's IPC namespace, the host's SysV segment is not in it and it starts with no SysV
    object, **every mount** of the unit's mount namespace that the user can write is one of the
    private `/tmp`, `/var/tmp` and `/dev/shm`, the control directory and the unit's own cgroup
    files, every directory and regular file it can write is the unit's own, every socket it can
    write is on the list of endpoints that check their caller (the control directory aside), **every
    file it can read and an unrelated uid (390000) cannot** is under its control directory, and the
    control directory is `pgcf-slot-<n>` with mode 0700. The first incarnation writes a marker in
    each writable place and makes a SysV segment; the second finds none. After each stop, from the
    host: the control directory is gone and its neighbour is not, no file the uid can read and the
    unrelated uid cannot, no file owned by the uid or its gid on any mounted filesystem (`/dev/mqueue`
    included), no journal file of the uid in `/var/log/journal` or `/run/log/journal`, no SysV
    object of the uid in the host's namespace and no key of the uid in `/proc/keys`, read as the uid.
  - `slot_enumeration_sees_an_open_unit` runs the enumeration against the same template with
    `InaccessiblePaths=` reset and `PrivateIPC=no`, and requires that it reports a file created in
    `/run/lock` and in `/dev/mqueue`, `/dev/pts` and the journal directory not refused, PID 1's IPC
    namespace and the host's SysV segment, so that the enumeration is not vacuous.
  - `slot_keyring_probe_sees_a_key` is the same control for the keyring probe: a process of an
    unrelated uid (390001) adds a key to its user keyring, and the probe that `slot_isolation` uses
    after each stop must report it. Read as root the probe reports nothing of it, which is why it
    reads as the uid.
  The checks ran in a Debian 13 container with systemd 257.13 as PID 1 (the image's units and
  journald files, the boot test's functions); the KVM boot test has not run them yet (plan 11.2).
  A journal file as journald made them before the split was turned off, and which stay on a node,
  is the control of `database_user_reads_no_journal`: the image has no `setfacl`, so the test writes
  the ACL as the extended attribute that journald's files carry.

### The agent unit

The agent mounts the database volumes, in a mount namespace of its own: `PrivateMounts=yes`, and no
other filesystem sandboxing option (the agent needs to see the node). PID 1 and the executors of
the units never see its mounts, which is the point: a unit's start does not grow with the number of
volumes (see Volume and device link above). Its mounts (attach, `fstrim`, `resize2fs`, `e2fsck`
after it has unmounted, the configuration it writes, `pg_control` and `postmaster.pid` reads) work as
before inside the namespace; the database units and the backup jobs mount their volumes themselves
(`MountImages=`).

- The namespace ends with the agent. An agent restart (a release, a crash) ends every mount it made
  and drops every device link. The agent mounts a database's volume when it decides on the
  database (`Core::reconcile`), after it has read the database's unit and its volume: the
  databases that run first, then the others, 16 at a time, each mount waiting for the disk beside
  the others. It serves the gateway as soon as it has decided on the databases that run (they
  must be in its first table as running, or the gateway ends their sessions), not when it has
  mounted every volume, and a wake for a database it has not decided on yet has the decision made
  at once, its mount included. A start that was in flight when the agent began (a unit still
  `activating`) stays counted by admission, with its memory, until the decision on its database ends
  it: the unit's answer is read from its `postmaster.pid` through the agent's mount, so it is not
  read, and not taken for a failure, before the mount is made. The databases that run are not touched: a unit has its own mount,
  which does not depend on the agent's. A restart also ends the page cache of the volumes of
  sleeping databases (their last mount is gone), so the first wake after it reads from disk: the
  plan measured about 300 ms more on a cold first request.
- The agent's exit unmounts its volumes 16 at a time (`Storage::unmount_all`) before the process
  ends. A process that exits leaves its mount namespace, and the kernel unmounts what the
  namespace holds one after the other, each as slow as the disk's flushes; the process is not gone
  until it has, and systemd starts the next agent after it (EU1: 14 s to stop with 301 volumes).
  A mount that is busy stays for the kernel.
- What a restart costs is in the plan (11.1, "Agent start"), measured in a lab with a disk slowed
  to EU1's mount time: 300 volumes, stop and start to the first served wake 76 s before the change
  and 6 s after it. On EU1 (167 volumes) it is measured in the plan (11.1, the rollout of
  `2f9901b3`); the events `agent_start_phase` of one restart (`process_start`, `storage_open`,
  `device_links`, `restore_runtime`, `link_started`, `first_page`, `units_read`, `credentials`
  (the archive credentials of the databases and the node's own, read at the same time), `apply`,
  `settled`, `gateway_table`, `service_started`, with `link_hello` and `first_wake_served` beside
  them, and `reconcile_first_pass` with the number and the summed time of the runs of `lvs`, the
  mounts and the unit reads) say where its time went.
- What the agent decides never rests on its own mount table alone, because a unit or a job mounts
  the volume in a namespace of its own, and the agent's own mounts end with its restart: whether a
  unit may start is the link (`attached`); which generation a running unit serves is its own
  `/proc/<pid>/mountinfo`; whether a volume may have lost writes while the pool took none is that
  something has its device open (`lv_attr`); whether a volume is held, and whether ext4 recorded
  an error on it, is its sysfs entry `/sys/fs/ext4/dm-<minor>`, which exists while a superblock
  does, in any namespace.
- **The rule for a held volume.** A volume is detached (`unmount_volume`, and the repair, which
  detaches first) only while no filesystem of it is alive in any namespace, and a generation of a
  database is made or mounted (`create_volume`, the boot's and a wake's attach) only while no
  filesystem of another generation of the same database is. The answer is `Busy` for the volume
  that is held and `OtherGeneration` for the next one, with or without a mount of the agent's own:
  after an agent restart that left a unit running on the old generation, the page can name the new
  generation, the boot mounts nothing of it, and a build of it is refused until the unit has
  stopped (the build ends `build_failed`, the record of the old generation stays, and the next
  pull releases it again). A start of the unit on the new generation could not have worked
  either: systemd leaves a unit that runs as it is, and the database would go on running on the
  old volume while the agent believed it ran on the new one. A removal asks lvm2, which refuses a
  device that is open (`Busy`).
- A shell on the node sees none of this: `findmnt`, `df`, `ls /var/lib/pgcf/db/<id>`, `e2fsck`
  and `fstrim` from the break-glass shell see no volume. Run a command in the agent's namespace
  with `nsenter --target "$(systemctl show --property=MainPID --value pgcf-agent.service)" --mount
  -- <command>`. `pgcf-agent check` is run that way (the agent runs it from its own namespace
  after an update); started from a shell it refuses to run, because it would mount the scratch
  volume in PID 1's namespace, where it would stay.
- `e2fsck` refuses while a unit or a job holds the device (it opens it exclusively); the agent
  repairs a volume only after its unit has stopped. The agent's own unmount does not notice a
  holder, because a mount of its own is not busy through another namespace's: after it, the agent
  looks for ext4's sysfs entry of the device, which stays while a unit or a job holds the
  filesystem, mounts the volume again, restores its link and answers `Busy` (the entry went 1 to
  2 ms after a holder ended in the lab; the agent waits 250 ms for it). With no mount of its own
  (after its restart) it looks at the entry before it does anything, and answers `Busy` the same
  way. Removing a volume asks
  lvm2, which refuses a device that a unit or a job still has open: `remove_volume` answers
  `Busy` then, after the five seconds lvm2 itself waits, and the caller tries again. A repair
  (`recover_volume`) detaches first, so it stops with `Busy` as well; between its two `e2fsck`
  runs nothing can mount the device: no link for the unit, and a job starts only from a flow
  that waits for the database's lock or at the request of the database's own processes.

### cloudflared

`cloudflared tunnel --no-autoupdate --protocol quic --metrics 127.0.0.1:20241 run --token-file
%d/tunnel-token`, with the token from `LoadCredentialEncrypted=` (`--token-file` exists since
2025.4.0). Ingress goes to the gateway and, once the shell hostname is on, to `ssh://localhost:22`,
both behind Cloudflare Access (`scripts/operations/setup-access.ts`, the operator installation
runbook). The shell hostname, `pgcf-shell-<id>.<domain>`, is off until its Access application
exists: the API makes it only while its Worker variable `NODE_SHELL_HOSTNAME` is `"true"` (plan 8).
A change of that variable reaches a running node as a new credentials revision, so the node reads
its credentials again within one pull and cloudflared keeps running: the Tunnel's ingress is
remote configuration, and the agent restarts the gateway and cloudflared only when the Tunnel
token or the route keyring changed.

## What the image expects from the agent

- `/var/lib/pgcf/bin/current/pgcf-agent run` runs the agent and signals readiness with `READY=1`.
- `pgcf-agent check` (plan 5.6 item 10) creates the scratch database on its first call and wakes
  the same database on later calls, queries it over its socket and exits 0 only when it answered;
  its volume carries the tag `pgcf.db.<id>` like every database volume. Run it in the agent's mount
  namespace (see The agent unit). The boot test runs it that way on two boots and requires the same
  volume both times.
- At first boot the agent creates the volume group `pgcf` on `/dev/disk/by-partlabel/pgcf-lvm`
  with a large metadata area, and the thin pool `pgcf/pgcf_thinpool` over the whole partition.
  On this image's lvm2 2.03.31, `lvcreate --type thin-pool` refuses `--errorwhenfull`; the working
  sequence (checked in the image) is `pvcreate --metadatasize 64m`, `vgcreate pgcf`, `lvcreate
  --type thin-pool --name pgcf_thinpool --chunksize 64K --zero y --poolmetadatasize 1G --extents
  100%FREE pgcf`, then `lvchange --errorwhenfull y pgcf/pgcf_thinpool`. On a 33 GiB partition this
  leaves 31.05 GiB of pool data next to 1 GiB of metadata and its 1 GiB spare.
- `/var/lib/pgcf/db` is mode 0711 (the agent creates it so, and tmpfiles resets it at every boot): a
  database reaches its own directory, but nobody can list this one. The IDs are not hidden: the
  accounts `pgcf-<id>` are in `/etc/passwd`, `/run/pgcf` is 0755, and sysfs and the cgroup tree show
  every volume's name and every database's unit (see Sandbox); the mount table of a database's unit
  lists its own volume only.
- Every filesystem is made and grown with an explicit size that ends 4 MiB (`FS_END_GAP_BYTES`, one
  extent) before the end of its volume: `mkfs.ext4 … <volume size - 4 MiB>K` and `resize2fs
  <device> <new size - 4 MiB>K`; systemd never grows it, and a call that finds the filesystem at
  the size or above leaves it (`dumpe2fs -h`), because resize2fs refuses to shrink one for ever.
  The units and the jobs mount a volume through systemd's image dissection, whose libblkid
  probers read the end of the device as root and refuse a device that carries a RAID or ZFS
  signature there. The farthest end-of-device probe of libblkid 2.41 is `promise_raid`'s, 3087
  sectors (1,580,544 bytes) from the end: the lab wrote a Promise signature there and `blkid -p`
  called the ext4 device a RAID member; the others (UDF at 256 blocks of 4 KiB, ZFS within 768 KiB,
  RAID superblocks within 128 KiB) are nearer. With the gap, data in a filesystem never reaches
  those sectors, which nothing writes and a thin volume reads as zeros. A filesystem made before
  the gap existed (every volume on EU1 today) fills its volume and has no protection until it
  grows: a tenant that knew the prober could make such a volume refuse its mount, so its
  database could neither start nor archive. That is accepted for Dev, where the databases are
  recreated after the rollout; an older volume is otherwise shrunk offline while its database
  sleeps (`e2fsck -f`, then `resize2fs <device> <volume size - 4 MiB>K`).
- Each database's volume is mounted by the agent, in its namespace, at `/var/lib/pgcf/db/<id>` (mode
  0700, owner `pgcf-<id>`) with the data directory `data` inside, and its unit mounts it again there
  from the link `/run/pgcf/dev/<id>`. The agent creates `/run/pgcf/<id>` (owner `pgcf-<id>`, group
  `pgcf-gateway`, mode 0750) when it creates a database and again for every database when it
  starts, because `/run` is empty after a boot. It clears the database's `CPUQuota` (`CPUQuota=`)
  whenever the database stops and, when the agent itself starts, for every stopped `pgcf-pg@` unit:
  a quota that outlived a stop or an agent crash would throttle the next start.
- It does not start a database's unit while its cgroup still holds a process (`cgroup.events` says
  `populated 1`) and the unit is not `active`, `reloading`, `activating` or `refreshing`, a
  `deactivating` unit included: the unit has a new IPC namespace at every start, so PostgreSQL
  could not find a backend that outlived its postmaster by its shared memory segment (see Not set,
  above).
- Its sockets are `/run/pgcf/agent/gateway.sock` (gateway only) and `/run/pgcf/agent/archive.sock`
  (databases, identified by uid); the archive clients are reached as
  `/usr/libexec/pgcf/pgcf-archive` and `/usr/libexec/pgcf/pgcf-wal-fetch`.
- After enrollment it writes `/var/lib/pgcf/credentials/gateway.env` (`PGCF_REGION_ID`,
  `PGCF_ROUTE_KEY`, mode 0600) and the encrypted `/var/lib/pgcf/credentials/tunnel-token.cred`,
  then starts `pgcf-gateway` and `pgcf-cloudflared`. It deletes the enrollment seed
  `/var/lib/pgcf/enrollment/seed.json` afterwards.
- A release the page names (plan 9.3) changes the binaries without a reboot: the agent downloads
  the four into `/var/lib/pgcf/bin/<release>/`, checks their size and sha256, and only then moves
  `current`. It restarts `pgcf-gateway` if the gateway's binary changed (the gateway is not drained
  first yet) and exits if its own changed, so that `Restart=always` starts the new one; the
  databases keep running. The previous release's directory stays, older ones go.
- **The units and the agent's binary go together, in one order.** The units and the masks
  (`pgcf-pg@.service`, `pgcf-agent.service`, the `modprobe@` masks) reach a node as host files of a
  release (see above), after the binaries and by the agent that runs the release's own binary, so
  a unit that asserts something the agent makes (the new `pgcf-pg@.service` mounts the volume from
  the link `/run/pgcf/dev/<id>` and asserts it) is never written before the agent that makes it.
  The change that introduced those units, `MountImages=` with `PrivateMounts=yes`, moves volumes
  out of PID 1's mount namespace and no file delivers that, so it reaches a node with the image
  (a reinstall), after a release whose agent makes the link (which works on the old image: its
  agent unit has no private mount namespace, so the volumes are in PID 1's, and the old database
  units assert the mount point, with none of the gain in start time). The reverse is an outage: an
  agent from before the link on an image with the new units makes no link, so every start of
  `pgcf-pg@` fails its assertion and no database wakes. A node on the new image therefore never
  gets an older release: **never assign a release older than the first one that makes the link to
  a region that has such a node.** Nothing refuses it; the release assignment does not check the
  image (the maintenance cycle's `pgcf-agent check` follows a package install, not a release move).
- **Host files** (`hostfiles.rs`, plan 9.3). After the binaries of a release are in place and the
  signature held, the agent holds the signed list to its own rules (a list its rules do not allow
  is refused for its files, once, with the class of the rule: the binaries are installed all the
  same, because the rules are the agent's and the release may carry the agent that knows them), then
  compares each file of the list with the disk (digest, size, mode, kind, owner) and writes what
  differs: a hidden file beside the target is written, synced and renamed over it, and the directory
  is synced, so a crash leaves the old unit or the new one and never a torn one. It never follows a
  link (a directory on the way is opened with `O_NOFOLLOW` component by component, and a link at
  the target is replaced), makes no directory but the last allow-listed one, leaves a directory at
  a target alone and removes a path that an earlier list named and this one drops, whether the
  agent wrote it or the image brought it (it keeps `agent/host-files.json` with the paths it owns
  and what is left to tell systemd, saved before the first write, and restarts the unit that a
  dropped file applied to). Then the runs of `systemd-sysusers` and `systemd-tmpfiles --create` on
  the files that say so, then one `daemon-reload`, then the restarts in name order, the
  agent's own last, each taken out of the record when done; a restart that fails does not keep the
  others from theirs, and what failed is tried again after a growing wait. A reload and restarts
  that a boot has made moot are dropped with the boot id. The agent's own unit is written to
  `/run/systemd/system` and moved to its place by the agent that runs it, after its first page. It
  reports the digest of the facts it reads from the disk in its hello, which is the release's
  only when systemd has been told everything.
- In the maintenance cycle (plan 9.3) it reads the release's package lock (the `packages.lock.json`
  of the image the release is built from), installs what differs from `dpkg` with
  `apt-get install --no-install-recommends --allow-downgrades -o Dpkg::Options::=--force-confold
  name=version…`, and cloudflared's `.deb` as a file whose sha256 it checked: the image changes the
  `nftables` conffile. The image's apt sources name its own snapshot and the PGDG archive; the
  agent writes the release's snapshot into the `URIs:` of `/etc/apt/sources.list.d/trixie.sources`.
  Then it purges the installed packages the lock does not name, with `dpkg --purge`, so that the
  node has the lock's packages and no others and its hello says the release's digest. Never a kernel
  image (Debian keeps the previous one for the boot menu, and the digest leaves idle ones out),
  never a package that `dpkg-query` marks essential or protected (Debian marks `login`, `libgcc-s1`
  and `systemd-sysv` protected), never a name that is not a package name, and nothing at all for a
  lock that names no kernel image. Dpkg refuses a package that an installed package depends on; the
  cycle then fails with `packages_not_installed`.
  The node reboots if a kernel image, `libc6`, `systemd`, `libsystemd0` or `udev` changed, right
  after the install and before any purge: the agent runs the cycle again for the open order once it
  is up, finds nothing to install, purges, and a refused purge then fails the order on the new
  kernel. After the purge, or after the boot, it runs `pgcf-agent check` of the installed release
  and answers the order.

## Security

- **No secrets in the image.** `mkosi.finalize.chroot` fails the build if any private key is found
  under `/etc`, `/var`, `/root`, `/boot` or `/efi`, if SSH host keys, the systemd credential host
  key, a random seed or a machine ID are present, if root has a usable password field, or if the
  package created a default cluster. The ssl-cert snakeoil key is removed.
- **No inbound surface.** [nftables.conf](mkosi.extra/etc/nftables.conf) drops all inbound traffic
  except replies to the node's own flows and IPv6 neighbour discovery (hop limit 255). sshd, the
  gateway and cloudflared's metrics listen on loopback only; PostgreSQL listens on no address.
- **Operator shell.** [10-pgcf.conf](mkosi.extra/etc/ssh/sshd_config.d/10-pgcf.conf) makes sshd take
  one thing: a user certificate for root, signed by the CA in `/etc/ssh/pgcf_user_ca.pub` and
  carrying the principal `pgcf-break-glass` (`/etc/ssh/principals/root`). There are no passwords, no
  `authorized_keys`, two tries, a 20 s grace time, two sessions and no forwarding of any kind; the
  log level is `VERBOSE`, which puts the certificate's key id and the CA's fingerprint in the
  journal (`ssh.service`, which the boot report and the `journal` probe read), and per-source
  penalties stay at their default. `units.test.ts` pins these values and that no other drop-in,
  principals file or key is in the image.

  The image ships no CA key, so no login is possible until a CA's public key is in the file. The
  operator holds the CA (an Ed25519 key pair whose private half is on no Worker and in no
  repository); its public key is the API Worker's variable `NODE_SSH_USER_CA_PUBLIC_KEY`, and the
  node's credentials carry it (`shell_ca_public_key`) only while `NODE_SHELL_HOSTNAME` is `"true"`
  and the variable is exactly one valid `ssh-ed25519` line. On every read of its credentials the
  agent makes the file match: it writes it atomically (a temporary file in `/etc/ssh`, mode 0644,
  owned by the agent's user, root, fsynced and renamed, with the directory fsynced) when the key is
  there and differs, and removes it when the field is absent, and it logs `shell_ca_written` or
  `shell_ca_removed`, never the key. It does this before it touches the gateway's credentials, so a
  shell that was turned off is closed whatever else fails, and a failure to write the file is
  retried with the next page. sshd needs no reload: it opens `TrustedUserCAKeys` for every
  certificate it checks and `sshd -t` does not need the file, so the file appearing makes the next
  login possible and its removal makes the next one fail (the boot test proves both without a
  reload). The operator's side is `scripts/operations/node-shell.ts`: a throwaway key signed for 15
  minutes, through `cloudflared access ssh` (docs/operations/operator-installation.md, "Using the
  shell").

  sshd refuses every public key when `RevokedKeys` names a missing file, so the image ships an empty
  key revocation list (`/etc/ssh/pgcf_revoked.krl`, the header only; `ssh-keygen -k -u -f` adds to
  it). A client offers only the certificate's key (`IdentitiesOnly=yes`), because two tries end
  after the key and its certificate.
- **No ssh socket.** With sshd installed, systemd 257's `systemd-ssh-generator` binds it to the Unix
  socket `/run/ssh-unix-local/socket` (mode 0666, which a database's user reaches, because its unit
  allows `AF_UNIX`) and to vsock. The image masks the generator (a link to `/dev/null` in
  `/etc/systemd/system-generators`) and both kernel lines of grub.cfg carry `systemd.ssh_auto=no`.
- **Kernel.** [90-pgcf.conf](mkosi.extra/usr/lib/sysctl.d/90-pgcf.conf) turns off unprivileged user
  namespaces and BPF, turns off io_uring (`kernel.io_uring_disabled = 2`: nothing on the node uses
  it, and PostgreSQL runs `io_method=worker`) and the autoload of terminal line disciplines,
  restricts kernel pointers, `dmesg` and `ptrace`, disables forwarding and redirects, and reboots
  10 s after a panic or oops (the agent recovers unproven databases at boot).
- **Journal.** [journald](mkosi.extra/usr/lib/systemd/journald.conf.d/pgcf.conf) keeps at most
  1 GiB, at least 2 GiB free and 14 days on the 8 GiB root, and syncs to disk every 15 s instead of
  every five minutes, so that the minutes before a freeze are in the journal after the reboot.
  [pgcf-split.conf](mkosi.extra/usr/lib/systemd/journald.conf.d/pgcf-split.conf) keeps one journal
  for every user (`SplitMode=none`; see The slot unit). After every reboot the agent posts the last 1,000 lines of the previous boot from `pgcf-agent`,
  `pgcf-gateway`, `pgcf-cloudflared`, `systemd-networkd`, `ssh`, PID 1 and the kernel (`journalctl
  --boot=-1`, never the units of the databases or of the backup jobs, and an event line of the agent
  only as far as the observation report carries it), which the API keeps for 30 days, one report
  per boot, and an administrator reads at `GET /v1/nodes/{id}/diagnostics`. On request
  (`POST /v1/nodes/{id}/diagnostics`) the agent also reads the journal or the kernel's lines, the
  boots, the failed units, the socket units, the listeners, the pressure figures or the thin pool,
  each a fixed command without a shell, and posts the result (plan 9.9,
  [recovery.md](../../docs/operations/recovery.md)).

## Installing a node

[installer/](installer) holds the pull installer (plan 9.2): `cloud-config.yaml`, which carries
`install.sh` and its parameters as base64. The API renders it
([node-installer.ts](../../packages/contracts/src/node-installer.ts) in the contracts package, from
the generated module of these two files), validates every parameter and refuses anything at or above
Contabo's 32 KiB userData limit. The
script checks its tools, locks the rescue system's root password, checks the hardware (memory, MAC,
IPv4 address and gateway, exactly one disk of the expected size), downloads the zstd image into
RAM from the Worker's route with the same progress token (a URL with a query is refused, and no
redirect is followed), verifies the compressed and raw sha256 and sizes before touching the disk, writes the disk,
reads it back, moves the backup GPT, writes the network settings, hostname, `resolv.conf` and the
enrollment seed, reports each checkpoint (`started`, `hardware_ok`, `image_verified`,
`disk_written`, `configured`, `rebooting`, or `failed` with the step) to the progress URL with the
progress token from a header file, and reboots. The work directory (the one that holds `install.sh`
and the parameters) is set to 0700 before the parameters are read, and the header file and the
parameters file are removed when the install succeeds, when it fails and when a parameter is
refused; `--validate-only`, which the renderer test uses, changes nothing. The node ID, region,
API URL and enrollment token are checked against the shapes of the agent's seed
(`NodeEnrollmentSeed` of `packages/contracts/src/node-link.ts`: `nod_` and 20 lowercase letters
or digits, the contract's region ID, an `https` origin with a host name, an optional port and no
path or query, `pgcf_et_` and 43 characters), because a seed the agent refuses would leave the
node installed and never enrolled; the installer's test holds both to the contract.

The installer is built on what Stage 1 recorded about Contabo's rescue system (plan 11.1):

- Its cloud-init (22.4.2, Debian 12) runs `write_files` and `runcmd`. Contabo merges its own
  configuration into the userData: its `runcmd` entries run first, and it sets a root password and
  turns SSH password login on. `cloud-config.yaml` writes an sshd drop-in that turns password login
  off; cloud-init writes it before sshd starts, and sshd reads it before Contabo's setting.
  `install.sh` locks the root password before it reports `started`.
- It has `sgdisk`, `curl`, GNU `dd`, `zstd` and `sha256sum`, but no `xz`, so the image is
  compressed with zstd. The test in [userdata.test.ts](installer/userdata.test.ts) keeps the
  script's tool list within what the rescue system carries.
- Firmware is BIOS and the network is static: the parameters carry the IPv4 address, prefix and
  gateway, and optionally IPv6 (EU1: a /23 with a gateway, and a /64 through `fe80::1`).
- The disk's size in bytes equals the provider's figure (EU1: 300 GiB, 322,122,547,200 bytes), so
  `PGCF_DISK_BYTES` is Contabo's `diskMb` times 1 MiB.

A reinstalled node's disk still carries the agent's volume group. The installer deactivates it when
the rescue system has LVM, and refuses to write while anything else sits on the disk or is mounted
from it. At the first boot `systemd-repart` wipes the signatures of the new LVM partition, so the
old volume group does not come back; the new pool's zeroing keeps old blocks from reaching a
database.

The API side renders the userData from the registered release and serves the image and the progress route (`POST` of
`{"checkpoint", "detail"}` with the Bearer token). It refuses the token once `rebooting` or `failed`
has arrived, so a second run in rescue, for example after a reboot that leads back into rescue,
stops at `started` before it touches the disk. If enrollment does not follow `rebooting`, AddNode
restarts the instance through the API. EU1's live install enrolled the node 28.0 s after the
`rebooting` checkpoint (plan 11.1).

## Boot test

[boot-test.ts](boot-test.ts) boots a copy of the image, grown by 40 GiB, in QEMU with SeaBIOS and an
isolated network (QEMU user mode with `restrict=on`) configured the way the installer configures a
node. It injects [guest.sh](boot-test/guest.sh) (gzipped, which the unit decompresses into `/run`), a unit
that runs it and that network configuration through SMBIOS system credentials
(`systemd.extra-unit.*`, `systemd.unit-dropin.*`, `network.network.*`), so the image carries no test hook.
QEMU gives all SMBIOS tables of the machine 64 KiB: with QEMU 8.2.2, strings of 62 KB arrive and strings of
66 KB corrupt the table, so the guest gets no credential at all and the boot test waits for a result that is
never written. `boot-test.ts` refuses to start when the credentials take more than 48 KiB.
The guest reports one line per check on the second serial port:

| Boot | Checks |
| --- | --- |
| First | no failed unit; nothing listens outside loopback; the journal syncs every 15 s and is not split by uid (`systemd-analyze cat-config`); no ssh socket (`ss` lists no `ssh-unix-local`, `systemctl list-sockets` no `sshd-unix-local` or `sshd-vsock`); inbound policy drop; `sshd -t` passes and `sshd -T` reports the operator shell's values; a certificate from a throwaway CA is refused on 127.0.0.1 and ::1, accepted once that CA is installed and refused again when it is removed; the four binaries; `kernel.io_uring_disabled` is 2 and `dev.tty.ldisc_autoload` is 0; `/var/lib/pgcf/db` is mode 711; root grown to 8 GiB; the LVM partition over the rest; the database unit rates SAFE, has no start timeout and no `ExecStartPre=`, and its loaded system-call filter allows `shmget` but none of the denied calls, and the slot unit does the same and rates no worse than the database unit; a transient job in `pgcfbackup.slice` runs in `/pgcfbackup.slice/`, outside `pgcf.slice`, and the slice carries the image's 512 MiB `MemoryMax`; VG `pgcf` and the thin pool with 64 KiB chunks, zeroing and error-when-full; `pgcf-agent check`, run in the agent's mount namespace, creates the scratch database on one thin volume, and its `/run/pgcf/<id>` is owned by `pgcf-<id>:pgcf-gateway` with mode 0750; no volume is in PID 1's mount namespace and the agent's has the scratch volume; its filesystem ends at least 4 MiB before its volume; the database unit's `DeviceAllow` is `char-rtc r` and the five entries of `MountImages=` with a closed policy, a private `/dev` and no capability, and the slot unit's is `char-rtc r` alone with the same policy; the scratch database's user, inside its unit, finds no block node in `/dev`, cannot make one and cannot open a device-mapper node or its volume's device; as that user, inside the unit, `/run/lock`, `/dev/mqueue` and `/dev/pts` refuse a file and a listing, no pty can be allocated, the host's markers in `/tmp`, `/var/tmp` and `/dev/shm` and the host's SysV segment are not there, the unit is not in PID 1's IPC namespace, PostgreSQL's own segment is in the unit's namespace and not in the host's, every directory and regular file the user can write is the unit's own, and a second postmaster of the same user in an IPC namespace of its own on the directory is refused with "lock file postmaster.pid already exists"; a journal file made as journald made them before the split was turned off is read by the scratch user on the host and by nothing inside the unit; a slot started twice with the template and a stand-in process shares and keeps nothing by uid (the list under [The slot unit](#the-slot-unit)), and the same enumeration finds every shared place in the template without `PrivateIPC` and the inaccessible paths; a start of a unit without a link fails its assertion; the scratch database, started from its link, runs on across a restart of the agent, whose start has dropped every link, and stays awake into the reboot |
| Second | no failed unit; loopback only; the journal syncs every 15 s and is not split by uid; no ssh socket; inbound policy drop; the binaries; both sysctl values and mode 711 again after the reboot; the pool; the agent has recreated the scratch database's `/run/pgcf/<id>` after the reboot; `pgcf-agent check` wakes the same scratch database, with no volume in PID 1's mount namespace; the database that was awake at the reboot was stopped cleanly before the node went down, and neither PostgreSQL nor ext4 recovered anything at this start |

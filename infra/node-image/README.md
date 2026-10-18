# Node image

One Debian 13 ("trixie") disk image for every PGCF node: EU1, US1 and every later VPS run the same
image release, so OS patches, PostgreSQL upgrades and agent releases are identical everywhere
([ULTRA plan](../../docs/architecture/cloudflare-convergence-and-serverless-plan.md) 5.4, 9.1,
9.6). Nodes differ only in configuration that the installer and the agent write: network, hostname,
enrollment seed, keys and credentials. These are the image's builder notes (plan Appendix C); the
agent's own notes are in `apps/node-agent/README.md`.

## Pinned inputs

Everything that goes into the image is pinned in [packages.lock.json](packages.lock.json):

| Input | Pin |
| --- | --- |
| Builder base | `debian:trixie-20260918-slim` by multi-platform digest |
| Builder tools | Debian packages from the same snapshot as the image |
| mkosi | tag `v27.1`, fetched by commit and checked |
| Debian | snapshot.debian.org at `20261016T000000Z` (trixie, trixie-updates, trixie-security) |
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
node infra/node-image/node-image.ts build --binaries DIR --release NAME
node infra/node-image/boot-test.ts --image .local/node-image/out/pgcf-node.raw --accel kvm
```

- **resolve** builds once from the snapshot and the PGDG archive with network access, maps every
  installed package to the signed index entry apt verified, and rewrites the `packages` list of the
  lock. PostgreSQL, pgvector and barman-cli-cloud are pinned to exact versions in `mkosi.conf`, so a
  new snapshot never moves them silently.
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
The uncompressed image (about 1.7 GB) is not part of it, and no credential is. The release is named
`sha-<first 12 hex digits of the commit>`. The artifact belongs to the commit that built it, so the
package lock comes from the artifact, not from the checkout. Only the `push` run carries it: a
manually dispatched run of the same commit (the external probe, for one) uploads nothing, which is why
the lookup below filters on `--event push`.

```sh
git fetch origin main && sha=$(git rev-parse origin/main)   # or any commit on main whose CI run passed
run=$(gh run list --workflow ci.yml --branch main --event push --commit "$sha" --status success --json databaseId --jq '.[0].databaseId')
# --pattern extracts each artifact into a directory named after it; a re-run adds one per attempt.
gh run download "$run" --pattern "pgcf-node-release-$sha-*" --dir .local/node-release
release=$(ls -d .local/node-release/pgcf-node-release-"$sha"-* | tail -n 1)
(cd "$release" && sha256sum --check SHA256SUMS)   # shasum -a 256 -c SHA256SUMS on macOS
node scripts/operations/register-node-image.ts --image-dir "$release" --binaries "$release" --lock "$release/packages.lock.json"
```

The artifact expires after 7 days. Register within that time, or re-run all jobs of that CI run to
get a new one. The attempts of one commit are separate builds, and a registered release is never
overwritten, so register one attempt and keep using it.

### Or build it locally

When there is no artifact (it expired, or the release comes from a commit that is not on `main`),
build the release yourself with the local Docker builder:

```sh
# 1. The four binaries, built for linux/amd64 with the pinned Rust toolchain (CI does this too):
cargo build --release --locked --bin pgcf-agent --bin pgcf-native-gateway --bin pgcf-archive --bin pgcf-wal-fetch
mkdir -p .local/node-image/binaries
for binary in pgcf-agent pgcf-native-gateway pgcf-archive pgcf-wal-fetch; do install -m 0755 "target/release/$binary" .local/node-image/binaries/; done
# 2. The image, with the local Docker builder (see Building above):
node infra/node-image/node-image.ts build --binaries .local/node-image/binaries --release sha-0123456789ab
# 3. Upload the six files and register the release:
node scripts/operations/register-node-image.ts --image-dir .local/node-image/out --binaries .local/node-image/binaries
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

`--dry-run` reads the files, prints the manifest and stops before any network call.

What the script does, and what the API checks:

- It refuses a build whose compressed image, package lock or any of the four binaries is not the
  one `pgcf-node.json` describes (so binaries rebuilt since the image was built are refused: build
  the image again), and a release name that is no version.
- It uploads `pgcf-node.raw.zst`, `packages.lock.json` and the four binaries to
  `node-images/<version>/` with `x-amz-checksum-sha256`, so R2 itself verifies each digest. A file
  that is already there with the same content (size, md5 and the sha256 R2 reports for it) is
  skipped, so a run that stopped half way is repeated. A file with the same size and md5 that R2
  holds no sha256 for, because another tool stored it, is sent again with the checksum: the API
  refuses a file without it. One with another content stops the run, because a registered release
  is never overwritten.
- It calls `PUT /v1/fleet/releases/<version>` with the digest and size of each file. The API refuses
  the registration unless the bucket holds every file at that size with that sha256, and it names
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
`tty0` (Contabo VNC) and `ttyS0`.

## Units

| Unit | Runs as | Notes |
| --- | --- | --- |
| `pgcf-pg@<id>.service` | `pgcf-<id>` | One PostgreSQL per database, in `pgcf.slice`; started only by the agent |
| `pgcf.slice` | | All databases; the agent sets the awake-database memory budget, 80 % of RAM until then |
| `pgcfbackup.slice` | | barman-cloud jobs (transient units the agent starts); 512 MiB, CPU and IO weight 20; no dash in the name, because systemd nests `pgcf-backup.slice` inside `pgcf.slice` and the jobs would run under the databases' memory ceiling |
| `pgcf-agent.service` | root | `pgcf-agent run`, `Type=notify`; host mount namespace (see below); creates `/run/pgcf/agent` |
| `pgcf-gateway.service` | `pgcf-gateway` | `pgcf-native-gateway` in local mode on loopback; starts once `/var/lib/pgcf/credentials/gateway.env` exists |
| `pgcf-cloudflared.service` | `pgcf-cloudflared` | The Tunnel; starts once `/var/lib/pgcf/credentials/tunnel-token.cred` exists |
| `ssh.service` | root | Loopback only, no passwords; host keys are created at first boot |

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
- **Mount check:** `AssertPathIsMountPoint=/var/lib/pgcf/db/<id>`: a start on an unmounted volume
  fails (`Condition…` would "succeed" with the unit inactive). `After=` the mount unit only orders
  the stop before the unmount at shutdown; nothing ties the database's life to the mount.
- **Stop and restart:** `KillMode=mixed`, `KillSignal=SIGINT` (fast shutdown), `TimeoutStopSec=30`,
  `Restart=no`: every start goes through the agent's admission.
- **Limits:** `MemorySwapMax=0`, `TasksMax=64` and, until the agent applies the database's size, the
  smallest class (`MemoryMax=256M`, `MemoryHigh=230M`). The agent sets `MemoryMax`, `MemoryHigh` (90 %),
  `CPUWeight`, `IOWriteBandwidthMax`, `IOWriteIOPSMax` and `TasksMax` as persistent unit properties
  (`SetUnitProperties`), never by `daemon-reload`. `CPUQuota` is set only after ready and cleared
  at stop with the empty assignment `CPUQuota=` (`CPUQuotaPerSecUSec` = `UINT64_MAX` over D-Bus
  `SetUnitProperties`): a unit property outlives the stop and would throttle the next start.
  `CPUQuota=infinity` is no value: systemd rejects it ("Invalid CPU quota") and ignores a drop-in
  that holds it, so the quota stays.
- **OOM:** `OOMPolicy=continue`, `OOMScoreAdjust=-900`, `PG_OOM_ADJUST_FILE=/proc/self/oom_score_adj`,
  `PG_OOM_ADJUST_VALUE=0`: the postmaster is protected, backends are not.
- **Sandbox:** `PrivateNetwork`, `RestrictAddressFamilies=AF_UNIX`, `IPAddressDeny=any`;
  `ProtectSystem=strict` with only the data directory writable; `ProtectHome`, `PrivateTmp`,
  `PrivateDevices`, a private `/dev/shm` of 64 MiB (`TemporaryFileSystem`; a database's own size
  goes in a drop-in that applies at its next start); `ProtectKernelTunables/Modules/Logs`,
  `ProtectControlGroups`, `ProtectClock`, `ProtectHostname`, `ProtectProc=invisible`,
  `ProcSubset=pid`; `RestrictNamespaces`, `RestrictRealtime`, `RestrictSUIDSGID`,
  `LockPersonality`, `NoNewPrivileges`, an empty `CapabilityBoundingSet`, `RemoveIPC`;
  `SystemCallFilter=@system-service ~@privileged ~@resources` (a forbidden call kills the process),
  `MemoryDenyWriteExecute=yes` (needs `jit=off`), `UMask=0077`.
- **Not set:** `PrivatePIDs` and `PrivateIPC`, because PostgreSQL's `postmaster.pid` interlock needs
  them off (the lab showed a second unit on the same directory being refused); `unix_socket_group`,
  because PostgreSQL would call `chown`, which the filter kills.

### The agent unit

The agent mounts the database volumes. It runs in the host mount namespace on purpose: any
filesystem sandboxing option (`ProtectSystem`, `PrivateTmp`, `ReadWritePaths`, …) would give it a
private mount namespace, and volumes it mounts there would be invisible to the database units. Its
restart never stops a database, because the databases are independent units.

### cloudflared

`cloudflared tunnel --no-autoupdate --protocol quic --metrics 127.0.0.1:20241 run --token-file
%d/tunnel-token`, with the token from `LoadCredentialEncrypted=` (`--token-file` exists since
2025.4.0). Ingress goes to the gateway and to `ssh://localhost:22`, both behind Cloudflare Access.

## What the image expects from the agent

- `/var/lib/pgcf/bin/current/pgcf-agent run` runs the agent and signals readiness with `READY=1`.
- `pgcf-agent check` (plan 5.6 item 10) creates the scratch database on its first call and wakes
  the same database on later calls, queries it over its socket and exits 0 only when it answered;
  its volume carries the tag `pgcf.db.<id>` like every database volume. The boot test runs it on
  two boots and requires the same volume both times.
- At first boot the agent creates the volume group `pgcf` on `/dev/disk/by-partlabel/pgcf-lvm`
  with a large metadata area, and the thin pool `pgcf/pgcf_thinpool` over the whole partition.
  On this image's lvm2 2.03.31, `lvcreate --type thin-pool` refuses `--errorwhenfull`; the working
  sequence (checked in the image) is `pvcreate --metadatasize 64m`, `vgcreate pgcf`, `lvcreate
  --type thin-pool --name pgcf_thinpool --chunksize 64K --zero y --poolmetadatasize 1G --extents
  100%FREE pgcf`, then `lvchange --errorwhenfull y pgcf/pgcf_thinpool`. On a 33 GiB partition this
  leaves 31.05 GiB of pool data next to 1 GiB of metadata and its 1 GiB spare.
- Each database's volume is mounted at `/var/lib/pgcf/db/<id>` (mode 0700, owner `pgcf-<id>`) with
  the data directory `data` inside. The agent creates `/run/pgcf/<id>` (owner `pgcf-<id>`, group
  `pgcf-gateway`, mode 0750) when it creates a database and again for every database when it
  starts, because `/run` is empty after a boot. It clears the database's `CPUQuota` (`CPUQuota=`)
  whenever the database stops and, when the agent itself starts, for every stopped `pgcf-pg@` unit:
  a quota that outlived a stop or an agent crash would throttle the next start.
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
- In the maintenance cycle (plan 9.3) it reads the release's package lock (the `packages.lock.json`
  of the image the release is built from), installs what differs from `dpkg` with
  `apt-get install --no-install-recommends --allow-downgrades -o Dpkg::Options::=--force-confold
  name=version…`, and cloudflared's `.deb` as a file whose sha256 it checked: the image changes the
  `nftables` conffile. The image's apt sources name its own snapshot and the PGDG archive; the
  agent writes the release's snapshot into the `URIs:` of `/etc/apt/sources.list.d/trixie.sources`.
  The node reboots if a kernel image, `libc6`, `systemd`, `libsystemd0` or `udev` changed. After
  the packages, or after the boot, it runs `pgcf-agent check` of the installed release and answers
  the order.

## Security

- **No secrets in the image.** `mkosi.finalize.chroot` fails the build if any private key is found
  under `/etc`, `/var`, `/root`, `/boot` or `/efi`, if SSH host keys, the systemd credential host
  key, a random seed or a machine ID are present, if root has a usable password field, or if the
  package created a default cluster. The ssl-cert snakeoil key is removed.
- **No inbound surface.** [nftables.conf](mkosi.extra/etc/nftables.conf) drops all inbound traffic
  except replies to the node's own flows and IPv6 neighbour discovery (hop limit 255). sshd, the
  gateway and cloudflared's metrics listen on loopback only; PostgreSQL listens on no address.
- **Kernel.** [90-pgcf.conf](mkosi.extra/usr/lib/sysctl.d/90-pgcf.conf) turns off unprivileged user
  namespaces and BPF, restricts kernel pointers, `dmesg` and `ptrace`, disables forwarding and
  redirects, and reboots 10 s after a panic or oops (the agent recovers unproven databases at boot).
- **Journal.** [journald](mkosi.extra/usr/lib/systemd/journald.conf.d/pgcf.conf) keeps at most
  1 GiB, at least 2 GiB free and 14 days on the 8 GiB root.

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
stops at `started` before it touches the disk. Stage 1 left rescue through the API's
`actions/restart`; whether the script's own reboot leaves rescue is recorded at the first install
(Stage 4). If enrollment does not follow `rebooting`, AddNode restarts the instance through the API.

## Boot test

[boot-test.ts](boot-test.ts) boots a copy of the image, grown by 40 GiB, in QEMU with SeaBIOS and an
isolated network (QEMU user mode with `restrict=on`) configured the way the installer configures a
node. It injects [guest.sh](boot-test/guest.sh), a unit that runs it and that network configuration
through SMBIOS system credentials (`systemd.extra-unit.*`, `systemd.unit-dropin.*`,
`network.network.*`), so the image carries no test hook.
The guest reports one line per check on the second serial port:

| Boot | Checks |
| --- | --- |
| First | no failed unit; nothing listens outside loopback; inbound policy drop; the four binaries; root grown to 8 GiB; the LVM partition over the rest; the database unit rates SAFE, has no start timeout and no `ExecStartPre=`; a transient job in `pgcfbackup.slice` runs in `/pgcfbackup.slice/`, outside `pgcf.slice`; VG `pgcf` and the thin pool with 64 KiB chunks, zeroing and error-when-full; `pgcf-agent check` creates the scratch database on one thin volume, and its `/run/pgcf/<id>` is owned by `pgcf-<id>:pgcf-gateway` with mode 0750 |
| Second | no failed unit; loopback only; inbound policy drop; the binaries; the pool; the agent has recreated the scratch database's `/run/pgcf/<id>` after the reboot; `pgcf-agent check` wakes the same scratch database |

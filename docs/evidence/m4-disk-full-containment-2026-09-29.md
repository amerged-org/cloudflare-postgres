# Disk-full neighbor containment on the existing storage stack

One bounded native qualification passes in 33.184 seconds on the authorized
single-node Talos lab. A fresh thick-provisioned filesystem reaches `ENOSPC` while
a separately mounted neighbor remains durable and writable. Existing PostgreSQL
markers and original runtime/storage identities remain preserved. This advances
the M4 storage-containment gate; it does not complete tenant isolation or production
readiness.

## Scope and preconditions

The existing qualified OpenEBS LocalPV LVM driver and `pgcf` group are unchanged.
Fresh observations establish 82,137,055,232 free group bytes and request headroom:
1,705 millicores / 3,315,597,312 memory bytes requested against 3,950 millicores /
7,667,183,616 allocatable bytes. The two probes request 100 millicores and 128 MiB
in total; their two volumes reserve 128 MiB. Nominal headroom is not a production
capacity reservation or peak-load guarantee.

Two new restricted, default-deny namespaces each contain one 64-MiB claim and one
nonroot probe with no service-account token, dropped capabilities and read-only
root filesystem. A unique fixture StorageClass copies the existing thick/ext4/VG
and `WaitForFirstConsumer` policy; only fixture reclamation uses Delete. The
original Retain class is preserved byte-for-byte. Scheduler NodeAffinity selects
the expected Node; `nodeName` never bypasses delayed binding.

Before writing, exact Node UID/boot, separate Pod/PVC/PV identities, claim bindings,
driver/group/class and filesystem capacity are sealed. Both CSI handles are
distinct and excluded from all original volume handles. The probe writes only
the mounted fresh target, with a 256-MiB maximum and 30-second loop deadline.

## Observed failure and neighbor behavior

The target writes 55,836,672 bytes before its selected write fails with `ENOSPC`.
Filesystem overhead/reservations mean usable file capacity differs from nominal
PV size; the report does not claim every smaller write must fail. A later 1-MiB
append also fails while the volume remains full.

During that condition, the neighbor retains its original fsynced marker, creates
and fsyncs a separate marker, and reads both back. Its filesystem capacity is
unchanged and available space remains 55,991,296 bytes. Both original PostgreSQL
lab markers remain readable with count one. No write is made to those databases
or their volumes.

The original Node UID/boot stays Ready, all 29 original Running Pod UIDs/restart
counts stay stable, all five original PV identities/specifications remain intact,
and the same original CNPG Cluster remains Ready. These observations establish
the selected filesystem boundary and neighbor continuity, not arbitrary kernel,
extension, network or noisy-I/O isolation.

## Cleanup and verification discipline

Cleanup checks fresh volume inventory against all original CSI handles, then
uses exact UID preconditions for only the two owned namespaces and fixture class.
Final success requires their absence, absence of both fixture PVs and physical
LVM readback matching the original group UUID, size, free bytes and logical-volume
count. Those checks pass; the original five PVs and Retain class remain preserved.

This is one actual qualification of unchanged upstream behavior. No artificial
red test, new production implementation, generated suite or full workspace gate
is introduced. Syntax/schema checks and pre-effect review address fixture scope,
producer timeout and cleanup completion before the single runtime attempt. No
held candidate or previous failed qualifier is resumed by this exercise.

The environment files and all held draft hashes remain unchanged. Customer
admission, provider resources, Worker/D1 state and platform release ownership are
untouched. PostgreSQL behavior when its own data/WAL volume fills, recovery from
that incident, physical backups/PITR, node loss and the remaining M4/M8 gates stay
open. See [PLAN.md](../../PLAN.md) for the full scope.

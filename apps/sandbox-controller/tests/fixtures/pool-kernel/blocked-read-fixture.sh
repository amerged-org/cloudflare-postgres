#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Explicit owned local reader fixture; never a production permission or namespace observer.
set -eu
exec 2>&1
umask 077
case "$1" in ''|*[!0-9]*) exit 1;; esac
reader_pid=$1
for marker in mounted ready suspended resume reaped; do test ! -e "/fixture/$marker"; done
export LVM_SYSTEM_DIR=/tmp/pgcf-a8
mkdir /tmp/pgcf-a8 /tmp/pgcf-a8/seed /tmp/pgcf-a8/readonly
truncate -s 256M /tmp/pgcf-a8/disk
loop=$(losetup --find --show /tmp/pgcf-a8/disk)
vg=pgcf_a8_$(cat /proc/sys/kernel/random/uuid | tr -d '-')
printf 'devices { use_devicesfile=0 filter=["a|^%s$|","r|.*|"] }\n' "$loop" > /tmp/pgcf-a8/lvm.conf
cleanup(){
 set -e
 if lvs "$vg/volume" >/dev/null 2>&1; then
  dmsetup resume "$vg-volume"
  if mountpoint -q /tmp/pgcf-a8/seed; then umount /tmp/pgcf-a8/seed; fi
  # Receiver's actual read/tool refs must be reaped before a normal unmount.
  test -f /fixture/reaped
  /producer/pgcf-pool-kernel-fixture --blocked-read-unmount "$reader_pid"
  if mountpoint -q /tmp/pgcf-a8/readonly; then umount /tmp/pgcf-a8/readonly; fi
  test "$(dmsetup info -c --noheadings -o open "$vg-volume" | tr -d '[:space:]')" = 0
  lvremove --yes "$vg/volume" >/dev/null
 fi
 if vgs "$vg" >/dev/null 2>&1; then vgremove --yes "$vg" >/dev/null; fi
 pvremove --yes "$loop" >/dev/null
 losetup --detach "$loop"
 printf 'owned_blocked_reader_all_refs_closed_global_dm0_normal_cleanup=true\n'
}
trap cleanup EXIT
pvcreate --yes "$loop" >/dev/null
vgcreate "$vg" "$loop" >/dev/null
lvcreate --yes --type thin-pool --size 128M --poolmetadatasize 4M --chunksize 64K --name pool "$vg" >/dev/null
lvcreate --yes --virtualsize 128M --thinpool "$vg/pool" --name volume >/dev/null
mkfs.ext4 -q "/dev/$vg/volume"
mount "/dev/$vg/volume" /tmp/pgcf-a8/seed
cp -a /fixture/pgdata /tmp/pgcf-a8/seed/pgdata
umount /tmp/pgcf-a8/seed
vg_uuid=$(vgs --noheadings -o vg_uuid "$vg" | tr -d '[:space:]')
lv_uuid=$(lvs --noheadings -o lv_uuid "$vg/volume" | tr -d '[:space:]')
pool_uuid=$(lvs --noheadings -o lv_uuid "$vg/pool" | tr -d '[:space:]')
thin_id=$(lvs --noheadings -o thin_id "$vg/volume" | tr -d '[:space:]')
/producer/pgcf-pool-kernel-fixture --blocked-read-mount "$reader_pid" "/dev/mapper/$vg-volume" "$vg_uuid" "$lv_uuid" "$pool_uuid" "$thin_id"
touch /fixture/mounted
wait_marker(){ n=0;while ! test -f "/fixture/$1"; do n=$((n+1));test "$n" -lt 6000;sleep .01;done; }
wait_marker ready
dmsetup info --columns --noheadings --separator '|' --options uuid,major,minor,suspended,readonly,open "$vg-volume"
printf 'owned_reader_ready_observed=true\n'
dmsetup suspend --noflush --nolockfs "$vg-volume"
printf 'owned_suspend_command_completed=true\n'
dmsetup info --columns --noheadings --separator '|' --options uuid,major,minor,suspended,readonly,open "$vg-volume"
/producer/pgcf-pool-kernel-fixture --blocked-read-status "$vg_uuid" "$lv_uuid" "$pool_uuid" "$thin_id"
touch /fixture/suspended
wait_marker resume
dmsetup resume "$vg-volume"
wait_marker reaped

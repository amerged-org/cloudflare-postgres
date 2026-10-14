#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Explicit isolated regular-file experiment; never touches a tenant PGDATA or raw write workload.
set -eu
exec 2>&1
umask 077
root=/tmp/pgcf-paired-io-$(cat /proc/sys/kernel/random/uuid)
mkdir "$root"
export LVM_SYSTEM_DIR="$root/lvm"
mkdir "$LVM_SYSTEM_DIR" "$root/scratch"
truncate -s 256M "$root/disk"
loop=$(losetup --find --show "$root/disk")
vg=pgcf_paired_io_$(cat /proc/sys/kernel/random/uuid | tr -d '-')
printf 'devices { use_devicesfile=0 filter=["a|^%s$|","r|.*|"] }\n' "$loop" > "$LVM_SYSTEM_DIR/lvm.conf"
cleanup(){
    status=$?
    trap - EXIT
    set -e
    if mountpoint -q "$root/scratch"; then umount "$root/scratch"; fi
    if vgs "$vg" >/dev/null 2>&1; then
        test "$(dmsetup info -c --noheadings -o open "$vg-io" | tr -d '[:space:]')" = 0
        lvremove --yes "$vg/io" >/dev/null
        vgremove --yes "$vg" >/dev/null
    fi
    pvremove --yes "$loop" >/dev/null
    losetup --detach "$loop"
    test ! -e "/dev/mapper/$vg-io"
    rm "$root/disk" "$LVM_SYSTEM_DIR/lvm.conf"
    rm -rf "$LVM_SYSTEM_DIR/cache" "$LVM_SYSTEM_DIR/archive" "$LVM_SYSTEM_DIR/backup"
    rmdir "$root/scratch" "$LVM_SYSTEM_DIR" "$root"
    printf '{"owned_filesystem_unmounted":true,"owned_dm_removed":true,"owned_loop_detached":true,"owned_fixture_directory_removed":true}\n'
    exit "$status"
}
trap cleanup EXIT
pvcreate --yes "$loop" >/dev/null
vgcreate "$vg" "$loop" >/dev/null
lvcreate --yes --type thin-pool --size 128M --poolmetadatasize 4M --chunksize 64K --name pool "$vg" >/dev/null
lvcreate --yes --virtualsize 64M --thinpool "$vg/pool" --name io >/dev/null
mkfs.ext4 -q -F -E lazy_itable_init=0,lazy_journal_init=0 "/dev/mapper/$vg-io"
mount -t ext4 "/dev/mapper/$vg-io" "$root/scratch"
"$1" --owned-fixture "$root/scratch/ordinary-io.bin" "/dev/mapper/$vg-io" "$(vgs --noheadings -o vg_uuid "$vg" | tr -d '[:space:]')" "$(lvs --noheadings -o lv_uuid "$vg/io" | tr -d '[:space:]')" "$(lvs --noheadings -o lv_uuid "$vg/pool" | tr -d '[:space:]')" "$(lvs --noheadings -o thin_id "$vg/io" | tr -d '[:space:]')"

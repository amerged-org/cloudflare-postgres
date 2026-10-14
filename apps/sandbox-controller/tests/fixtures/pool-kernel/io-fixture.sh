#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
set -eu
exec 2>&1
umask 077
export LVM_SYSTEM_DIR=/tmp/pgcf-a8-io
mkdir "$LVM_SYSTEM_DIR"
truncate -s 64M "$LVM_SYSTEM_DIR/disk"
loop=$(losetup --find --show "$LVM_SYSTEM_DIR/disk")
vg=pgcf_a8_$(cat /proc/sys/kernel/random/uuid | tr -d '-')
printf 'devices { use_devicesfile=0 filter=["a|^%s$|","r|.*|"] }\n' "$loop" > "$LVM_SYSTEM_DIR/lvm.conf"
cleanup(){
    set -e
    if vgs "$vg" >/dev/null 2>&1; then
        test "$(dmsetup info -c --noheadings -o open "$vg-io" | tr -d '[:space:]')" = 0
        lvremove --yes "$vg/io" >/dev/null
        vgremove --yes "$vg" >/dev/null
    fi
    pvremove --yes "$loop" >/dev/null
    losetup --detach "$loop"
    printf 'owned_io_device_normal_cleanup=true\n'
}
trap cleanup EXIT
pvcreate --yes "$loop" >/dev/null
vgcreate "$vg" "$loop" >/dev/null
lvcreate --yes --type thin-pool --size 32M --poolmetadatasize 4M --chunksize 64K --name pool "$vg" >/dev/null
lvcreate --yes --virtualsize 24M --thinpool "$vg/pool" --name io >/dev/null
"$1" --owned-fixture "/dev/mapper/$vg-io" "$(vgs --noheadings -o vg_uuid "$vg" | tr -d '[:space:]')" "$(lvs --noheadings -o lv_uuid "$vg/io" | tr -d '[:space:]')" "$(lvs --noheadings -o lv_uuid "$vg/pool" | tr -d '[:space:]')" "$(lvs --noheadings -o thin_id "$vg/io" | tr -d '[:space:]')"

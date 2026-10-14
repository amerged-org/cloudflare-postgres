# SPDX-License-Identifier: Apache-2.0
#!/bin/sh
set -eu
exec 2>&1
umask 077
export LVM_SYSTEM_DIR=/tmp/pgcf-a8
mkdir /tmp/pgcf-a8 /tmp/pgcf-a8/data /tmp/pgcf-a8/anchor
truncate -s 128M /tmp/pgcf-a8/disk
loop=$(losetup --find --show /tmp/pgcf-a8/disk)
vg=pgcf_a8_$(cat /proc/sys/kernel/random/uuid | tr -d '-')
printf 'devices { use_devicesfile=0 filter=["a|^%s$|","r|.*|"] }\n' "$loop" > /tmp/pgcf-a8/lvm.conf
printf '%s\n' "$loop" > /tmp/pgcf-a8/loop
printf '%s\n' "$vg" > /tmp/pgcf-a8/vg
cleanup() {
    set -e
    if mountpoint -q /tmp/pgcf-a8/anchor/data; then umount /tmp/pgcf-a8/anchor/data; fi
    if mountpoint -q /tmp/pgcf-a8/anchor; then umount /tmp/pgcf-a8/anchor; fi
    if lvs "$vg/volume" >/dev/null 2>&1; then
        dmsetup resume "$vg-volume"
        test "$(dmsetup info -c --noheadings -o open "$vg-volume" | tr -d '[:space:]')" = 0
        test "$(vgs --noheadings -o vg_uuid "$vg" | tr -d '[:space:]')" = "$(cat /tmp/pgcf-a8/vg_uuid)"
        lvremove --yes "$vg/volume" >/dev/null
    fi
    if vgs "$vg" >/dev/null 2>&1; then vgremove --yes "$vg" >/dev/null; fi
    pvremove --yes "$loop" >/dev/null
    losetup --detach "$loop"
    printf 'owned_fixture_normal_cleanup=true\n'
}
trap cleanup EXIT
pvcreate --yes "$loop" >/dev/null
vgcreate "$vg" "$loop" >/dev/null
vgs --noheadings -o vg_uuid "$vg" | tr -d '[:space:]' > /tmp/pgcf-a8/vg_uuid
lvcreate --yes --type thin-pool --size 32M --poolmetadatasize 4M --chunksize 64K --name pool "$vg" >/dev/null
lvcreate --yes --virtualsize 32M --thinpool "$vg/pool" --name volume >/dev/null
mkfs.ext4 -q "/dev/$vg/volume"
mount -t tmpfs -o mode=0755,uid=0,gid=0,size=2m tmpfs /tmp/pgcf-a8/anchor
mkdir -m 0755 /tmp/pgcf-a8/anchor/data
lv_uuid=$(lvs --noheadings -o lv_uuid "$vg/volume" | tr -d '[:space:]')
/fixture/pgcf-pool-kernel-fixture "/dev/mapper/$vg-volume" "$(cat /tmp/pgcf-a8/vg_uuid)" "$lv_uuid" "$(lvs --noheadings -o lv_uuid "$vg/pool" | tr -d '[:space:]')" "$(lvs --noheadings -o thin_id "$vg/volume" | tr -d '[:space:]')"
test "$(dmsetup info -c --noheadings -o open "$vg-volume" | tr -d '[:space:]')" = 0
printf 'production_final_global_dm_open_count=0\n'
dmsetup suspend --noflush --nolockfs "$vg-volume"
/fixture/pgcf-pool-kernel-fixture --zero-suspended "$(cat /tmp/pgcf-a8/vg_uuid)" "$lv_uuid" "$(lvs --noheadings -o lv_uuid "$vg/pool" | tr -d '[:space:]')" "$(lvs --noheadings -o thin_id "$vg/volume" | tr -d '[:space:]')"

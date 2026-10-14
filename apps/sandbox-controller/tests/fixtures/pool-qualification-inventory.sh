#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Owned local LVM metadata lifecycle proof, not a Dev qualification receipt.
set -eu
umask 077
scope=$(cat /proc/sys/kernel/random/uuid | tr -d '-')
dir=/tmp/pgcf-node-physical-$scope
vg=pgcf_node_physical_$scope
mkdir -m 0700 "$dir"
export LVM_SYSTEM_DIR=$dir
truncate -s 128M "$dir/disk"
loop=$(losetup --find --show "$dir/disk")
printf 'devices { use_devicesfile=0 filter=["a|^%s$|","r|.*|"] }\n' "$loop" > "$dir/lvm.conf"
vg_uuid=
cleanup() {
  if test -n "$vg_uuid" && vgs "$vg" >/dev/null 2>&1; then
    test "$(vgs --readonly --noheadings -o vg_uuid "$vg" | tr -d '[:space:]')" = "$vg_uuid"
    vgremove --yes "$vg" >/dev/null
  fi
  pvremove --yes "$loop" >/dev/null 2>&1 || true
  losetup --detach "$loop"
  rm -rf "$dir"
}
trap cleanup EXIT
pvcreate --yes "$loop" >/dev/null
vgcreate "$vg" "$loop" >/dev/null
vg_uuid=$(vgs --readonly --noheadings -o vg_uuid "$vg" | tr -d '[:space:]')
lvcreate --yes --type thin-pool --size 32M --poolmetadatasize 4M --chunksize 64K --name pool "$vg" >/dev/null
lvcreate --yes --virtualsize 32M --thinpool "$vg/pool" --name volume >/dev/null
source_uuid=$(lvs --readonly --noheadings -o lv_uuid "$vg/volume" | tr -d '[:space:]')
pool_uuid=$(lvs --readonly --noheadings -o lv_uuid "$vg/pool" | tr -d '[:space:]')
read_and_check() {
  /sbin/lvm lvs --readonly --nohints --reportformat json --all --options vg_uuid,lv_uuid,lv_name,lv_attr,origin_uuid,pool_lv_uuid --select "vg_uuid=$vg_uuid" > "$dir/inventory.json"
  /proof/pool_qualification_inventory "$dir/inventory.json" "$vg_uuid" "$source_uuid" "$pool_uuid" volume snapshot-attempt "$1"
}
read_and_check 0
lvcreate --yes --type thin --snapshot --permission r --name attempt "$vg/volume" >/dev/null
read_and_check 1
lvremove --yes "$vg/attempt" >/dev/null
read_and_check 0
printf 'owned_inventory_proof_completed=true\n'

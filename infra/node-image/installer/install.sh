#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# PGCF pull installer: runs once in the Contabo rescue system, started by cloud-config.yaml.
# It checks the hardware, downloads the node image into RAM, verifies it, writes the disk,
# writes the node's network settings and enrollment seed, reports every checkpoint over HTTPS
# and reboots into the image. It never opens a port and never prints a token.
#
# The rescue system (Stage 1, plan 11.1) is Debian 12 on BIOS firmware with a static network; it
# has zstd but no xz. Every tool and hardware fact is asserted before the disk is touched, so a
# wrong assumption fails loudly at a checkpoint instead of writing the disk.
set -Eeuo pipefail
umask 077

params=${1:?usage: install.sh /ABSOLUTE/PARAMS_FILE [--validate-only]}
[[ $params == /* ]] || {
	echo "the parameters file must be an absolute path" >&2
	exit 2
}
# cloud-config.yaml writes install.sh and the parameters into one directory, which is the work
# directory. cloud-init created it with its default mode and the parameters in it carry the tokens,
# so it is closed before anything is read, which also covers a refused parameter.
work=${params%/*}
validate_only=false
[ "${2-}" = --validate-only ] && validate_only=true
$validate_only || chmod 0700 "$work"
ram=$work/ram
target=$work/target

# A refused parameters file is removed, because it holds the tokens; --validate-only leaves it.
refuse() {
	echo "$1" >&2
	$validate_only || rm -f "$params"
	exit 2
}

names=" PGCF_IMAGE_URL PGCF_IMAGE_ZST_SHA256 PGCF_IMAGE_ZST_BYTES PGCF_IMAGE_RAW_SHA256 PGCF_IMAGE_RAW_BYTES PGCF_DISK_BYTES PGCF_MEMORY_MIN_KIB PGCF_MAC PGCF_IPV4 PGCF_IPV4_PREFIX PGCF_IPV4_GATEWAY PGCF_IPV6 PGCF_IPV6_PREFIX PGCF_IPV6_GATEWAY PGCF_DNS PGCF_HOSTNAME PGCF_PROGRESS_URL PGCF_PROGRESS_TOKEN PGCF_NODE_ID PGCF_REGION PGCF_API_URL PGCF_ENROLLMENT_TOKEN "
for name in $names; do unset "$name"; done
# KEY=value lines only; nothing in the file is ever executed.
while IFS= read -r line || [ -n "$line" ]; do
	[ -z "$line" ] && continue
	name=${line%%=*}
	case $names in
	*" $name "*) printf -v "$name" '%s' "${line#*=}" ;;
	*) refuse "unknown parameter" ;;
	esac
done <"$params"

need() {
	local name=$1 pattern=$2
	[[ ${!name-} =~ $pattern ]] || refuse "invalid or missing parameter $name"
}
token_length() {
	local value=${!1}
	[ "${#value}" -ge 16 ] && [ "${#value}" -le 512 ] || refuse "invalid parameter $1"
}
hex64='^[0-9a-f]{64}$'
count='^[1-9][0-9]{0,15}$'
ipv4='^([0-9]{1,3}\.){3}[0-9]{1,3}$'
token='^[A-Za-z0-9._~-]+$'
https='^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~%/?&=+-]*)?$'
need PGCF_IMAGE_URL "$https"
need PGCF_IMAGE_ZST_SHA256 "$hex64"
need PGCF_IMAGE_ZST_BYTES "$count"
need PGCF_IMAGE_RAW_SHA256 "$hex64"
need PGCF_IMAGE_RAW_BYTES "$count"
need PGCF_DISK_BYTES "$count"
need PGCF_MEMORY_MIN_KIB "$count"
need PGCF_MAC '^([0-9a-f]{2}:){5}[0-9a-f]{2}$'
need PGCF_IPV4 "$ipv4"
need PGCF_IPV4_PREFIX '^([1-9]|[12][0-9]|3[0-2])$'
need PGCF_IPV4_GATEWAY "$ipv4"
need PGCF_IPV6 '^[0-9a-f:]{2,39}$|^$'
need PGCF_IPV6_PREFIX '^([1-9][0-9]?|1[01][0-9]|12[0-8])$|^$'
need PGCF_IPV6_GATEWAY '^[0-9a-f:]{2,39}$|^$'
need PGCF_DNS '^[0-9a-f.:]+( [0-9a-f.:]+){0,2}$'
need PGCF_HOSTNAME '^[a-z][a-z0-9-]{0,62}$'
need PGCF_PROGRESS_URL "$https"
need PGCF_PROGRESS_TOKEN "$token"
token_length PGCF_PROGRESS_TOKEN
# The seed's identifiers are the contract's (NodeEnrollmentSeed): the agent refuses any other shape.
need PGCF_NODE_ID '^nod_[a-z0-9]{20}$'
need PGCF_REGION '^[a-z][a-z0-9-]{1,30}[a-z0-9]$'
need PGCF_API_URL "$https"
need PGCF_ENROLLMENT_TOKEN '^pgcf_et_[A-Za-z0-9_-]{43}$'
token_length PGCF_ENROLLMENT_TOKEN
if [ -n "${PGCF_IPV6}" ] && { [ -z "${PGCF_IPV6_PREFIX}" ] || [ -z "${PGCF_IPV6_GATEWAY}" ]; }; then
	refuse "IPv6 needs an address, a prefix and a gateway"
fi
if $validate_only; then exit 0; fi

# The progress token travels in a header file, never on a command line.
printf 'Authorization: Bearer %s\n' "${PGCF_PROGRESS_TOKEN}" >"$work/progress.header"

step=start
report() {
	local checkpoint=$1 detail=${2-}
	curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-time 30 --retry 3 \
		--header @"$work/progress.header" --header 'Content-Type: application/json' \
		--data "{\"checkpoint\":\"$checkpoint\",\"detail\":\"$detail\"}" \
		"${PGCF_PROGRESS_URL}" >/dev/null
}
failed() {
	trap - ERR
	echo "pgcf install failed at $step" >&2
	report failed "$step" || true
	rm -f "$work/progress.header" "$params"
	exit 1
}
trap failed ERR

step=tools
for tool in awk blkid blockdev curl dd ip lsblk mount mountpoint passwd sgdisk sha256sum stat udevadm umount zstd; do
	command -v "$tool" >/dev/null
done

# Contabo's merged rescue configuration sets a root password and turns SSH password login on;
# cloud-config.yaml turns password login off, and the password is locked here.
step=lockdown
passwd --lock root >/dev/null
# The API refuses the progress token once `rebooting` or `failed` arrived, so a second run (for
# example after a reboot back into rescue) stops here, before the disk.
step=started
report started

step=hardware
memory_kib=$(awk '$1 == "MemTotal:" { print $2 }' /proc/meminfo)
[ "$memory_kib" -ge "${PGCF_MEMORY_MIN_KIB}" ]
interface=$(ip -o link | awk -v mac="${PGCF_MAC}" 'tolower($0) ~ "link/ether " mac " " { sub(":$", "", $2); print $2 }')
[ -n "$interface" ] && [ "$(wc -w <<<"$interface")" -eq 1 ]
addresses=$(ip -4 -o address show dev "$interface")
[[ $addresses == *" ${PGCF_IPV4}/"* ]]
routes=$(ip -4 route show default)
[[ $routes == *"via ${PGCF_IPV4_GATEWAY} "* ]]
# Exactly one writable, non-removable whole disk, of exactly the expected size.
disks=$(lsblk --nodeps --noheadings --bytes --paths --output NAME,TYPE,RO,RM,SIZE |
	awk '$2 == "disk" && $3 == 0 && $4 == 0 { print $1, $5 }')
[ -n "$disks" ] && [ "$(wc -l <<<"$disks")" -eq 1 ]
disk=${disks%% *}
[ "${disks##* }" = "${PGCF_DISK_BYTES}" ]
[ "${PGCF_IMAGE_RAW_BYTES}" -lt "${PGCF_DISK_BYTES}" ]
report hardware_ok

step=download
mkdir -p "$ram"
mountpoint -q "$ram" || mount -t tmpfs -o "mode=0700,size=$((${PGCF_IMAGE_ZST_BYTES} + ${PGCF_IMAGE_RAW_BYTES} + 67108864))" tmpfs "$ram"
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
	--retry 3 --connect-timeout 30 --max-time 1800 --output "$ram/image.raw.zst" "${PGCF_IMAGE_URL}"
[ "$(stat -c %s "$ram/image.raw.zst")" = "${PGCF_IMAGE_ZST_BYTES}" ]
[ "$(sha256sum <"$ram/image.raw.zst" | awk '{ print $1 }')" = "${PGCF_IMAGE_ZST_SHA256}" ]
zstd --quiet --decompress --stdout "$ram/image.raw.zst" >"$ram/image.raw"
rm -f "$ram/image.raw.zst"
[ "$(stat -c %s "$ram/image.raw")" = "${PGCF_IMAGE_RAW_BYTES}" ]
[ "$(sha256sum <"$ram/image.raw" | awk '{ print $1 }')" = "${PGCF_IMAGE_RAW_SHA256}" ]
report image_verified

# Nothing touches the disk before here.
step=write
# A reinstalled node's disk carries the agent's volume group, which the rescue system may have
# activated. Nothing may sit on the disk or be mounted from it while it is written.
if command -v vgchange >/dev/null; then vgchange --activate n >/dev/null; fi
in_use=$(lsblk --noheadings --paths --list --output NAME,TYPE,MOUNTPOINT "$disk" |
	awk '($2 != "disk" && $2 != "part") || $3 != "" { print $1 }')
if [ -n "$in_use" ]; then
	echo "in use: $in_use" >&2
	false
fi
dd if="$ram/image.raw" of="$disk" bs=4M oflag=direct conv=fsync status=none
blockdev --flushbufs "$disk"
written=$(dd if="$disk" iflag=direct,count_bytes bs=4M count="${PGCF_IMAGE_RAW_BYTES}" status=none | sha256sum | awk '{ print $1 }')
[ "$written" = "${PGCF_IMAGE_RAW_SHA256}" ]
rm -f "$ram/image.raw"
# The image ends at its own size; move the backup GPT to the end of the real disk.
sgdisk --move-second-header "$disk" >/dev/null
sgdisk --verify "$disk" >/dev/null
# udev probes the disk after every write; re-read the partition table once it has finished.
udevadm settle
blockdev --rereadpt "$disk"
udevadm settle
report disk_written

step=configure
root=""
for _ in $(seq 1 20); do
	root=$(blkid --output device --match-token PARTLABEL=pgcf-root "$disk"* 2>/dev/null | head -n 1 || true)
	[ -n "$root" ] && break
	sleep 0.5
done
[ -n "$root" ]
mkdir -p "$target"
mount -t ext4 "$root" "$target"
mkdir -p "$target/etc/systemd/network"
{
	echo '# Written by the PGCF installer.'
	echo '[Match]'
	echo "MACAddress=${PGCF_MAC}"
	echo
	echo '[Network]'
	echo "Address=${PGCF_IPV4}/${PGCF_IPV4_PREFIX}"
	if [ -n "${PGCF_IPV6}" ]; then
		echo "Address=${PGCF_IPV6}/${PGCF_IPV6_PREFIX}"
	fi
	echo 'IPv6AcceptRA=no'
	echo 'LinkLocalAddressing=ipv6'
	echo
	echo '[Route]'
	echo "Gateway=${PGCF_IPV4_GATEWAY}"
	echo 'GatewayOnLink=yes'
	if [ -n "${PGCF_IPV6}" ]; then
		echo
		echo '[Route]'
		echo "Gateway=${PGCF_IPV6_GATEWAY}"
		echo 'GatewayOnLink=yes'
	fi
} >"$target/etc/systemd/network/10-pgcf.network"
chmod 0644 "$target/etc/systemd/network/10-pgcf.network"
for server in ${PGCF_DNS}; do echo "nameserver $server"; done >"$target/etc/resolv.conf"
chmod 0644 "$target/etc/resolv.conf"
echo "${PGCF_HOSTNAME}" >"$target/etc/hostname"
chmod 0644 "$target/etc/hostname"
install -d -m 0700 "$target/var/lib/pgcf/enrollment"
printf '{"node_id":"%s","region":"%s","api_url":"%s","enrollment_token":"%s"}\n' \
	"${PGCF_NODE_ID}" "${PGCF_REGION}" "${PGCF_API_URL}" "${PGCF_ENROLLMENT_TOKEN}" \
	>"$target/var/lib/pgcf/enrollment/seed.json"
chmod 0600 "$target/var/lib/pgcf/enrollment/seed.json"
sync
umount "$target"
report configured

step=reboot
report rebooting
rm -f "$work/progress.header" "$params"
sync
reboot

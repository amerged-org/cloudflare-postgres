#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# PGCF pull installer: runs once in the Contabo rescue system, started by cloud-config.yaml.
# It checks the hardware, downloads the node image into RAM, verifies it, writes the disk,
# writes the node's network settings and enrollment seed, reports every checkpoint over HTTPS
# and reboots into the image. It never opens a port and never prints a token.
#
# PENDING STAGE 1 (plan 10, Stage 1 block 3; plan 9.2): whether the rescue system's cloud-init
# runs write_files and runcmd, which tools it carries (bash, curl, xz, sgdisk, GNU dd, blkid,
# lsblk), how its network is configured, how the disk appears and whether a reboot leaves rescue
# mode are not yet recorded. Every one of these is asserted below, so a wrong assumption fails
# loudly at the first checkpoint instead of writing the disk.
set -Eeuo pipefail
umask 077

params=${1:?usage: install.sh PARAMS_FILE [--validate-only]}
work=/run/pgcf-install
ram=$work/ram
target=$work/target

names=" PGCF_IMAGE_URL PGCF_IMAGE_XZ_SHA256 PGCF_IMAGE_XZ_BYTES PGCF_IMAGE_RAW_SHA256 PGCF_IMAGE_RAW_BYTES PGCF_DISK_BYTES PGCF_MEMORY_MIN_KIB PGCF_MAC PGCF_IPV4 PGCF_IPV4_PREFIX PGCF_IPV4_GATEWAY PGCF_IPV6 PGCF_IPV6_PREFIX PGCF_IPV6_GATEWAY PGCF_DNS PGCF_HOSTNAME PGCF_PROGRESS_URL PGCF_PROGRESS_TOKEN PGCF_NODE_ID PGCF_REGION PGCF_API_URL PGCF_ENROLLMENT_TOKEN "
for name in $names; do unset "$name"; done
# KEY=value lines only; nothing in the file is ever executed.
while IFS= read -r line || [ -n "$line" ]; do
	[ -z "$line" ] && continue
	name=${line%%=*}
	case $names in
	*" $name "*) printf -v "$name" '%s' "${line#*=}" ;;
	*)
		echo "unknown parameter" >&2
		exit 2
		;;
	esac
done <"$params"

need() {
	local name=$1 pattern=$2
	[[ ${!name-} =~ $pattern ]] || {
		echo "invalid or missing parameter $name" >&2
		exit 2
	}
}
token_length() {
	local value=${!1}
	[ "${#value}" -ge 16 ] && [ "${#value}" -le 512 ] || {
		echo "invalid parameter $1" >&2
		exit 2
	}
}
hex64='^[0-9a-f]{64}$'
count='^[1-9][0-9]{0,15}$'
ipv4='^([0-9]{1,3}\.){3}[0-9]{1,3}$'
token='^[A-Za-z0-9._~-]+$'
https='^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~%/?&=+-]*)?$'
need PGCF_IMAGE_URL "$https"
need PGCF_IMAGE_XZ_SHA256 "$hex64"
need PGCF_IMAGE_XZ_BYTES "$count"
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
need PGCF_NODE_ID '^[A-Za-z0-9-]{1,64}$'
need PGCF_REGION '^[a-z][a-z0-9-]{0,31}$'
need PGCF_API_URL "$https"
need PGCF_ENROLLMENT_TOKEN "$token"
token_length PGCF_ENROLLMENT_TOKEN
if [ -n "${PGCF_IPV6}" ] && { [ -z "${PGCF_IPV6_PREFIX}" ] || [ -z "${PGCF_IPV6_GATEWAY}" ]; }; then
	echo "IPv6 needs an address, a prefix and a gateway" >&2
	exit 2
fi
[ "${2-}" = --validate-only ] && exit 0

mkdir -p -m 0700 "$work"
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
	exit 1
}
trap failed ERR

step=tools
for tool in awk blkid blockdev curl dd ip lsblk mount mountpoint sgdisk sha256sum stat umount xz; do
	command -v "$tool" >/dev/null
done
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
mountpoint -q "$ram" || mount -t tmpfs -o "mode=0700,size=$((${PGCF_IMAGE_XZ_BYTES} + ${PGCF_IMAGE_RAW_BYTES} + 67108864))" tmpfs "$ram"
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
	--retry 3 --connect-timeout 30 --max-time 1800 --output "$ram/image.raw.xz" "${PGCF_IMAGE_URL}"
[ "$(stat -c %s "$ram/image.raw.xz")" = "${PGCF_IMAGE_XZ_BYTES}" ]
[ "$(sha256sum <"$ram/image.raw.xz" | awk '{ print $1 }')" = "${PGCF_IMAGE_XZ_SHA256}" ]
xz --decompress --stdout "$ram/image.raw.xz" >"$ram/image.raw"
rm -f "$ram/image.raw.xz"
[ "$(stat -c %s "$ram/image.raw")" = "${PGCF_IMAGE_RAW_BYTES}" ]
[ "$(sha256sum <"$ram/image.raw" | awk '{ print $1 }')" = "${PGCF_IMAGE_RAW_SHA256}" ]
report image_verified

# Nothing touches the disk before here.
step=write
for part in $(lsblk --noheadings --paths --list --output NAME "$disk"); do
	if grep -q "^$part " /proc/mounts; then
		echo "$part is in use" >&2
		false
	fi
done
dd if="$ram/image.raw" of="$disk" bs=4M oflag=direct conv=fsync status=none
blockdev --flushbufs "$disk"
written=$(dd if="$disk" iflag=direct,count_bytes bs=4M count="${PGCF_IMAGE_RAW_BYTES}" status=none | sha256sum | awk '{ print $1 }')
[ "$written" = "${PGCF_IMAGE_RAW_SHA256}" ]
rm -f "$ram/image.raw"
# The image ends at its own size; move the backup GPT to the end of the real disk.
sgdisk --move-second-header "$disk" >/dev/null
sgdisk --verify "$disk" >/dev/null
blockdev --rereadpt "$disk"
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

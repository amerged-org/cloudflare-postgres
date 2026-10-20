#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Boot test, guest side. boot-test.ts injects this script and a oneshot unit that runs it through
# SMBIOS credentials, so the image itself carries no test hook. It runs once per boot: the first
# boot checks first-boot partitioning, the pool and a scratch database, then reboots; the second
# boot checks that the same scratch database wakes again, then powers off. Results go to the
# second serial port, one line per check.
set -uo pipefail
exec >/dev/ttyS1 2>&1

state=/var/lib/pgcf-boot-test
mkdir -p "$state"
phase=1
[ -e "$state/first-boot-done" ] && phase=2
failures=0

check() {
	local name=$1
	shift
	if "$@"; then
		echo "PGCF-BOOT-TEST check $phase ok $name"
	else
		echo "PGCF-BOOT-TEST check $phase fail $name"
		failures=$((failures + 1))
	fi
}

wait_for() {
	local seconds=$1
	shift
	for _ in $(seq 1 "$seconds"); do
		"$@" && return 0
		sleep 1
	done
	"$@"
}

no_failed_units() {
	systemctl is-system-running --wait >/dev/null
	local failed
	failed=$(systemctl list-units --state=failed --no-legend --plain | awk '{ print $1 }' | grep -v '^pgcf-boot-test\.service$')
	[ -z "$failed" ] || {
		echo "failed units: $failed"
		false
	}
}

# Plan 9.1: nothing listens except on loopback.
loopback_only() {
	local outside
	outside=$(ss --listening --numeric --tcp --udp --no-header | awk '{ print $5 }' |
		grep -vE '^(127\.[0-9.]+|\[::1\]|\[::ffff:127\.[0-9.]+\]|\*%lo|[^ ]*%lo):[0-9*]+$')
	[ -z "$outside" ] || {
		echo "listening outside loopback: $outside"
		false
	}
}

# Plan 8: with sshd installed, systemd 257's ssh generator binds it to /run/ssh-unix-local/socket
# (mode 0666, so a database's user could reach it) and to vsock. The image masks the generator and
# the kernel command line turns it off, so no ssh socket exists. The journal socket proves that the
# listings worked.
no_ssh_socket() {
	local sockets units pattern='ssh-unix-local|sshd-unix-local|sshd-vsock'
	sockets=$(ss --listening --unix --numeric --no-header) || return 1
	units=$(systemctl list-sockets --all --no-legend --plain) || return 1
	grep -q 'systemd-journald\.socket' <<<"$units" || {
		echo "no socket listing"
		return 1
	}
	if grep -E "$pattern" <<<"$sockets" || grep -E "$pattern" <<<"$units"; then
		false
	fi
}

# Plan 8: the operator shell is certificate-only. sshd -t accepts the drop-in and sshd -T reports
# its effective values; per-source penalties stay at their default.
sshd_policy() {
	sshd -t || return 1
	local effective line
	effective=$(sshd -T) || return 1
	for line in \
		'listenaddress 127.0.0.1:22' 'listenaddress [::1]:22' \
		'passwordauthentication no' 'kbdinteractiveauthentication no' \
		'authenticationmethods publickey' 'pubkeyauthentication yes' 'authorizedkeysfile none' \
		'trustedusercakeys /etc/ssh/pgcf_user_ca.pub' 'authorizedprincipalsfile /etc/ssh/principals/%u' \
		'revokedkeys /etc/ssh/pgcf_revoked.krl' 'permitrootlogin without-password' 'allowusers root' \
		'maxauthtries 2' 'logingracetime 20' 'maxsessions 2' \
		'x11forwarding no' 'allowtcpforwarding no' 'allowagentforwarding no' 'permittunnel no' \
		'disableforwarding yes' 'gssapiauthentication no' \
		'clientaliveinterval 30' 'clientalivecountmax 4' 'loglevel VERBOSE'; do
		grep -qxF "$line" <<<"$effective" || {
			echo "sshd -T lacks: $line"
			return 1
		}
	done
	grep -q '^persourcepenalties .*authfail:' <<<"$effective" || {
		echo "per-source penalties are off"
		return 1
	}
}

# One publickey attempt as root with the key in $1 (and the certificate next to it) at address $2.
ssh_attempt() {
	ssh -n -o BatchMode=yes -o IdentitiesOnly=yes -o PreferredAuthentications=publickey \
		-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=10 \
		-i "$1" "root@$2" true 2>&1
}

# sshd's authentication must refuse (MaxAuthTries 2 ends a key with its certificate in "Too many
# authentication failures"), not a connection that never reached it.
ssh_refused() {
	local output
	if output=$(ssh_attempt "$@"); then
		echo "login accepted at $2"
		return 1
	fi
	grep -qE 'Permission denied \(publickey\)|Too many authentication failures' <<<"$output" || {
		echo "$2: $output"
		return 1
	}
}

# The image ships no CA key, so no login is possible: a certificate from a throwaway CA is refused
# on both loopback addresses. With that CA installed it is accepted (this proves the shipped
# principals file, key revocation list and their modes), and refused again once the CA is gone.
sshd_certificate_only() {
	local ca=/etc/ssh/pgcf_user_ca.pub dir output result=0
	[ ! -e "$ca" ] || {
		echo "the image carries a CA key"
		return 1
	}
	dir=$(mktemp -d) || return 1
	if ssh-keygen -q -t ed25519 -N '' -f "$dir/user" &&
		ssh-keygen -q -t ed25519 -N '' -f "$dir/ca" &&
		ssh-keygen -q -s "$dir/ca" -I pgcf-boot-test -n pgcf-break-glass -V -1m:+10m "$dir/user.pub"; then
		ssh_refused "$dir/user" 127.0.0.1 && ssh_refused "$dir/user" ::1 || result=1
		if [ "$result" = 0 ]; then
			cp "$dir/ca.pub" "$ca"
			output=$(ssh_attempt "$dir/user" 127.0.0.1) || {
				echo "refused with the CA installed: $output"
				result=1
			}
			rm -f "$ca"
			ssh_refused "$dir/user" 127.0.0.1 || result=1
		fi
	else
		result=1
	fi
	rm -rf "$dir"
	[ "$result" = 0 ]
}

# journald syncs every five minutes by default, and a freeze loses what it had not written (after
# the unexplained stall of 2026-10-18 in plan 11.1 the journal could not be read over the link).
# The image syncs every 15 s.
journal_sync_interval() {
	systemd-analyze cat-config systemd/journald.conf | grep -qx 'SyncIntervalSec=15s'
}

inbound_dropped() {
	nft list chain inet pgcf input | grep -q 'policy drop;'
}

root_grown() {
	local partition filesystem
	partition=$(lsblk --bytes --nodeps --noheadings --output SIZE /dev/disk/by-partlabel/pgcf-root)
	filesystem=$(df --block-size=1 --output=size / | tail -n 1)
	[ "$partition" -eq $((8 * 1024 * 1024 * 1024)) ] && [ "$filesystem" -gt $((7 * 1024 * 1024 * 1024)) ]
}

lvm_partition() {
	local type size
	type=$(lsblk --nodeps --noheadings --output PARTTYPE /dev/disk/by-partlabel/pgcf-lvm)
	size=$(lsblk --bytes --nodeps --noheadings --output SIZE /dev/disk/by-partlabel/pgcf-lvm)
	[ "$type" = e6d6d379-f507-44c2-a23c-238f2a3df928 ] && [ "$size" -gt $((30 * 1024 * 1024 * 1024)) ]
}

# Plan 4.3 and Appendix C: VG pgcf on the LVM partition, one zeroing, fail-at-once thin pool
# with 64 KiB chunks.
pool() {
	local pv attributes
	pv=$(pvs --noheadings --options pv_name,vg_name 2>/dev/null | awk '$2 == "pgcf" { print $1 }')
	[ "$(readlink -f "$pv")" = "$(readlink -f /dev/disk/by-partlabel/pgcf-lvm)" ] || return 1
	attributes=$(lvs --noheadings --separator '|' --units k \
		--options segtype,chunk_size,zero,lv_when_full pgcf/pgcf_thinpool 2>/dev/null | tr -d ' ')
	[ "$attributes" = "thin-pool|64.00k|zero|error" ] || {
		echo "pool attributes: $attributes"
		false
	}
}

# The agent runs in a mount namespace of its own (pgcf-agent.service has PrivateMounts=yes): every
# volume is mounted there and in the namespace of the unit that runs on it, and in no other. A
# command that works on a volume from a shell goes through the agent's namespace; so does the check,
# which the agent itself runs from its own namespace after an update.
agent_pid() {
	systemctl show --property=MainPID --value pgcf-agent.service
}
in_agent_namespace() {
	local pid
	pid=$(agent_pid)
	[ "${pid:-0}" -gt 0 ] || {
		echo "the agent does not run"
		return 1
	}
	nsenter --target "$pid" --mount -- "$@"
}

scratch_volumes() {
	lvs --noheadings --options lv_uuid,lv_tags pgcf 2>/dev/null | awk '$2 ~ /(^|,)pgcf\.db\./ { print $1 }'
}

# Plan 9.1: `pgcf-agent check` creates a scratch database on a thin volume and queries it; after a
# reboot the same database wakes again (no second volume appears).
scratch_database() {
	in_agent_namespace /var/lib/pgcf/bin/current/pgcf-agent check || return 1
	local volumes
	volumes=$(scratch_volumes)
	if [ "$(wc -w <<<"$volumes")" -ne 1 ]; then
		echo "scratch volumes: $volumes"
		return 1
	fi
	if [ "$phase" = 1 ]; then
		echo "$volumes" >"$state/scratch-volume"
	else
		[ "$volumes" = "$(cat "$state/scratch-volume")" ]
	fi
}

# PID 1's namespace is what every unit's executor copies and re-reads again and again, so a start
# grows with the volumes mounted in it: none is, and the agent's namespace has the scratch volume.
no_volume_in_pid_1_namespace() {
	if grep -q ' /var/lib/pgcf/db/' /proc/1/mountinfo; then
		echo "a volume is mounted in PID 1's namespace"
		return 1
	fi
	grep -q ' /var/lib/pgcf/db/' "/proc/$(agent_pid)/mountinfo" || {
		echo "the agent's namespace has no volume"
		return 1
	}
}

# Every filesystem ends 4 MiB (one extent) before its volume, so that nothing a database writes forms
# a RAID or ZFS signature where libblkid looks at the end of the device (the farthest is 1,580,544
# bytes from it), which systemd's image dissection would refuse to mount.
scratch_filesystem_gap() {
	local id volume bytes filesystem
	id=$(scratch_id)
	volume="pgcf/db_${id}_g1"
	bytes=$(lvs --noheadings --nosuffix --units b --options lv_size "$volume" | tr -d ' ')
	filesystem=$(dumpe2fs -h "/dev/mapper/pgcf-db_${id}_g1" 2>/dev/null |
		awk -F: '/^Block count:/ { count = $2 + 0 } /^Block size:/ { size = $2 + 0 } END { print count * size }')
	[ -n "$bytes" ] && [ "$filesystem" -gt 0 ] && [ $((filesystem + 4194304)) -le "$bytes" ] || {
		echo "filesystem $filesystem of a volume of $bytes"
		return 1
	}
}

scratch_id() {
	lvs --noheadings --options lv_tags pgcf 2>/dev/null | tr ',' '\n' | sed -n 's/^ *pgcf\.db\.//p'
}

# The agent creates /run/pgcf/<id> when it creates the database and at its own start, because /run
# is empty after a boot.
socket_directory() {
	local id owner
	id=$(scratch_id)
	if [ "$(wc -w <<<"$id")" -ne 1 ]; then
		echo "scratch ids: $id"
		return 1
	fi
	owner=$(stat -c '%U:%G:%a' "/run/pgcf/$id") || return 1
	[ "$owner" = "pgcf-$id:pgcf-gateway:750" ] || {
		echo "socket directory: $owner"
		false
	}
}

binaries() {
	local binary
	for binary in pgcf-agent pgcf-native-gateway pgcf-archive pgcf-wal-fetch; do
		[ -x "/var/lib/pgcf/bin/current/$binary" ] || {
			echo "missing $binary"
			return 1
		}
	done
}

database_unit_sandbox() {
	systemd-analyze security --no-pager pgcf-pg@pgcfboottest0000000.service | tail -n 1 | grep -q 'SAFE'
}

# PostgreSQL reports ready only after crash recovery or a restore's replay, which Stage 1 measured
# above systemd's default 90 s start timeout; the agent owns the deadline.
database_unit_waits_for_recovery() {
	[ "$(systemctl show --property=TimeoutStartUSec --value pgcf-pg@pgcfboottest0000000.service)" = infinity ]
}

# The unit starts the postmaster alone: an ExecStartPre= process costs about 35 ms on every wake,
# so the agent creates the socket directory instead (socket_directory).
database_unit_has_no_start_pre() {
	[ -z "$(systemctl show --property=ExecStartPre --value pgcf-pg@pgcfboottest0000000.service)" ]
}

# Plan 8: the filter is an allow-list (@system-service) with the deny lines subtracted, and systemd
# reports what is left. A database's user must not reach io_uring, userfaultfd, the kernel keyring,
# the message queues or the SysV semaphores; PostgreSQL's shared memory calls must stay.
database_unit_syscall_filter() {
	local allowed name
	allowed=$(systemctl show --property=SystemCallFilter --value pgcf-pg@pgcfboottest0000000.service | tr ' ' '\n')
	for name in shmget shmat shmdt shmctl; do
		grep -qx "$name" <<<"$allowed" || {
			echo "denied $name"
			return 1
		}
	done
	for name in io_uring_setup io_uring_enter io_uring_register userfaultfd add_key keyctl request_key \
		msgget msgsnd msgrcv msgctl semget semop semtimedop semctl \
		mq_open mq_unlink mq_timedsend mq_timedreceive mq_notify mq_getsetattr; do
		if grep -qx "$name" <<<"$allowed"; then
			echo "allowed $name"
			return 1
		fi
	done
}

sysctl_is() {
	local value
	value=$(sysctl -n "$1") || return 1
	[ "$value" = "$2" ] || {
		echo "$1 = $value"
		false
	}
}

# The agent creates /var/lib/pgcf/db 0711 (store.rs) and tmpfiles resets it at every boot: a
# database's user reaches its own directory but nobody can list this one (the IDs stay visible in
# /etc/passwd, /run/pgcf and the mount table).
database_directory_not_listable() {
	local mode
	mode=$(stat -c %a /var/lib/pgcf/db) || return 1
	[ "$mode" = 711 ] || {
		echo "mode $mode"
		false
	}
}

# systemd nests a slice whose name has a dash inside the slice before the dash. A backup job must
# not run under the databases' slice and its memory ceiling. A slice name without a unit file in
# the image is not refused: systemd creates the slice on the spot, with no limits. The agent's name
# for the slice (apps/node-agent/src/archive/job.rs) is held to the image's unit by that crate's
# tests; the limit read here holds this name to the unit as well.
backup_slice_top_level() {
	local cgroup memory
	cgroup=$(systemd-run --quiet --pipe --wait --collect --slice=pgcfbackup.slice cat /proc/self/cgroup) || return 1
	case $cgroup in
	0::/pgcfbackup.slice/*) ;;
	*)
		echo "backup job cgroup: $cgroup"
		false
		;;
	esac
	memory=$(systemctl show --property=MemoryMax --value pgcfbackup.slice) || return 1
	[ "$memory" = 536870912 ] || {
		echo "pgcfbackup.slice MemoryMax = $memory"
		false
	}
}

# MountImages= puts the devices that image dissection touches on the unit's device policy; the unit's
# private /dev and its empty capability set are what keep a database's user from using them.
database_unit_device_allow() {
	local expected actual
	expected=$(printf '%s\n' '/dev/loop-control rw' '/dev/mapper/control rw' 'block-blkext rwm' \
		'block-device-mapper rwm' 'block-loop rwm' 'char-rtc r')
	actual=$(systemctl show --property=DeviceAllow --value pgcf-pg@pgcfboottest0000000.service | grep -v '^$' | LC_ALL=C sort)
	[ "$actual" = "$expected" ] || {
		echo "DeviceAllow: $actual"
		return 1
	}
	[ "$(systemctl show --property=DevicePolicy --value pgcf-pg@pgcfboottest0000000.service)" = closed ] &&
		[ "$(systemctl show --property=PrivateDevices --value pgcf-pg@pgcfboottest0000000.service)" = yes ] &&
		[ -z "$(systemctl show --property=CapabilityBoundingSet --value pgcf-pg@pgcfboottest0000000.service | tr -d ' ')" ] ||
		{
			echo "the policy is not closed, the /dev not private or a capability is left"
			return 1
		}
}

# A start without the agent's link /run/pgcf/dev/<id> fails its assertion: nothing runs on an empty
# mount point. The unit has the link only while the agent has the volume attached.
database_unit_needs_the_link() {
	local unit=pgcf-pg@pgcfboottest0000000.service
	[ ! -e /run/pgcf/dev/pgcfboottest0000000 ] || {
		echo "the test instance has a link"
		return 1
	}
	if systemctl start "$unit" 2>/dev/null; then
		systemctl stop "$unit"
		echo "the unit started without a link"
		return 1
	fi
	[ "$(systemctl show --property=ActiveState --value "$unit")" = inactive ] &&
		[ "$(systemctl show --property=AssertResult --value "$unit")" = no ]
}

# The mount units of the volumes are gone, and with them the ordering of a stop before an unmount: a
# database that is awake when the node reboots must stop cleanly and be found clean afterwards. This
# starts the scratch database from the agent's link and leaves it running; the agent restarts under
# it, which drops its links and ends its namespace, and the database runs on.
scratch_database_runs_across_an_agent_restart() {
	local unit=pgcf-pg@pgcfcheckscratch0000.service before after
	[ -L /run/pgcf/dev/pgcfcheckscratch0000 ] || {
		echo "the checked volume has no link"
		return 1
	}
	systemctl start "$unit" || return 1
	before=$(systemctl show --property=MainPID --property=InvocationID "$unit")
	systemctl restart pgcf-agent.service || return 1
	after=$(systemctl show --property=MainPID --property=InvocationID "$unit")
	[ "$(systemctl is-active "$unit")" = active ] && [ "$before" = "$after" ] || {
		echo "the database did not run on: $before / $after"
		return 1
	}
	# The new agent has no namespace to name: its start dropped every link.
	[ ! -e /run/pgcf/dev/pgcfcheckscratch0000 ] || {
		echo "a link survived the agent's start"
		return 1
	}
}

# MountImages= opens the unit's device policy to block devices (DeviceAllow), and the policy is all
# a database's user would have against the raw volumes of the others if the unit's /dev held a node
# for one or the user could make one. Inside the running scratch database, as its user with no
# capability: the private /dev has no block device node (and does have the character ones, so the
# search sees what is there), a device node cannot be made, and neither a device-mapper node by its
# number nor the volume's own device by name can be opened.
database_user_reaches_no_block_device() {
	local unit=pgcf-pg@pgcfcheckscratch0000.service pid uid gid dm blocks characters volume own
	pid=$(systemctl show --property=MainPID --value "$unit")
	[ "${pid:-0}" -gt 0 ] || {
		echo "the scratch database does not run"
		return 1
	}
	uid=$(stat -c %u "/proc/$pid")
	gid=$(stat -c %g "/proc/$pid")
	blocks=$(nsenter --target "$pid" --mount -- find /dev -type b | wc -l)
	characters=$(nsenter --target "$pid" --mount -- find /dev -type c | wc -l)
	{ [ "$blocks" -eq 0 ] && [ "$characters" -gt 0 ]; } || {
		echo "the unit's /dev has $blocks block and $characters character nodes"
		return 1
	}
	dm=$(cat "$(ls -d /sys/block/dm-* | head -1)/dev")
	volume=/dev/mapper/pgcf-db_pgcfcheckscratch0000_g1
	own=/var/lib/pgcf/db/pgcfcheckscratch0000
	# shellcheck disable=SC2016  # the commands run in the unit's shell, with its own $1, $2 and $3
	nsenter --target "$pid" --mount -- setpriv --reuid="$uid" --regid="$gid" --clear-groups \
		--bounding-set=-all --inh-caps=-all --no-new-privs -- sh -c '
		touch "$3/probe" && rm "$3/probe" || exit 13
		mknod "$3/block-node" b "${1%:*}" "${1#*:}" 2>/dev/null && exit 10
		(: <"/dev/dm-${1#*:}") 2>/dev/null && exit 11
		(: <"$2") 2>/dev/null && exit 12
		exit 0' sh "$dm" "$volume" "$own"
	case $? in
	0) ;;
	10) echo "the user made a block device node" && return 1 ;;
	11) echo "the user opened a device-mapper node" && return 1 ;;
	12) echo "the user opened the volume's device" && return 1 ;;
	13) echo "the user cannot write its own volume: the probe proves nothing" && return 1 ;;
	*) echo "the probe in the unit failed" && return 1 ;;
	esac
}

# Plan 8: nothing a database's user can write is shared with another unit. /run/lock (a tmpfs for the
# whole node) and /dev/mqueue (the host's queues) are mode 1777 and were mounted read-write in every
# unit, so one tenant could leave there what another reads, and files outlived the unit in a tmpfs
# that LVM keeps its locks in. As the user of the running scratch database, in the mount and IPC
# namespaces of its unit and with no capability:
# - its own volume is writable (the probe works), /run/lock, /dev/mqueue and /dev/pts refuse a file
#   and a listing, it cannot allocate a pty, and what the host keeps in /tmp, /var/tmp and
#   /dev/shm is not there;
# - a SysV segment of the host is not in its IPC namespace, and the segment PostgreSQL made is there
#   and not in the host's;
# - every directory and regular file it can write is its own: its volume, its socket directory, the
#   private /tmp, /var/tmp and /dev/shm and its own cgroup's pressure files. Sockets (the journal's,
#   systemd's and D-Bus's service endpoints; each service checks its caller), the character devices
#   of the private /dev (null, zero, full, random, urandom, tty) and symbolic links hold no data.
database_user_shares_nothing_writable() {
	local id=pgcfcheckscratch0000 pid uid gid own marker place segment owners listing leftover result=0
	pid=$(systemctl show --property=MainPID --value "pgcf-pg@$id.service")
	[ "${pid:-0}" -gt 0 ] || {
		echo "the scratch database does not run"
		return 1
	}
	uid=$(stat -c %u "/proc/$pid")
	gid=$(stat -c %g "/proc/$pid")
	own=/var/lib/pgcf/db/$id
	marker=pgcf-boot-test-host-marker
	as_user() {
		nsenter --target "$pid" --mount --ipc -- setpriv --reuid="$uid" --regid="$gid" --clear-groups \
			--bounding-set=-all --inh-caps=-all --no-new-privs -- "$@"
	}
	as_user sh -c 'touch "$1/probe" && rm "$1/probe"' sh "$own" || {
		echo "the user cannot write its own volume: the probes prove nothing"
		return 1
	}
	for place in /run/lock /dev/mqueue /dev/pts; do
		if as_user sh -c 'touch "$1/probe" 2>&1 && rm "$1/probe"' sh "$place" >/dev/null; then
			echo "the user created a file in $place"
			result=1
		fi
		listing=$(as_user ls -A "$place" 2>&1)
		grep -q 'Permission denied' <<<"$listing" || {
			echo "$place is not refused: $listing"
			result=1
		}
	done
	if as_user sh -c ': <>/dev/ptmx' 2>/dev/null; then
		echo "the user allocated a pty from the host's devpts"
		result=1
	fi
	for place in /tmp /var/tmp /dev/shm; do
		touch "$place/$marker"
		if as_user test -e "$place/$marker"; then
			echo "the host's $place is visible in the unit"
			result=1
		fi
		rm -f "$place/$marker"
	done
	if [ "$(readlink "/proc/$pid/ns/ipc")" = "$(readlink /proc/1/ns/ipc)" ]; then
		echo "the unit is in PID 1's IPC namespace"
		result=1
	fi
	segment=$(ipcmk --shmem 4096 | awk '{ print $NF }')
	if [ -z "$segment" ] || nsenter --target "$pid" --ipc -- awk -v id="$segment" 'NR > 1 && $2 == id { found = 1 } END { exit !found }' /proc/sysvipc/shm; then
		echo "the host's SysV segment ${segment:-?} is visible in the unit"
		result=1
	fi
	[ -z "$segment" ] || ipcrm --shmem-id "$segment"
	owners=$(nsenter --target "$pid" --ipc -- awk 'NR > 1 { print $8 }' /proc/sysvipc/shm | sort -u)
	[ "$owners" = "$uid" ] || {
		echo "the unit's SysV segments belong to: ${owners:-nobody}"
		result=1
	}
	if awk -v uid="$uid" 'NR > 1 && $8 == uid { found = 1 } END { exit !found }' /proc/sysvipc/shm; then
		echo "the database's SysV segment is in the host's IPC namespace"
		result=1
	fi
	# /efi is an automount of the ESP (mode 0700 for root): the search must not mount it.
	leftover=$(as_user find / \( -path /proc -o -path /efi -o -path "$own" \) -prune -o \( -type d -o -type f \) -writable -print 2>/dev/null |
		grep -vE "^(/dev/shm|/tmp|/var/tmp)(/|$)|^/run/pgcf/$id(/|$)|^/sys/fs/cgroup/pgcf\.slice/pgcf-pg@$id\.service/")
	[ -z "$leftover" ] || {
		echo "writable and not the unit's own: $leftover"
		result=1
	}
	[ "$result" = 0 ]
}

# PrivateIPC= leaves the pid half of PostgreSQL's interlock (a postmaster.pid whose process is alive
# is refused with kill(pid, 0), which reaches it because the units share the PID namespace) and
# blinds the shared-memory half: a segment of another IPC namespace is not found. A second unit on
# a running database's directory is one more postmaster of the same user in an IPC namespace of its
# own, and it must be refused at once.
database_second_postmaster_is_refused() {
	local id=pgcfcheckscratch0000 pid uid gid output status
	pid=$(systemctl show --property=MainPID --value "pgcf-pg@$id.service")
	[ "${pid:-0}" -gt 0 ] || {
		echo "the scratch database does not run"
		return 1
	}
	uid=$(stat -c %u "/proc/$pid")
	gid=$(stat -c %g "/proc/$pid")
	output=$(nsenter --target "$pid" --mount -- unshare --ipc -- setpriv --reuid="$uid" --regid="$gid" --clear-groups -- \
		timeout 30 /usr/lib/postgresql/18/bin/postgres -D "/var/lib/pgcf/db/$id/data" \
		-c listen_addresses= -c "unix_socket_directories=/run/pgcf/$id" 2>&1)
	status=$?
	{ [ "$status" = 1 ] && grep -q 'lock file "postmaster.pid" already exists' <<<"$output"; } || {
		echo "a second postmaster ended with $status: $output"
		return 1
	}
	[ "$(systemctl is-active "pgcf-pg@$id.service")" = active ]
}

# After the reboot with that database awake: the unit stopped on its own, cleanly, before the node
# went down, and neither PostgreSQL nor ext4 had anything to recover at this start.
scratch_database_was_stopped_cleanly() {
	local unit=pgcf-pg@pgcfcheckscratch0000.service
	journalctl --boot=-1 --unit="$unit" --no-pager --output=cat 2>/dev/null | grep -q 'database system is shut down' || {
		echo "the previous boot has no clean shutdown of the database"
		return 1
	}
	if journalctl --boot=0 --unit="$unit" --no-pager --output=cat 2>/dev/null | grep -qE 'automatic recovery in progress|not properly shut down'; then
		echo "PostgreSQL recovered after the reboot"
		return 1
	fi
	if journalctl --boot=0 --dmesg --no-pager --output=cat 2>/dev/null | grep -qE 'EXT4-fs \(dm-[0-9]+\).*(recovery complete|orphan)'; then
		echo "ext4 replayed a journal or cleaned orphans after the reboot"
		return 1
	fi
}

check no_failed_units no_failed_units
check loopback_only loopback_only
check no_ssh_socket no_ssh_socket
check journal_sync_interval journal_sync_interval
check inbound_dropped inbound_dropped
check binaries binaries
check io_uring_disabled sysctl_is kernel.io_uring_disabled 2
check tty_ldisc_autoload_off sysctl_is dev.tty.ldisc_autoload 0
check database_directory_not_listable database_directory_not_listable
if [ "$phase" = 1 ]; then
	check root_grown root_grown
	check lvm_partition lvm_partition
	check database_unit_sandbox database_unit_sandbox
	check database_unit_waits_for_recovery database_unit_waits_for_recovery
	check database_unit_has_no_start_pre database_unit_has_no_start_pre
	check database_unit_syscall_filter database_unit_syscall_filter
	check sshd_policy sshd_policy
	check sshd_certificate_only sshd_certificate_only
	check backup_slice_top_level backup_slice_top_level
fi
check pool wait_for 120 pool
# After a reboot the agent has recreated the empty /run/pgcf/<id> of the scratch database.
[ "$phase" = 1 ] || check socket_directory_after_boot wait_for 30 socket_directory
check scratch_database scratch_database
check socket_directory socket_directory
check no_volume_in_pid_1_namespace no_volume_in_pid_1_namespace
if [ "$phase" = 1 ]; then
	check scratch_filesystem_gap scratch_filesystem_gap
	check database_unit_device_allow database_unit_device_allow
	check database_unit_needs_the_link database_unit_needs_the_link
	check scratch_database_runs_across_an_agent_restart scratch_database_runs_across_an_agent_restart
	check database_user_reaches_no_block_device database_user_reaches_no_block_device
	check database_user_shares_nothing_writable database_user_shares_nothing_writable
	check database_second_postmaster_is_refused database_second_postmaster_is_refused
else
	check scratch_database_was_stopped_cleanly scratch_database_was_stopped_cleanly
fi
check loopback_only_after_database loopback_only

if [ "$failures" -eq 0 ]; then
	echo "PGCF-BOOT-TEST phase $phase ok"
else
	echo "PGCF-BOOT-TEST phase $phase fail $failures"
fi
sync
if [ "$phase" = 1 ]; then
	touch "$state/first-boot-done"
	sync
	systemctl --no-block reboot
else
	systemctl --no-block poweroff
fi

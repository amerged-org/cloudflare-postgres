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

# A slot's uid is used by one database after another, and journald keeps a user-<uid>.journal file
# with a read ACL for the uid of every user outside systemd's system, dynamic and container ranges
# (SplitMode=uid, the default), so the image turns the split off.
journal_not_split() {
	# Read whole first: grep -q would end the pipe at the first match and pipefail would report the
	# writer's SIGPIPE, which the drop-in before pgcf.conf makes likely.
	local config
	config=$(systemd-analyze cat-config systemd/journald.conf) && grep -qx 'SplitMode=none' <<<"$config"
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

# D13: a slot is as closed as a database unit, so it rates SAFE and no worse than the database unit.
slot_unit_sandbox() {
	local slot database
	slot=$(systemd-analyze security --no-pager pgcf-slot@boottest.service | tail -n 1) || return 1
	database=$(systemd-analyze security --no-pager pgcf-pg@pgcfboottest0000000.service | tail -n 1) || return 1
	grep -q 'SAFE' <<<"$slot" || {
		echo "$slot"
		return 1
	}
	awk -v slot="$slot" -v database="$database" '
		function exposure(line) { sub(/^.*: /, "", line); return line + 0 }
		BEGIN { exit !(exposure(slot) <= exposure(database)) }' || {
		echo "the slot is exposed more than the database unit: $slot / $database"
		return 1
	}
}

# PostgreSQL reports ready only after crash recovery or a restore's replay, which Stage 1 measured
# above systemd's default 90 s start timeout; the agent owns the deadline.
database_unit_waits_for_recovery() {
	[ "$(systemctl show --property=TimeoutStartUSec --value "$1")" = infinity ]
}

# The unit starts the postmaster alone: an ExecStartPre= process costs about 35 ms on every wake,
# so the agent creates the socket directory instead (socket_directory).
database_unit_has_no_start_pre() {
	[ -z "$(systemctl show --property=ExecStartPre --value "$1")" ]
}

# Plan 8: the filter is an allow-list (@system-service) with the deny lines subtracted, and systemd
# reports what is left. A database's user must not reach io_uring, userfaultfd, the kernel keyring,
# the message queues or the SysV semaphores; PostgreSQL's shared memory calls must stay.
database_unit_syscall_filter() {
	local allowed name
	allowed=$(systemctl show --property=SystemCallFilter --value "$1" | tr ' ' '\n')
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

# A slot has no MountImages=, so its policy has no block device: only the clock, from ProtectClock.
# The volume it serves is a mount that the agent moves in, and it is as closed as the database
# unit's: a private /dev and no capability.
slot_unit_device_allow() {
	local unit=pgcf-slot@boottest.service actual
	actual=$(systemctl show --property=DeviceAllow --value "$unit" | grep -v '^$')
	[ "$actual" = 'char-rtc r' ] || {
		echo "DeviceAllow: $actual"
		return 1
	}
	[ "$(systemctl show --property=DevicePolicy --value "$unit")" = closed ] &&
		[ "$(systemctl show --property=PrivateDevices --value "$unit")" = yes ] &&
		[ -z "$(systemctl show --property=CapabilityBoundingSet --value "$unit" | tr -d ' ')" ] ||
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

# The sockets that every unit of the image may reach, each answered by a service that checks its
# caller (the list below, in database_user_shares_nothing_writable): an extended regular expression.
checked_endpoints='^/run/systemd/journal/(socket|dev-log|stdout)$|^/run/systemd/notify$|^/run/systemd/(userdb/|netif/|resolve/)?io\.systemd\.[A-Za-z.]+$|^/run/dbus/system_bus_socket$|^/run/pgcf/agent/archive\.sock$'

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
#   private /tmp, /var/tmp and /dev/shm and its own cgroup's pressure files. The character devices
#   of the private /dev (null, zero, full, random, urandom, tty) and symbolic links hold no data;
# - every socket and FIFO it can write is on an explicit list of endpoints that check their caller
#   (see $endpoints below); a FIFO of any kind, or a socket not on the list, is a finding.
database_user_shares_nothing_writable() {
	local id=pgcfcheckscratch0000 pid uid gid own marker place segment owners listing found leftover endpoints result=0
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
	found=$(as_user find / \( -path /proc -o -path /efi -o -path "$own" \) -prune -o \
		\( -type d -o -type f -o -type s -o -type p \) -writable -printf '%y %p\n' 2>/dev/null)
	# /run/pgcf/<id> is the unit's own and the one place here that nothing bounds (plan 11.2).
	leftover=$(grep -E '^[df] ' <<<"$found" | cut -c3- |
		grep -vE "^(/dev/shm|/tmp|/var/tmp)(/|$)|^/run/pgcf/$id(/|$)|^/sys/fs/cgroup/pgcf\.slice/pgcf-pg@$id\.service/")
	[ -z "$leftover" ] || {
		echo "writable and not the unit's own: $leftover"
		result=1
	}
	# The endpoints a database's user may connect to, each with the service that checks its caller:
	# - the socket PostgreSQL made in the socket directory (its own, the gateway's way in);
	# - journald's three sockets, systemd's notify socket and systemd's varlink sockets
	#   (io.systemd.*, in /run/systemd and below it in userdb, netif and resolve, where the image's
	#   networkd and PID 1 make them): the notify socket accepts only the unit's main process
	#   (NotifyAccess=main), the varlink services answer by the caller's rights;
	# - D-Bus's system bus socket, where the bus policy and polkit refuse a change;
	# - the agent's archive socket (mode 0666): the archive command of every database calls it, and it
	#   authorizes by the kernel's report of the caller's uid alone (SO_PEERCRED).
	# A FIFO is never expected.
	endpoints=$(grep -E '^[sp] ' <<<"$found" | cut -c3- |
		grep -vE "^/run/pgcf/$id/\.s\.PGSQL\.5432$|$checked_endpoints")
	[ -z "$endpoints" ] || {
		echo "a socket or FIFO the user can write and no one checks: $endpoints"
		result=1
	}
	[ "$result" = 0 ]
}

# A journal file as journald made it before the image turned the split off (journald.conf.d/
# pgcf-split.conf): user-<uid>.journal, mode 0640 root:systemd-journal, with a POSIX ACL entry that
# grants the uid read access. EU1 holds 371 of them and journald vacuums them only by age. The image
# has no setfacl, so the ACL is written as the extended attribute that journald's own files carry.
legacy_journal_file() {
	local uid=$1 directory file
	directory=$(find /var/log/journal /run/log/journal -mindepth 1 -maxdepth 1 -type d 2>/dev/null | head -n 1)
	[ -n "$directory" ] || return 1
	file=$directory/user-$uid.journal
	install -m 0640 -o root -g systemd-journal /dev/null "$file" || return 1
	python3 -c '
import os, struct, sys
entry = lambda tag, perm, ident=0xFFFFFFFF: struct.pack("<HHI", tag, perm, ident)
acl = struct.pack("<I", 2) + entry(0x01, 6) + entry(0x02, 4, int(sys.argv[2])) + entry(0x04, 4) + entry(0x10, 4) + entry(0x20, 0)
os.setxattr(sys.argv[1], "system.posix_acl_access", acl)' "$file" "$uid" || {
		rm -f "$file"
		return 1
	}
	echo "$file"
}

# A database's journal is its own to nobody. journald's SplitMode=uid (the default) kept a
# user-<uid>.journal file for every database uid with a POSIX ACL that grants that uid read access,
# in a directory every user may traverse. The file holds PostgreSQL's log lines, DETAIL lines with
# data values included. The agent frees a uid when its database leaves the node, and hands it to a
# later database whose preferred or probed uid it is; the file stays, so the new tenant would read
# the former one's log. The image has turned the split off, so journald makes no new file (the slot
# test below), but the files it made stay: the unit cannot see the journal directories (PostgreSQL
# logs through /run/systemd/journal/stdout, which stays). The control is such a file, made as
# journald made them (legacy_journal_file): the user's uid reads it on the host.
database_user_reads_no_journal() {
	local id=pgcfcheckscratch0000 pid uid gid fixture file place result=0
	pid=$(systemctl show --property=MainPID --value "pgcf-pg@$id.service")
	[ "${pid:-0}" -gt 0 ] || {
		echo "the scratch database does not run"
		return 1
	}
	uid=$(stat -c %u "/proc/$pid")
	gid=$(stat -c %g "/proc/$pid")
	as_user() {
		nsenter --target "$pid" --mount --ipc -- setpriv --reuid="$uid" --regid="$gid" --clear-groups \
			--bounding-set=-all --inh-caps=-all --no-new-privs -- "$@"
	}
	fixture=$(legacy_journal_file "$uid") || {
		echo "no journal file could be made: the probe proves nothing"
		return 1
	}
	setpriv --reuid="$uid" --regid="$gid" --clear-groups -- test -r "$fixture" || {
		echo "the uid does not read the journal file on the host: the probe proves nothing"
		result=1
	}
	while IFS= read -r file; do
		if as_user test -r "$file"; then
			echo "the user reads a journal file: $file"
			result=1
		fi
	done < <(find /var/log/journal /run/log/journal -name 'user-*.journal*' 2>/dev/null)
	for place in /var/log/journal /run/log/journal; do
		[ -e "$place" ] || continue
		if ! grep -q 'Permission denied' <<<"$(as_user ls -A "$place" 2>&1)"; then
			echo "$place is not refused"
			result=1
		fi
	done
	rm -f "$fixture"
	[ "$result" = 0 ]
}

# A database's scratch space is bounded. The private /tmp and /var/tmp used to be directories on the
# host's root filesystem (8 GiB, no quota, and disk blocks are not memory the unit's MemoryMax
# counts): one awake tenant could fill it, which stops the journal and the agent's state writes
# for the whole node. They are small tmpfs of the unit's own now, and /dev/shm is one already.
# As the unit's user: each is a tmpfs within its limit, and a write past it fails.
database_scratch_space_is_bounded() {
	local id=pgcfcheckscratch0000 pid uid gid spec place limit_bytes limit_inodes type blocks size inodes result=0
	pid=$(systemctl show --property=MainPID --value "pgcf-pg@$id.service")
	[ "${pid:-0}" -gt 0 ] || {
		echo "the scratch database does not run"
		return 1
	}
	uid=$(stat -c %u "/proc/$pid")
	gid=$(stat -c %g "/proc/$pid")
	as_user() {
		nsenter --target "$pid" --mount --ipc -- setpriv --reuid="$uid" --regid="$gid" --clear-groups \
			--bounding-set=-all --inh-caps=-all --no-new-privs -- "$@"
	}
	for spec in /tmp:16777216:1024 /var/tmp:16777216:1024 /dev/shm:67108864:0; do
		IFS=: read -r place limit_bytes limit_inodes <<<"$spec"
		read -r type blocks size inodes < <(as_user stat -f -c '%T %b %S %c' "$place")
		if [ "$type" != tmpfs ] || [ $((blocks * size)) -gt "$limit_bytes" ]; then
			echo "$place is $type of $((blocks * size)) bytes, not a tmpfs of at most $limit_bytes"
			result=1
		fi
		if [ "$limit_inodes" -gt 0 ] && [ "$inodes" -gt "$limit_inodes" ]; then
			echo "$place holds up to $inodes files, more than $limit_inodes"
			result=1
		fi
		# The directory is writable, and a write past the limit fails (the 64 MiB of /dev/shm are left
		# out: they are memory of the unit, which the scratch database's own limit is not made for).
		[ "$place" != /dev/shm ] || continue
		as_user dd if=/dev/zero of="$place/fill" bs=1M count=1 2>/dev/null || {
			echo "the user cannot write $place: its limit proves nothing"
			result=1
			continue
		}
		if as_user dd if=/dev/zero of="$place/fill" bs=1M count=$((limit_bytes / 1048576 + 1)) 2>/dev/null; then
			echo "the user wrote more than $limit_bytes bytes to $place"
			result=1
		fi
		as_user rm -f "$place/fill"
	done
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

# ---- The slot (pgcf-slot@.service; plan 11.2, package P).
# A slot is the sandbox of a database unit with a pooled user, and that user's uid (300000 + n) is
# used by one database after another, so these checks are about everything that keeps something by
# uid: every mount, every file the uid can write or read, the IPC namespace, the POSIX queues, the
# keyrings and the journal. The agent does not start slots yet, and the supervisor is not under
# test: a runtime drop-in swaps ExecStart= for a process that logs one line and waits, and every
# other directive is the template's. The users are made the way the agent makes them.
slot_test_n=1000
slot_control_n=1001
# A uid in the slots' range that no slot has: what an unrelated tenant can read.
slot_reference_uid=390000
# The uid that holds the key the keyring probe must report (slot_keyring_probe_sees_a_key).
slot_key_control_uid=390001

slot_account() {
	groupadd -g $((300000 + $1)) "pgcf-slot-$1" &&
		useradd -u $((300000 + $1)) -g "pgcf-slot-$1" -M -s /usr/sbin/nologin -d /nonexistent "pgcf-slot-$1"
}

# The slot's unit running with a drop-in; further arguments are settings of its [Service] section.
slot_up() {
	local n=$1 dropin=/run/systemd/system/pgcf-slot@$1.service.d
	mkdir -p "$dropin" || return 1
	printf '%s\n' '[Service]' 'Type=simple' 'ExecStart=' \
		'ExecStart=/bin/sh -c "echo pgcf-slot-boot-test; exec sleep infinity"' "${@:2}" >"$dropin/boot-test.conf"
	systemctl daemon-reload && systemctl start "pgcf-slot@$n.service" || return 1
	# Type=simple is active before the shell has become sleep, and the line has to be in the journal.
	wait_for 10 slot_runs "$n" && wait_for 10 slot_has_logged "$n"
}
slot_runs() {
	local pid
	pid=$(systemctl show --property=MainPID --value "pgcf-slot@$1.service")
	[ "${pid:-0}" -gt 0 ] && [ "$(cat "/proc/$pid/comm" 2>/dev/null)" = sleep ]
}
slot_has_logged() {
	[ -n "$(journalctl --unit="pgcf-slot@$1.service" --no-pager --output=cat 2>/dev/null | grep pgcf-slot-boot-test)" ]
}
slot_down() {
	systemctl stop "pgcf-slot@$1.service"
}
slot_forget() {
	systemctl stop "pgcf-slot@$1.service" 2>/dev/null
	rm -rf "/run/systemd/system/pgcf-slot@$1.service.d"
	systemctl daemon-reload
	userdel "pgcf-slot-$1" 2>/dev/null
	groupdel "pgcf-slot-$1" 2>/dev/null
	true
}

# The slot's user, in the mount and IPC namespaces of its unit, with no capability: $1 is the unit's
# main process, $2 and $3 are the uid and the gid.
slot_as() {
	local pid=$1 uid=$2 gid=$3
	shift 3
	nsenter --target "$pid" --mount --ipc -- setpriv --reuid="$uid" --regid="$gid" --clear-groups \
		--bounding-set=-all --inh-caps=-all --no-new-privs -- "$@"
}

# Every file, directory and socket a uid can read, from outside the sandbox or, with a command
# that enters it, from inside; /sys, /proc and the ESP's automount are left out.
readable_by() {
	local uid=$1
	shift
	"$@" setpriv --reuid="$uid" --regid="$uid" --clear-groups --bounding-set=-all --inh-caps=-all --no-new-privs -- \
		find / \( -path /proc -o -path /sys -o -path /efi \) -prune -o -readable -print 2>/dev/null | sort
}

# What the uid reads and an unrelated tenant does not: what is kept by uid. The arguments are a
# command that enters the sandbox, or none.
kept_by_uid() {
	local uid=$1
	shift
	comm -23 <(readable_by "$uid" "$@") <(readable_by "$slot_reference_uid" "$@")
}

# One line for each finding, nothing for a slot that shares and keeps nothing by uid.
slot_findings() {
	local n=$1 unit=pgcf-slot@$1.service pid uid gid own cgroup place listing segment objects found mount kept
	pid=$(systemctl show --property=MainPID --value "$unit")
	if [ "${pid:-0}" -le 0 ]; then
		echo "the slot does not run"
		return 0
	fi
	uid=$(stat -c %u "/proc/$pid")
	gid=$(stat -c %g "/proc/$pid")
	own=/run/pgcf/slot/$n
	cgroup=/sys/fs/cgroup$(sed -n 's/^0:://p' "/proc/$pid/cgroup")
	[ "$uid:$gid" = "$((300000 + n)):$((300000 + n))" ] || echo "the slot runs as $uid:$gid"
	[ "$(stat -c %U:%G:%a "$own" 2>/dev/null)" = "pgcf-slot-$n:pgcf-slot-$n:700" ] || echo "the control directory is not pgcf-slot-$n:pgcf-slot-$n:700"
	# Places that every unit of the node shares.
	for place in /run/lock /dev/mqueue /dev/pts; do
		if slot_as "$pid" "$uid" "$gid" sh -c 'touch "$1/probe" 2>/dev/null && rm "$1/probe"' sh "$place"; then
			echo "a file can be created in $place"
		fi
		listing=$(slot_as "$pid" "$uid" "$gid" ls -A "$place" 2>&1)
		grep -q 'Permission denied' <<<"$listing" || echo "$place is not refused: ${listing//$'\n'/ }"
	done
	# The journal directories, where journald keeps files by uid.
	for place in /var/log/journal /run/log/journal; do
		[ -e "$place" ] || continue
		listing=$(slot_as "$pid" "$uid" "$gid" ls -A "$place" 2>&1)
		grep -q 'Permission denied' <<<"$listing" || echo "$place is not refused: ${listing//$'\n'/ }"
	done
	# SysV shared memory, semaphores and queues, and the POSIX queues: an IPC namespace of the unit's
	# own, empty when the slot starts and without the host's segment.
	[ "$(readlink "/proc/$pid/ns/ipc")" != "$(readlink /proc/1/ns/ipc)" ] || echo "the slot is in PID 1's IPC namespace"
	segment=$(ipcmk --shmem 4096 | awk '{ print $NF }')
	if [ -z "$segment" ]; then
		echo "no SysV segment could be made on the host: the probe proves nothing"
	elif nsenter --target "$pid" --ipc -- awk -v id="$segment" 'FNR > 1 && $2 == id { found = 1 } END { exit !found }' /proc/sysvipc/shm; then
		echo "the host's SysV segment $segment is in the slot's namespace"
	fi
	[ -z "$segment" ] || ipcrm --shmem-id "$segment"
	objects=$(nsenter --target "$pid" --ipc -- awk 'FNR > 1 { count++ } END { print count + 0 }' /proc/sysvipc/shm /proc/sysvipc/msg /proc/sysvipc/sem)
	[ "$objects" = 0 ] || echo "the slot's IPC namespace holds $objects SysV objects at its start"
	# Every mount of the unit's mount namespace that the slot's user can write.
	while IFS= read -r mount; do
		slot_as "$pid" "$uid" "$gid" test -w "$mount" || continue
		case $mount in
		/tmp | /var/tmp | /dev/shm | "$own" | "$cgroup"/*) ;;
		*) echo "a mount the slot's user can write: $mount" ;;
		esac
	done < <(nsenter --target "$pid" --mount -- awk '{ print $5 }' /proc/self/mountinfo)
	# Every directory, file, socket and FIFO it can write: its own, or an endpoint that checks its caller.
	found=$(slot_as "$pid" "$uid" "$gid" find / \( -path /proc -o -path /efi \) -prune -o \
		\( -type d -o -type f -o -type s -o -type p \) -writable -printf '%y %p\n' 2>/dev/null)
	kept=$(grep -E '^[df] ' <<<"$found" | cut -c3- | grep -vE "^(/dev/shm|/tmp|/var/tmp|$own)(/|$)|^$cgroup/")
	[ -z "$kept" ] || echo "writable and not the slot's own: ${kept//$'\n'/ }"
	kept=$(grep -E '^[sp] ' <<<"$found" | cut -c3- | grep -vE "^$own/|$checked_endpoints")
	[ -z "$kept" ] || echo "a socket or FIFO the slot's user can write and no one checks: ${kept//$'\n'/ }"
	# Every file it can read and an unrelated tenant cannot: only its own control directory.
	kept=$(kept_by_uid "$uid" nsenter --target "$pid" --mount --ipc -- | grep -vE "^$own(/|$)")
	[ -z "$kept" ] || echo "kept by the slot's uid and readable by it: ${kept//$'\n'/ }"
}

# What the first database leaves for the next one in every place it can write: a file in each, and
# a SysV segment. Queues, keys and the journal are closed to it, and the host is searched for them
# after the stop (slot_leftovers).
slot_mark() {
	local n=$1 pid uid gid own=/run/pgcf/slot/$1 place
	pid=$(systemctl show --property=MainPID --value "pgcf-slot@$n.service")
	uid=$(stat -c %u "/proc/$pid")
	gid=$(stat -c %g "/proc/$pid")
	for place in /tmp /var/tmp /dev/shm "$own"; do
		slot_as "$pid" "$uid" "$gid" touch "$place/pgcf-slot-marker" || echo "the slot's user cannot write $place: the marker proves nothing"
	done
	slot_as "$pid" "$uid" "$gid" ipcmk --shmem 4096 >/dev/null || echo "the slot's user cannot make a SysV segment: the marker proves nothing"
}
slot_marker_left() {
	local n=$1 pid uid gid left
	pid=$(systemctl show --property=MainPID --value "pgcf-slot@$n.service")
	uid=$(stat -c %u "/proc/$pid")
	gid=$(stat -c %g "/proc/$pid")
	left=$(slot_as "$pid" "$uid" "$gid" find /tmp /var/tmp /dev/shm "/run/pgcf/slot/$n" -name pgcf-slot-marker 2>/dev/null)
	[ -z "$left" ] || echo "the former incarnation's files are there: ${left//$'\n'/ }"
}

# After the stop, on the host: nothing is kept by the slot's uid.
slot_leftovers() {
	local n=$1 uid=$((300000 + $1)) kept
	[ ! -e "/run/pgcf/slot/$n" ] || echo "the control directory is still there"
	kept=$(kept_by_uid "$uid")
	[ -z "$kept" ] || echo "kept by uid $uid and readable by it: ${kept//$'\n'/ }"
	kept=$(find / \( -path /proc -o -path /sys -o -path /efi \) -prune -o \( -uid "$uid" -o -gid "$uid" \) -print 2>/dev/null)
	[ -z "$kept" ] || echo "owned by uid $uid: ${kept//$'\n'/ }"
	kept=$(find /var/log/journal /run/log/journal -name "user-$uid.journal*" 2>/dev/null)
	[ -z "$kept" ] || echo "journald keeps a journal file of uid $uid: ${kept//$'\n'/ }"
	kept=$(awk -v uid="$uid" 'FILENAME ~ /sem$/ { if ($5 == uid) found = 1; next } FNR > 1 && $8 == uid { found = 1 } END { if (found) print "yes" }' \
		/proc/sysvipc/shm /proc/sysvipc/msg /proc/sysvipc/sem)
	[ -z "$kept" ] || echo "the host's IPC namespace holds a SysV object of uid $uid"
	keys_of_uid "$uid" >/dev/null || echo "/proc/keys cannot be read as uid $uid: the keyring probe proves nothing"
	wait_for 10 slot_has_no_key "$uid" || echo "the kernel keeps a key of uid $uid: $(keys_of_uid "$uid" | awk '{ print $8 ":" $9 }' | tr '\n' ' ')"
}
# The lines of /proc/keys that belong to a uid. /proc/keys lists only the keys that its reader may
# view, and root may view none of another uid's (the user keyring _uid.<uid> and the keys in it
# stay in the kernel after the last process of the uid has gone), so it is read as the uid itself.
keys_of_uid() {
	local uid=$1 listing
	listing=$(setpriv --reuid="$uid" --regid="$uid" --clear-groups --bounding-set=-all --inh-caps=-all --no-new-privs -- cat /proc/keys) || return 1
	awk -v uid="$uid" '$6 == uid' <<<"$listing"
}
# A read that fails is no answer: it is never "no key".
slot_has_no_key() {
	local keys
	keys=$(keys_of_uid "$1") && [ -z "$keys" ]
}

# Two incarnations of one slot, as two databases in turn: the first writes what it can, the second
# finds nothing of it, and after each stop nothing is kept by the uid.
slot_isolation() {
	local n=$slot_test_n findings
	slot_account "$n" || return 1
	mkdir -p /run/pgcf/slot/boot-test-neighbour
	findings=$(
		if slot_up "$n"; then
			slot_findings "$n"
			slot_mark "$n"
			slot_down "$n"
			slot_leftovers "$n"
			if slot_up "$n"; then
				slot_findings "$n"
				slot_marker_left "$n"
			else
				echo "the slot does not start again"
			fi
			slot_down "$n"
			slot_leftovers "$n"
		else
			echo "the slot does not start"
		fi
		# The control directory is the leaf of /run/pgcf/slot/<n>: the stop removes it and not the
		# directories of the other slots.
		[ -d /run/pgcf/slot/boot-test-neighbour ] || echo "the stop of a slot removed the control directory of another"
	)
	rmdir /run/pgcf/slot/boot-test-neighbour 2>/dev/null
	slot_forget "$n"
	[ -z "$findings" ] || {
		echo "$findings"
		return 1
	}
}

# The enumeration is not vacuous: against the same unit without the additions (no private IPC
# namespace, no inaccessible path) it must find every shared place.
slot_enumeration_sees_an_open_unit() {
	local n=$slot_control_n findings missing= place
	slot_account "$n" || return 1
	if slot_up "$n" PrivateIPC=no InaccessiblePaths=; then
		findings=$(slot_findings "$n")
	else
		findings="the control unit does not start"
	fi
	slot_forget "$n"
	for place in 'a file can be created in /run/lock' 'a file can be created in /dev/mqueue' '/dev/pts is not refused' \
		'/var/log/journal is not refused' "the slot is in PID 1's IPC namespace" 'SysV segment'; do
		grep -qF "$place" <<<"$findings" || missing="$missing [$place]"
	done
	[ -z "$missing" ] || {
		echo "not seen in a unit without the additions:$missing"
		echo "$findings"
		return 1
	}
}

# A key in the user keyring of a uid, added by a process of that uid with no capability. glibc has no
# add_key; the call is the kernel's, and its number differs by architecture.
plant_key() {
	setpriv --reuid="$1" --regid="$1" --clear-groups --bounding-set=-all --inh-caps=-all --no-new-privs -- python3 -c '
import ctypes, os, sys
add_key = {"x86_64": 248, "aarch64": 217}[os.uname().machine]
KEY_SPEC_USER_KEYRING = -4
key = ctypes.CDLL(None).syscall(ctypes.c_long(add_key), b"user", b"pgcf-boot-test", b"x", ctypes.c_size_t(1), ctypes.c_long(KEY_SPEC_USER_KEYRING))
sys.exit(0 if key > 0 else 1)'
}

# The keyring probe is not blind: a key that a process of an unrelated uid adds to its user keyring
# stays in the kernel after the process has gone, and slot_has_no_key has to report it.
slot_keyring_probe_sees_a_key() {
	local uid=$slot_key_control_uid
	plant_key "$uid" || {
		echo "no key could be added as uid $uid: the control proves nothing"
		return 1
	}
	! slot_has_no_key "$uid" || {
		echo "the probe sees no key of uid $uid although one was added"
		return 1
	}
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
check journal_not_split journal_not_split
check inbound_dropped inbound_dropped
check binaries binaries
check io_uring_disabled sysctl_is kernel.io_uring_disabled 2
check tty_ldisc_autoload_off sysctl_is dev.tty.ldisc_autoload 0
check database_directory_not_listable database_directory_not_listable
if [ "$phase" = 1 ]; then
	check root_grown root_grown
	check lvm_partition lvm_partition
	check database_unit_sandbox database_unit_sandbox
	check slot_unit_sandbox slot_unit_sandbox
	check database_unit_waits_for_recovery database_unit_waits_for_recovery pgcf-pg@pgcfboottest0000000.service
	check slot_unit_waits_for_recovery database_unit_waits_for_recovery pgcf-slot@boottest.service
	check database_unit_has_no_start_pre database_unit_has_no_start_pre pgcf-pg@pgcfboottest0000000.service
	check slot_unit_has_no_start_pre database_unit_has_no_start_pre pgcf-slot@boottest.service
	check database_unit_syscall_filter database_unit_syscall_filter pgcf-pg@pgcfboottest0000000.service
	check slot_unit_syscall_filter database_unit_syscall_filter pgcf-slot@boottest.service
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
	check slot_unit_device_allow slot_unit_device_allow
	check database_unit_needs_the_link database_unit_needs_the_link
	check scratch_database_runs_across_an_agent_restart scratch_database_runs_across_an_agent_restart
	check database_user_reaches_no_block_device database_user_reaches_no_block_device
	check database_user_shares_nothing_writable database_user_shares_nothing_writable
	check database_user_reads_no_journal database_user_reads_no_journal
	check database_scratch_space_is_bounded database_scratch_space_is_bounded
	check database_second_postmaster_is_refused database_second_postmaster_is_refused
	check slot_isolation slot_isolation
	check slot_enumeration_sees_an_open_unit slot_enumeration_sees_an_open_unit
	check slot_keyring_probe_sees_a_key slot_keyring_probe_sees_a_key
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

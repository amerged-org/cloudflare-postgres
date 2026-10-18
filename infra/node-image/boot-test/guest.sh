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

scratch_volumes() {
	lvs --noheadings --options lv_uuid,lv_tags pgcf 2>/dev/null | awk '$2 ~ /(^|,)pgcf\.db\./ { print $1 }'
}

# Plan 9.1: `pgcf-agent check` creates a scratch database on a thin volume and queries it; after a
# reboot the same database wakes again (no second volume appears).
scratch_database() {
	/var/lib/pgcf/bin/current/pgcf-agent check || return 1
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
# database's user reaches its own directory but cannot list the other databases' IDs.
database_directory_not_listable() {
	local mode
	mode=$(stat -c %a /var/lib/pgcf/db) || return 1
	[ "$mode" = 711 ] || {
		echo "mode $mode"
		false
	}
}

# systemd nests a slice whose name has a dash inside the slice before the dash. A backup job must
# not run under the databases' slice and its memory ceiling.
backup_slice_top_level() {
	local cgroup
	cgroup=$(systemd-run --quiet --pipe --wait --collect --slice=pgcfbackup.slice cat /proc/self/cgroup) || return 1
	case $cgroup in
	0::/pgcfbackup.slice/*) ;;
	*)
		echo "backup job cgroup: $cgroup"
		false
		;;
	esac
}

check no_failed_units no_failed_units
check loopback_only loopback_only
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
	check backup_slice_top_level backup_slice_top_level
fi
check pool wait_for 120 pool
# After a reboot the agent has recreated the empty /run/pgcf/<id> of the scratch database.
[ "$phase" = 1 ] || check socket_directory_after_boot wait_for 30 socket_directory
check scratch_database scratch_database
check socket_directory socket_directory
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

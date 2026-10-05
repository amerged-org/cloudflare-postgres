// SPDX-License-Identifier: Apache-2.0
import type { NodeBootstrapInput } from "@pgcf/contracts/node-bootstrap";

type ScratchInput = Pick<NodeBootstrapInput, "spec" | "input_hash">;
const RESERVE_BYTES = 512 * 1024 ** 2;

function quote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Prepare only RAM-backed, input-bound image staging; never touch the install disk. */
export function prepareScratchScript(input: ScratchInput): string {
  const spec = input.spec;
  const imageBytes = spec.image.compressed_bytes + spec.image.raw_bytes;
  const limitBytes = imageBytes + RESERVE_BYTES;
  if (
    !/^op_[a-z0-9]{20}$/.test(spec.operation_id) ||
    !/^[a-f0-9]{64}$/.test(input.input_hash) ||
    !Number.isSafeInteger(spec.image.compressed_bytes) ||
    spec.image.compressed_bytes <= 0 ||
    !Number.isSafeInteger(spec.image.raw_bytes) ||
    spec.image.raw_bytes <= 0 ||
    !Number.isSafeInteger(limitBytes) ||
    !Number.isSafeInteger(spec.hardware.rescue_ram_min_bytes) ||
    spec.hardware.rescue_ram_min_bytes < limitBytes
  ) {
    throw new Error("rescue_scratch_input_invalid");
  }
  const directory = `/run/pgcf-bootstrap/${spec.operation_id}`;
  const source = `pgcf-bootstrap-${spec.operation_id}-${input.input_hash}`;
  return `set -euo pipefail
umask 077
command -v findmnt mount swapon readlink find stat df awk getconf cat chmod >/dev/null
scratch_dir=${quote(directory)}
scratch_source=${quote(source)}
scratch_hash=${quote(input.input_hash)}
scratch_image_bytes=${imageBytes}
scratch_limit_bytes=${limitBytes}
scratch_reserve_bytes=${RESERVE_BYTES}
scratch_swaps="$(swapon --show --noheadings --raw --output NAME)"
test -z "$scratch_swaps"
test ! -L /run
scratch_real_path="$(readlink -f /run)"
test "$scratch_real_path" = /run
scratch_parent_mount="$(findmnt --noheadings --raw --target /run --output TARGET,SOURCE,FSTYPE)"
read -r scratch_parent_target scratch_parent_source scratch_parent_type scratch_extra <<< "$scratch_parent_mount"
test -n "$scratch_parent_target" && test -n "$scratch_parent_source" && test -z "$scratch_extra"
case "$scratch_parent_type" in tmpfs|ramfs|rootfs) ;; *) exit 41;; esac
test ! -L /run/pgcf-bootstrap
if test -e /run/pgcf-bootstrap; then test -d /run/pgcf-bootstrap; else mkdir /run/pgcf-bootstrap; fi
scratch_real_path="$(readlink -f /run/pgcf-bootstrap)"
test "$scratch_real_path" = /run/pgcf-bootstrap
scratch_parent_mount="$(findmnt --noheadings --raw --target /run/pgcf-bootstrap --output TARGET,SOURCE,FSTYPE)"
read -r scratch_parent_target scratch_parent_source scratch_parent_type scratch_extra <<< "$scratch_parent_mount"
test -n "$scratch_parent_target" && test -n "$scratch_parent_source" && test -z "$scratch_extra"
case "$scratch_parent_type" in tmpfs|ramfs|rootfs) ;; *) exit 41;; esac
test ! -L "$scratch_dir"
if test -e "$scratch_dir"; then test -d "$scratch_dir"; else mkdir "$scratch_dir"; fi
scratch_real_path="$(readlink -f "$scratch_dir")"
test "$scratch_real_path" = "$scratch_dir"
scratch_mount="$(findmnt --noheadings --raw --target "$scratch_dir" --output TARGET,SOURCE,FSTYPE)"
read -r scratch_target scratch_actual_source scratch_type scratch_extra <<< "$scratch_mount"
test -n "$scratch_target" && test -n "$scratch_actual_source" && test -z "$scratch_extra"
scratch_mem_available="$(awk '$1 == "MemAvailable:" {printf "%.0f\\n", $2 * 1024}' /proc/meminfo)"
case "$scratch_mem_available" in ''|*[!0-9]*) exit 41;; esac
scratch_page_size="$(getconf PAGESIZE)"
case "$scratch_page_size" in ''|*[!0-9]*) exit 41;; esac
test "$scratch_page_size" -gt 0
scratch_mount_bytes=$(( (scratch_limit_bytes + scratch_page_size - 1) / scratch_page_size * scratch_page_size ))
if test "$scratch_target" != "$scratch_dir"; then
  case "$scratch_type" in tmpfs|ramfs|rootfs) ;; *) exit 41;; esac
  scratch_entry="$(find "$scratch_dir" -mindepth 1 -maxdepth 1 -print -quit)"
  test -z "$scratch_entry"
  test "$scratch_mem_available" -ge "$scratch_mount_bytes"
  mount -t tmpfs -o "size=$scratch_mount_bytes,mode=0700,nosuid,nodev,noexec" "$scratch_source" "$scratch_dir"
fi
scratch_mount="$(findmnt --noheadings --raw --target "$scratch_dir" --output TARGET,SOURCE,FSTYPE)"
read -r scratch_target scratch_actual_source scratch_type scratch_extra <<< "$scratch_mount"
test -z "$scratch_extra"
test "$scratch_target" = "$scratch_dir"
test "$scratch_actual_source" = "$scratch_source"
test "$scratch_type" = tmpfs
scratch_submounts="$(findmnt --noheadings --raw --submounts --mountpoint "$scratch_dir" --output TARGET)"
test "$scratch_submounts" = "$scratch_dir"
scratch_entry="$(find "$scratch_dir" -mindepth 1 -maxdepth 1 ! -name identity ! -name image.raw.xz ! -name image.raw ! -name image.raw.partial -print -quit)"
test -z "$scratch_entry"
scratch_cached_compressed=0
scratch_cached_raw=0
scratch_cached_partial=0
for scratch_name in identity image.raw.xz image.raw image.raw.partial; do
  scratch_file="$scratch_dir/$scratch_name"
  test ! -L "$scratch_file"
  if test -e "$scratch_file"; then
    test -f "$scratch_file"
    scratch_file_target="$(findmnt --noheadings --raw --target "$scratch_file" --output TARGET)"
    test "$scratch_file_target" = "$scratch_dir"
    scratch_file_bytes="$(stat --format=%s "$scratch_file")"
    case "$scratch_file_bytes" in ''|*[!0-9]*) exit 41;; esac
    case "$scratch_name" in
      identity) test "$scratch_file_bytes" -eq 64; scratch_identity="$(cat "$scratch_file")"; test "$scratch_identity" = "$scratch_hash";;
      image.raw.xz) test "$scratch_file_bytes" -le ${spec.image.compressed_bytes}; scratch_cached_compressed=$scratch_file_bytes;;
      image.raw) test "$scratch_file_bytes" -le ${spec.image.raw_bytes}; scratch_cached_raw=$scratch_file_bytes;;
      image.raw.partial) test "$scratch_file_bytes" -le ${spec.image.raw_bytes}; scratch_cached_partial=$scratch_file_bytes;;
    esac
  fi
done
if ! test -f "$scratch_dir/identity"; then
  scratch_entry="$(find "$scratch_dir" -mindepth 1 -maxdepth 1 -print -quit)"
  test -z "$scratch_entry"
  printf '%s' "$scratch_hash" > "$scratch_dir/identity"
fi
if test "$scratch_cached_partial" -gt "$scratch_cached_raw"; then scratch_cached_raw=$scratch_cached_partial; fi
scratch_remaining_bytes=$(( scratch_image_bytes - scratch_cached_compressed - scratch_cached_raw ))
test "$scratch_mem_available" -ge $(( scratch_remaining_bytes + scratch_reserve_bytes ))
scratch_capacity="$(df --block-size=1 --output=size,avail "$scratch_dir" | awk 'NR == 2 {print $1, $2}')"
read -r scratch_size scratch_available scratch_extra <<< "$scratch_capacity"
case "$scratch_size" in ''|*[!0-9]*) exit 41;; esac
case "$scratch_available" in ''|*[!0-9]*) exit 41;; esac
test -z "$scratch_extra"
test "$scratch_size" -eq "$scratch_mount_bytes"
test "$scratch_available" -le "$scratch_size"
test "$scratch_available" -ge "$scratch_remaining_bytes"
chmod 700 "$scratch_dir"
printf '%s\\n' pgcf_scratch_ready
`;
}

export async function prepareScratch(
  input: ScratchInput,
  ssh: (script: string) => Promise<{ exit_code: number; stdout: string }>,
): Promise<void> {
  const result = await ssh(prepareScratchScript(input));
  if (result.exit_code !== 0 || result.stdout.trim() !== "pgcf_scratch_ready") {
    throw new Error("rescue_scratch_not_ready");
  }
}

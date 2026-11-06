#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Precache only files selected by APT's signed, timestamped Snapshot indexes.
set -euo pipefail

cache_error() { printf '%s\n' "$*" >&2; return 1; }

selected_mirror() {
  local uri=$1 snapshot=$2 rest archive scheme
  [[ $snapshot =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { cache_error 'invalid snapshot'; return 1; }
  case "$uri" in
    http://snapshot.debian.org/archive/debian/"$snapshot"/pool/*|https://snapshot.debian.org/archive/debian/"$snapshot"/pool/*)
      archive=debian ;;
    http://snapshot.debian.org/archive/debian-security/"$snapshot"/pool/*|https://snapshot.debian.org/archive/debian-security/"$snapshot"/pool/*)
      archive=debian-security ;;
    *) cache_error 'selected URI is outside the configured Snapshot'; return 1 ;;
  esac
  rest=${uri#*://snapshot.debian.org/archive/"$archive"/"$snapshot"/}
  [[ $rest =~ ^pool/[A-Za-z0-9_./+%:~@-]+\.deb$ && /$rest/ != */../* && /$rest/ != */./* ]] || { cache_error 'invalid selected pool path'; return 1; }
  scheme=${uri%%:*}
  printf '%s://deb.debian.org/%s/%s\n' "$scheme" "$archive" "$rest"
}

verify_package() {
  local file=$1 size=$2 digest=$3 actual_size actual_hash
  [[ -f $file && ! -L $file ]] || return 1
  read -r actual_size _ < <(wc -c < "$file")
  read -r actual_hash _ < <(sha256sum -- "$file")
  [[ $actual_size == "$size" && $actual_hash == "${digest#SHA256:}" ]]
}

fetch_package() {
  /usr/lib/apt/apt-helper -o Acquire::Retries=0 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 download-file "$1" "$2" "$3"
}

cache_packages() (
  snapshot=${1:?snapshot required}; plan=${2:?APT URI plan required}; cache=${3:?APT cache directory required}
  partial=''
  mkdir -p "$cache/partial"
  selected=$(mktemp "$cache/partial/pgcf-selected.XXXXXX")
  trap 'rm -f -- "$selected"; if [[ -n ${partial:-} ]]; then rm -f -- "$partial" "$partial.FAILED"; fi' EXIT
  # Validate the whole plan before the first network request. Human APT summary lines are ignored.
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line == "'"* ]] || continue
    IFS=$' \t' read -r quoted filename size digest extra <<< "$line"
    [[ $quoted == "'"*"'" && -z ${extra:-} ]] || { cache_error 'invalid APT URI record'; return 1; }
    uri=${quoted#\'}; uri=${uri%\'}
    [[ $filename =~ ^[a-zA-Z0-9][A-Za-z0-9_.+%:~@-]*\.deb$ ]] || { cache_error 'unsafe APT cache filename'; return 1; }
    [[ $size =~ ^[1-9][0-9]*$ && $digest =~ ^SHA256:[0-9a-f]{64}$ ]] || { cache_error 'strong APT SHA256 and positive size required'; return 1; }
    mirror=$(selected_mirror "$uri" "$snapshot") || return 1
    printf '%s\t%s\t%s\t%s\t%s\n' "$uri" "$mirror" "$filename" "$size" "$digest" >> "$selected"
  done < "$plan"
  while IFS=$'\t' read -r uri mirror filename size digest; do
    target=$cache/$filename
    if verify_package "$target" "$size" "$digest"; then continue; fi
    rm -f -- "$target"
    partial=$cache/partial/$filename.$$.part
    complete=false
    for candidate in "$mirror" "$uri"; do
      rm -f -- "$partial" "$partial.FAILED"
      if fetch_package "$candidate" "$partial" "$digest"; then
        if ! verify_package "$partial" "$size" "$digest"; then
          cache_error 'downloaded package differs from signed APT metadata'; return 1
        fi
        mv -f -- "$partial" "$target"
        complete=true
        break
      fi
    done
    [[ $complete == true ]] || { cache_error 'selected package transports failed'; return 1; }
  done < "$selected"
)

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then cache_packages "$@"; fi

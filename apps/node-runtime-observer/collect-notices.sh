#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
set -eu
mkdir -p /out/licenses
cp /usr/local/go/LICENSE /out/licenses/Go-LICENSE
cp /usr/local/go/PATENTS /out/licenses/Go-PATENTS
# Include the pinned module inventory and upstream license/notice files.
# No module source, private environment or development cache enters the runtime.
go list -m all > /out/licenses/DEPENDENCIES.txt
go list -m -f '{{if .Dir}}{{.Path}}|{{.Dir}}{{end}}' all | while IFS='|' read -r module directory; do
  [ "$directory" = /source ] && continue
  destination="/out/licenses/$module"
  mkdir -p "$destination"
  found=0
  for notice in "$directory"/LICENSE* "$directory"/COPYING* "$directory"/NOTICE*; do
    [ -f "$notice" ] || continue
    cp "$notice" "$destination/$(basename "$notice")"
    found=1
  done
  [ "$found" = 1 ] || exit 1
done

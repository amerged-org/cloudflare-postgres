#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
set -eu
mkdir -p /licenses/crates /licenses/rust
find /usr/local/cargo/registry/src -type f \( -iname '*license*' -o -iname '*copying*' -o -iname '*notice*' \) -print | while IFS= read -r file; do
  path="${file#/usr/local/cargo/registry/src/}"
  mkdir -p "/licenses/crates/$(dirname "$path")"
  cp "$file" "/licenses/crates/$path"
done
rust_doc="$(rustc --print sysroot)/share/doc/rust"
test -f "$rust_doc/licenses/MIT.txt"
test -f "$rust_doc/licenses/Apache-2.0.txt"
test -f "$rust_doc/COPYRIGHT-library.html"
cp "$rust_doc/COPYRIGHT.html" "$rust_doc/COPYRIGHT-library.html" /licenses/rust/
cp -R "$rust_doc/licenses" /licenses/rust/

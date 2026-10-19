#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Gives the image's own tree the modes a release's host files state (host-files.ts): 0755 for a
# file its owner can execute and 0644 for any other, 0755 for a directory, whatever umask the
# checkout was made under. A link is left as it is. Without this a checkout made under umask 002
# would put 0664 files in the image, and every node would rewrite all of its host files at its
# first start (a reload and the restarts of ssh, journald, sysctl, the gateway, cloudflared and the
# agent) for a difference that is no fact of the files.
set -euo pipefail

tree=${1:?usage: normalize-modes.sh DIRECTORY}
find "$tree" -type d -exec chmod 0755 {} +
find "$tree" -type f -perm -u=x -exec chmod 0755 {} +
find "$tree" -type f ! -perm -u=x -exec chmod 0644 {} +

# SPDX-License-Identifier: Apache-2.0
FROM scratch
COPY manifest.yaml /manifest.yaml
COPY recipe.json /rootfs/usr/local/share/pgcf/talos-recipe.json
COPY LICENSE /rootfs/usr/local/share/licenses/pgcf-recipe/LICENSE

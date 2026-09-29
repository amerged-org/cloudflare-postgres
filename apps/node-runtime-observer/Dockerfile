# SPDX-License-Identifier: Apache-2.0
FROM golang:1.27.1-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414 AS build
WORKDIR /source
COPY apps/node-runtime-observer/go.mod apps/node-runtime-observer/go.sum ./
RUN go mod download
COPY apps/node-runtime-observer/observer ./observer
COPY apps/node-runtime-observer/cmd ./cmd
COPY apps/node-runtime-observer/collect-notices.sh ./collect-notices.sh
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/node-runtime-observer ./cmd/node-runtime-observer

RUN sh ./collect-notices.sh

FROM scratch
COPY --from=build /out/node-runtime-observer /node-runtime-observer
COPY --from=build /out/licenses /licenses
COPY LICENSE /LICENSE
COPY apps/node-runtime-observer/THIRD_PARTY.md /THIRD_PARTY.md
USER 65532:65532
ENTRYPOINT ["/node-runtime-observer"]

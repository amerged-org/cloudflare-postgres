# SPDX-License-Identifier: Apache-2.0
FROM golang:1.27.1-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414 AS build
WORKDIR /source
COPY apps/execution-guard/go.mod apps/execution-guard/go.sum ./
RUN go mod download
COPY apps/execution-guard/*.go ./
COPY apps/execution-guard/cmd ./cmd
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/execution-guard ./cmd/execution-guard
RUN mkdir -p /out/licenses && cp /usr/local/go/LICENSE /out/licenses/go-LICENSE && cp /go/pkg/mod/golang.org/x/sys@v0.40.0/LICENSE /out/licenses/x-sys-LICENSE

FROM scratch
COPY --from=build /out/execution-guard /execution-guard
COPY --from=build /out/licenses /licenses
COPY LICENSE /LICENSE
COPY apps/execution-guard/THIRD_PARTY.md /THIRD_PARTY.md
USER 65532:65532
ENTRYPOINT ["/execution-guard"]

# Copyright 2021 Alex Szakaly
# Modified by cloudflare-postgres contributors: pin the builder and build only the runtime artifact.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#    http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#

FROM --platform=$BUILDPLATFORM golang:1.26.0@sha256:fb612b7831d53a89cbc0aaa7855b69ad7b0caf603715860cf538df854d047b84 AS builder

# To let GitHub CI driven buildx pass build arguments
ARG TARGETOS=linux
ARG TARGETARCH=amd64

# Set necessary environment variables
ENV CGO_ENABLED=0 \
    GOOS=$TARGETOS \
    GOARCH=$TARGETARCH

# All these steps will be cached
WORKDIR /build
COPY go.mod .
COPY go.sum .

# Get dependencies - will also be cached if we won't change mod/sum
RUN go mod download
# Copy the source code as the last step
COPY . .

# Build the binary
ARG BUILD_REVISION=unreleased
RUN go build -trimpath -buildvcs=false -o /app/kubelet-serving-cert-approver \
      -ldflags "-buildid= -w -s \
        -X github.com/amerged-org/cloudflare-postgres/components/kubelet-serving-approver/build.GitBranch=pgcf-adaptation \
        -X github.com/amerged-org/cloudflare-postgres/components/kubelet-serving-approver/build.GitCommit=$BUILD_REVISION"

# Production image
FROM gcr.io/distroless/static-debian12@sha256:16f75ae7665b13825daffba81f12d6b1a16d0e1217c562fadfce0ba77ca7b891

COPY --from=builder /app/kubelet-serving-cert-approver /app/kubelet-serving-cert-approver

WORKDIR /app

USER 65534:65534

EXPOSE 8080 9090

ENTRYPOINT ["/app/kubelet-serving-cert-approver"]

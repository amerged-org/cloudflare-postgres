module github.com/amerged-org/cloudflare-postgres/apps/node-runtime-observer

go 1.27.1

require (
	github.com/amerged-org/cloudflare-postgres/apps/execution-guard v0.0.0
	github.com/go-logr/logr v1.4.3
	golang.org/x/sys v0.40.0
	google.golang.org/grpc v1.79.3
	k8s.io/cri-api v0.36.3
	k8s.io/cri-client v0.36.3
	k8s.io/klog/v2 v2.140.0
)

replace github.com/amerged-org/cloudflare-postgres/apps/execution-guard => ../execution-guard

require (
	github.com/Microsoft/go-winio v0.6.2 // indirect
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/go-logr/stdr v1.2.2 // indirect
	go.opentelemetry.io/auto/sdk v1.2.1 // indirect
	go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc v0.65.0 // indirect
	go.opentelemetry.io/otel v1.41.0 // indirect
	go.opentelemetry.io/otel/metric v1.41.0 // indirect
	go.opentelemetry.io/otel/trace v1.41.0 // indirect
	golang.org/x/net v0.49.0 // indirect
	golang.org/x/text v0.33.0 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20260128011058-8636f8732409 // indirect
	google.golang.org/protobuf v1.36.12-0.20260120151049-f2248ac996af // indirect
	k8s.io/component-base v0.36.3 // indirect
	k8s.io/utils v0.0.0-20260210185600-b8788abfbbc2 // indirect
)

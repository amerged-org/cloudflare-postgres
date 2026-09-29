// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"github.com/amerged-org/cloudflare-postgres/apps/node-runtime-observer/observer"
	"testing"
	"time"
)

func TestResidentAndObservedSelfIdentityAreBoundToOperatorPod(t *testing.T) {
	scope := observer.Scope{InstallationID: "installation-a", RegionID: "22222222-2222-4222-8222-222222222222", NodeName: "node-a", NodeUID: "33333333-3333-4333-8333-333333333333", ExpectedBootID: "44444444-4444-4444-8444-444444444444"}
	env := map[string]string{"PGCF_OBSERVER_POD_UID": "11111111-1111-4111-8111-111111111111", "PGCF_OBSERVER_NAMESPACE": "pgcf-runtime-observation", "PGCF_OBSERVER_NODE_NAME": "node-a", "PGCF_OBSERVER_INSTALLATION_ID": "installation-a", "PGCF_OBSERVER_REGION_ID": scope.RegionID}
	request := "55555555-5555-4555-8555-555555555555"
	got, err := selfIdentity(scope, request, func(k string) string { return env[k] })
	if err != nil {
		t.Fatalf("valid server-owned identity must be usable: %v", err)
	}
	if got.PodUID != env["PGCF_OBSERVER_POD_UID"] || got.Namespace != env["PGCF_OBSERVER_NAMESPACE"] || got.NodeName != "node-a" {
		t.Fatal("self identity changed")
	}
	env["PGCF_OBSERVER_NODE_NAME"] = "node-b"
	if _, err := selfIdentity(scope, request, func(k string) string { return env[k] }); err == nil {
		t.Fatal("caller arguments cannot override actual scheduling identity")
	}
	env["PGCF_OBSERVER_NODE_NAME"] = "node-a"
	delete(env, "PGCF_OBSERVER_POD_UID")
	if _, err := selfIdentity(scope, request, func(k string) string { return env[k] }); err == nil {
		t.Fatal("no self-owned Pod UID means no transport receipt")
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- resident(ctx, time.Hour) }()
	select {
	case err := <-done:
		t.Fatalf("resident must remain available for exec: %v", err)
	case <-time.After(10 * time.Millisecond):
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("resident cancellation must exit cleanly: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("resident did not terminate on cancellation")
	}
}

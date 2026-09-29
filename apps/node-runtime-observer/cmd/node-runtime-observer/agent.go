// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"errors"
	"flag"
	"io"
	"os"
	"os/signal"
	"regexp"
	"syscall"
	"time"

	"github.com/amerged-org/cloudflare-postgres/apps/node-runtime-observer/observer"
)

type Self struct {
	PodUID    string
	Namespace string
	NodeName  string
}
type Envelope struct {
	Version           int                `json:"version"`
	RequestID         string             `json:"requestId"`
	ObserverPodUID    string             `json:"observerPodUid"`
	ObserverNamespace string             `json:"observerNamespace"`
	ObserverNodeName  string             `json:"observerNodeName"`
	Snapshot          *observer.Snapshot `json:"snapshot"`
}

var uuidPattern = regexp.MustCompile(`^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$`)
var namespacePattern = regexp.MustCompile(`^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$`)

func selfIdentity(scope observer.Scope, requestID string, getenv func(string) string) (Self, error) {
	self := Self{PodUID: getenv("PGCF_OBSERVER_POD_UID"), Namespace: getenv("PGCF_OBSERVER_NAMESPACE"), NodeName: getenv("PGCF_OBSERVER_NODE_NAME")}
	if !uuidPattern.MatchString(requestID) || !uuidPattern.MatchString(self.PodUID) || !namespacePattern.MatchString(self.Namespace) || self.NodeName == "" || self.NodeName != scope.NodeName || getenv("PGCF_OBSERVER_INSTALLATION_ID") != scope.InstallationID || getenv("PGCF_OBSERVER_REGION_ID") != scope.RegionID {
		return Self{}, errors.New("observer_self_identity_unproven")
	}
	return self, nil
}
func resident(ctx context.Context, lifetime time.Duration) error {
	if lifetime < time.Second || lifetime > 24*time.Hour {
		return errors.New("observer_resident_lifetime_invalid")
	}
	timer := time.NewTimer(lifetime)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return nil
	case <-timer.C:
		return nil
	}
}
func runAgent(arguments []string) error {
	flags := flag.NewFlagSet("agent", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	lifetime := flags.Duration("lifetime", 24*time.Hour, "bounded resident lifetime")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("observer_agent_arguments_invalid")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	return resident(ctx, *lifetime)
}

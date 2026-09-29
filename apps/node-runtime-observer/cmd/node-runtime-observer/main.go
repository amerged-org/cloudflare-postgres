// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/amerged-org/cloudflare-postgres/apps/node-runtime-observer/observer"
)

func main() {
	if run() != nil {
		fmt.Fprintln(os.Stderr, `{"status":"incomplete","code":"node_runtime_observation_failed"}`)
		os.Exit(1)
	}
}
func run() error {
	arguments := os.Args[1:]
	if len(arguments) > 0 && arguments[0] == "agent" {
		return runAgent(arguments[1:])
	}
	transport := len(arguments) > 0 && arguments[0] == "observe"
	if transport {
		arguments = arguments[1:]
	}
	args := flag.NewFlagSet("node-runtime-observer", flag.ContinueOnError)
	args.SetOutput(io.Discard)
	requestID := args.String("request-id", "", "transport challenge UUID")
	endpoint := args.String("endpoint", "", "explicit local Unix CRI endpoint")
	installation := args.String("installation-id", "", "installation identity")
	region := args.String("region-id", "", "regional identity")
	node := args.String("node-name", "", "independently verified Kubernetes Node name")
	uid := args.String("node-uid", "", "independently verified Kubernetes Node UID")
	boot := args.String("expected-boot-id", "", "independently verified host boot ID")
	timeout := args.Duration("timeout", 10*time.Second, "whole observation deadline, at most 30 seconds")
	max := args.Int("max-entries", 4096, "combined sandbox/container bound, at most 4096")
	if err := args.Parse(arguments); err != nil {
		return err
	}
	if args.NArg() != 0 {
		return fmt.Errorf("invalid arguments")
	}
	scope := observer.Scope{InstallationID: *installation, RegionID: *region, NodeName: *node, NodeUID: *uid, ExpectedBootID: *boot}
	var self Self
	if transport {
		var err error
		self, err = selfIdentity(scope, *requestID, os.Getenv)
		if err != nil {
			return err
		}
	} else if *requestID != "" {
		return fmt.Errorf("observer_transport_mode_required")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	ctx, deadlineCancel := context.WithTimeout(ctx, *timeout)
	defer deadlineCancel()
	reader, err := observer.Connect(ctx, *endpoint, *timeout)
	if err != nil {
		return err
	}
	collector := observer.Collector{Reader: reader, Scope: scope, BootID: func() (string, error) {
		b, e := os.ReadFile("/proc/sys/kernel/random/boot_id")
		if len(b) > 128 {
			return "", fmt.Errorf("invalid boot id")
		}
		return strings.TrimSpace(string(b)), e
	}, Now: time.Now, Timeout: *timeout, MaxEntries: *max}
	snapshot, err := collector.Collect(ctx)
	if err != nil {
		return err
	}
	if transport {
		return json.NewEncoder(os.Stdout).Encode(Envelope{Version: 1, RequestID: *requestID, ObserverPodUID: self.PodUID, ObserverNamespace: self.Namespace, ObserverNodeName: self.NodeName, Snapshot: snapshot})
	}
	return json.NewEncoder(os.Stdout).Encode(snapshot)
}

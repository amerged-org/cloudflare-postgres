// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
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
	args := flag.NewFlagSet("node-runtime-observer", flag.ContinueOnError)
	args.SetOutput(os.Stderr)
	endpoint := args.String("endpoint", "", "explicit local Unix CRI endpoint")
	installation := args.String("installation-id", "", "installation identity")
	region := args.String("region-id", "", "regional identity")
	node := args.String("node-name", "", "independently verified Kubernetes Node name")
	uid := args.String("node-uid", "", "independently verified Kubernetes Node UID")
	boot := args.String("expected-boot-id", "", "independently verified host boot ID")
	timeout := args.Duration("timeout", 10*time.Second, "whole observation deadline, at most 30 seconds")
	max := args.Int("max-entries", 4096, "combined sandbox/container bound, at most 4096")
	if err := args.Parse(os.Args[1:]); err != nil {
		return err
	}
	if args.NArg() != 0 {
		return fmt.Errorf("invalid arguments")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	ctx, deadlineCancel := context.WithTimeout(ctx, *timeout)
	defer deadlineCancel()
	reader, err := observer.Connect(ctx, *endpoint, *timeout)
	if err != nil {
		return err
	}
	collector := observer.Collector{Reader: reader, Scope: observer.Scope{InstallationID: *installation, RegionID: *region, NodeName: *node, NodeUID: *uid, ExpectedBootID: *boot}, BootID: func() (string, error) {
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
	return json.NewEncoder(os.Stdout).Encode(snapshot)
}

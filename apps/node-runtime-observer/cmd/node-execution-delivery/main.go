// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	guard "github.com/amerged-org/cloudflare-postgres/apps/execution-guard"
	"github.com/amerged-org/cloudflare-postgres/apps/node-runtime-observer/delivery"
	"github.com/amerged-org/cloudflare-postgres/apps/node-runtime-observer/observer"
)

func main() {
	if run() != nil {
		fmt.Fprintln(os.Stderr, `{"status":"incomplete","code":"node_execution_delivery_failed"}`)
		os.Exit(1)
	}
}
func run() error {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if len(os.Args) == 2 && os.Args[1] == "agent" {
		timer := time.NewTimer(24 * time.Hour)
		defer timer.Stop()
		select {
		case <-ctx.Done():
		case <-timer.C:
		}
		return nil
	}
	flags := flag.NewFlagSet("node-execution-delivery", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	endpoint := flags.String("endpoint", "", "operator-selected local CRI Unix endpoint")
	if flags.Parse(os.Args[1:]) != nil || flags.NArg() != 0 || *endpoint == "" {
		return delivery.Incomplete
	}
	ctx, boundedCancel := context.WithTimeout(ctx, 10*time.Second)
	defer boundedCancel()
	input, err := delivery.OwnedPipe(os.Stdin)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := delivery.OwnedPipe(os.Stdout)
	if err != nil {
		return err
	}
	defer output.Close()
	stop, err := delivery.PipeDeadline(ctx, input)
	if err != nil {
		return err
	}
	defer stop()
	if deadline, ok := ctx.Deadline(); !ok || output.SetWriteDeadline(deadline) != nil {
		return delivery.Incomplete
	}
	stopOutput := context.AfterFunc(ctx, func() { _ = output.SetWriteDeadline(time.Now()) })
	defer stopOutput()
	reader, err := observer.Connect(ctx, *endpoint, 5*time.Second)
	if err != nil {
		return delivery.Incomplete
	}
	self := delivery.Self{PodUID: os.Getenv("PGCF_DELIVERY_POD_UID"), Namespace: os.Getenv("PGCF_DELIVERY_NAMESPACE"), NodeName: os.Getenv("PGCF_DELIVERY_NODE_NAME"), InstallationID: os.Getenv("PGCF_DELIVERY_INSTALLATION_ID"), RegionID: os.Getenv("PGCF_DELIVERY_REGION_ID")}
	return delivery.Session(ctx, input, output, self, delivery.Dependencies{Clock: guard.ReadBootClock, Open: func(ctx context.Context, init delivery.Initialization) (delivery.Exchange, error) {
		expected, err := guard.ParseSignedExpected(init.Expected)
		if err != nil {
			return nil, delivery.Incomplete
		}
		b := expected.Binding
		return observer.OpenExecutionExchange(ctx, observer.ExecutionExchangeConfiguration{Resolver: observer.ExecutionMountResolver{Reader: reader, BootID: func() (string, error) { boot, _, err := guard.ReadBootClock(); return boot, err }, ExpectedBootID: init.Scope.ExpectedBootID, Timeout: 5 * time.Second, MaxEntries: 4096}, Pod: init.Pod, KubeletRoot: init.KubeletRoot, PrivateDirectory: init.PrivateDirectory, GuardUID: init.GuardUID, GuardGID: init.GuardGID, Nonce: init.Nonce, Challenge: observer.ExecutionChallengeProjection{InstallationID: b.InstallationID, NamespaceUID: b.NamespaceUID, PodUID: b.PodUID, ContainerName: b.ContainerName, NodeName: b.NodeName, NodeUID: b.NodeUID, BootID: b.BootID, ImageHash: b.ImageHash, CommandHash: b.CommandHash}})
	}})
}

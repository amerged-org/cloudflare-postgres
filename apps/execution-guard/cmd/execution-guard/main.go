// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	guard "github.com/amerged-org/cloudflare-postgres/apps/execution-guard"
)

func main() {
	if run() != nil {
		fmt.Fprintln(os.Stderr, `{"status":"unknown","code":"execution_guard_failed"}`)
		os.Exit(1)
	}
}
func run() error {
	arguments := os.Args[1:]
	if len(arguments) == 1 && arguments[0] == "clock" {
		boot, ns, err := guard.ReadBootClock()
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(map[string]string{"bootId": boot, "bootNs": fmt.Sprint(ns)})
	}
	flags := flag.NewFlagSet("execution-guard", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	path := flags.String("permit-file", "", "protected operator permit")
	runEpoch := flags.String("run-epoch", "", "expected immutable execution epoch")
	grace := flags.Duration("grace", 3*time.Second, "bounded shutdown before hard expiry")
	if flags.Parse(arguments) != nil || *path == "" || *runEpoch == "" || flags.NArg() == 0 {
		return errors.New("invalid")
	}
	file, err := os.Open(*path)
	if err != nil {
		return err
	}
	defer file.Close()
	bytes, err := io.ReadAll(io.LimitReader(file, 4097))
	if err != nil || len(bytes) > 4096 {
		return errors.New("invalid")
	}
	permit, err := guard.ParsePermit(bytes)
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	result, err := guard.Run(ctx, permit, *runEpoch, flags.Args(), *grace)
	if err != nil || !result.Quiescent {
		return errors.New("invalid")
	}
	return nil
}

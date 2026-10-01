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
	if len(arguments) > 0 && arguments[0] == "prepare-inputs" {
		flags := flag.NewFlagSet("prepare-inputs", flag.ContinueOnError)
		flags.SetOutput(io.Discard)
		inputs := flags.String("input-directory", "", "explicit private input child")
		ipc := flags.String("ipc-directory", "", "explicit private IPC child")
		if flags.Parse(arguments[1:]) != nil || flags.NArg() != 0 || *inputs == "" || *ipc == "" {
			return errors.New("invalid")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		type body struct {
			data []byte
			err  error
		}
		ready := make(chan body, 1)
		go func() { data, err := io.ReadAll(io.LimitReader(os.Stdin, 16*1024+1)); ready <- body{data, err} }()
		var input body
		select {
		case input = <-ready:
		case <-ctx.Done():
			_ = os.Stdin.Close()
			return errors.New("invalid")
		}
		if input.err != nil || len(input.data) > 16*1024 {
			return errors.New("invalid")
		}
		result, err := guard.PrepareSignedInputs(ctx, guard.SignedInputConfiguration{InputDirectory: *inputs, IPCDirectory: *ipc, Capsule: input.data})
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"mode": "prepare-inputs", "status": "prepared", "inputs": result})
	}
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
	mode := flags.String("mode", "", "explicit operator-window or signed-window")
	expectedPath := flags.String("expected-file", "", "protected signed workload manifest")
	keyPath := flags.String("public-key-file", "", "protected single public key pin")
	ipcDirectory := flags.String("ipc-directory", "", "existing private handshake directory")
	startup := flags.Duration("startup-timeout", 15*time.Second, "finite signed startup window")
	runEpoch := flags.String("run-epoch", "", "expected immutable execution epoch")
	grace := flags.Duration("grace", 3*time.Second, "bounded shutdown before hard expiry")
	if flags.Parse(arguments) != nil || flags.NArg() == 0 {
		return errors.New("invalid")
	}
	if *mode == "signed-window" {
		if *path != "" || *runEpoch != "" || *expectedPath == "" || *keyPath == "" || *ipcDirectory == "" {
			return errors.New("invalid")
		}
		ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
		defer cancel()
		result, err := guard.RunSigned(ctx, guard.SignedRunConfiguration{ExpectedFile: *expectedPath, PublicKeyFile: *keyPath, IPCDirectory: *ipcDirectory, Command: flags.Args(), Grace: *grace, StartupTimeout: *startup, ReadyWriter: os.Stdout})
		if err != nil || !result.Quiescent {
			return errors.New("invalid")
		}
		return nil
	}
	if *mode != "operator-window" || *path == "" || *runEpoch == "" || *expectedPath != "" || *keyPath != "" || *ipcDirectory != "" {
		return errors.New("invalid")
	}
	if os.Getenv("PGCF_EXECUTION_POD_UID") != "" || os.Getenv("PGCF_EXECUTION_NAMESPACE") != "" || os.Getenv("PGCF_EXECUTION_NODE_NAME") != "" {
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

// SPDX-License-Identifier: Apache-2.0
package executionguard

import (
	"context"
	"errors"
	"path/filepath"
	"time"
)

type Result struct {
	Started   bool
	Forced    bool
	Quiescent bool
}

type processSystem interface {
	pid() int
	clock() (string, int64, error)
	start([]string) (int, error)
	reap(int) (bool, error)
	empty() (bool, error)
	signal(int, int) error
	wait(context.Context, int64) error
}

var failed = errors.New("execution_guard_failed")

func supervise(ctx context.Context, permit Permit, runEpoch string, command []string, grace time.Duration, system processSystem) (Result, error) {
	result := Result{}
	if system.pid() != 1 || len(command) == 0 || !filepath.IsAbs(command[0]) || filepath.Clean(command[0]) != command[0] || grace <= 0 || grace > 10*time.Second || ctx.Err() != nil {
		return result, failed
	}
	boot, now, err := system.clock()
	if err != nil || permit.Validate(boot, runEpoch, now) != nil || permit.ExpiresAtBootNs-now <= int64(grace) {
		return result, failed
	}
	manager, err := system.start(command)
	if err != nil || manager <= 1 {
		return result, failed
	}
	result.Started = true
	stopTimer, cancel := context.WithCancel(context.Background())
	timer := make(chan error, 1)
	go func() { timer <- system.wait(stopTimer, permit.ExpiresAtBootNs-int64(grace)) }()
	defer cancel()
	for {
		exited, reapErr := system.reap(manager)
		if reapErr != nil || exited || ctx.Err() != nil {
			break
		}
		select {
		case <-timer:
			goto stopping
		case <-ctx.Done():
			goto stopping
		case <-time.After(20 * time.Millisecond):
		}
	}
stopping:
	cancel()
	if system.pid() != 1 {
		return result, failed
	}
	if _, err := system.reap(manager); err != nil {
		return result, failed
	}
	if empty, err := system.empty(); err == nil && empty {
		result.Quiescent = true
		return result, nil
	}
	// CNPG handles manager SIGTERM with its existing checkpoint/shutdown path.
	// PostgreSQL and adopted descendants may occupy other process groups.
	_ = system.signal(manager, 15)
	boot, now, err = system.clock()
	hard := permit.ExpiresAtBootNs
	if err != nil || boot != permit.BootID || now >= hard {
		return force(result, manager, system)
	}
	if hard-now > int64(grace) {
		hard = now + int64(grace)
	}
	fast := now + (hard-now)/2
	if system.wait(context.Background(), fast) != nil {
		return force(result, manager, system)
	}
	_, _ = system.reap(manager)
	if empty, err := system.empty(); err == nil && empty {
		result.Quiescent = true
		return result, nil
	}
	// SIGINT requests PostgreSQL fast shutdown across this private namespace.
	_ = system.signal(-1, 2)
	if system.wait(context.Background(), hard) != nil {
		return force(result, manager, system)
	}
	_, _ = system.reap(manager)
	if empty, err := system.empty(); err == nil && empty {
		result.Quiescent = true
		return result, nil
	}
	return force(result, manager, system)
}

func force(result Result, manager int, system processSystem) (Result, error) {
	if system.pid() != 1 {
		return result, failed
	}
	result.Forced = true
	if err := system.signal(-1, 9); err != nil {
		return result, failed
	}
	// Reaping and /proc enumeration both matter: an exec may have an external
	// parent and therefore not appear as a waitable child of namespace PID1.
	for attempt := 0; attempt < 100; attempt++ {
		if _, err := system.reap(manager); err != nil {
			return result, failed
		}
		empty, err := system.empty()
		if err != nil {
			return result, failed
		}
		if empty {
			result.Quiescent = true
			return result, nil
		}
		time.Sleep(10 * time.Millisecond)
	}
	// Returning an error exits container PID1; the kernel kills any survivors.
	return result, failed
}

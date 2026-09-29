// SPDX-License-Identifier: Apache-2.0
package executionguard

import (
	"context"
	"sync"
	"testing"
	"time"
)

type fakeProcesses struct {
	mu       sync.Mutex
	self     int
	boot     string
	now      int64
	started  int
	children int
	signals  [][2]int
}

func (f *fakeProcesses) pid() int { return f.self }
func (f *fakeProcesses) clock() (string, int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.boot, f.now, nil
}
func (f *fakeProcesses) start([]string) (int, error) { f.started++; f.children = 3; return 17, nil }
func (f *fakeProcesses) reap(int) (bool, error)      { return true, nil }
func (f *fakeProcesses) empty() (bool, error)        { return f.children == 0, nil }
func (f *fakeProcesses) signal(pid, sig int) error {
	f.signals = append(f.signals, [2]int{pid, sig})
	if pid == -1 && sig == 9 {
		f.children = 0
	}
	return nil
}
func (f *fakeProcesses) wait(ctx context.Context, until int64) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	f.mu.Lock()
	if until > f.now {
		f.now = until
	}
	f.mu.Unlock()
	return nil
}

func TestManagerExitCannotLeaveAdoptedOrSeparateGroupsUnsupervised(t *testing.T) {
	boot := "11111111-1111-4111-8111-111111111111"
	f := &fakeProcesses{self: 1, boot: boot, now: int64(time.Second)}
	p := Permit{Version: 1, BootID: boot, RunEpoch: "1", NotBeforeBootNs: 0, ExpiresAtBootNs: int64(20 * time.Second)}
	result, err := supervise(context.Background(), p, "1", []string{"/controller/manager", "instance", "run"}, 3*time.Second, f)
	if err != nil || !result.Started || !result.Forced || !result.Quiescent || f.children != 0 {
		t.Fatalf("manager exit must retire all remaining namespace processes: %+v %v", result, err)
	}
	if len(f.signals) < 2 || f.signals[0] != [2]int{17, 15} || f.signals[len(f.signals)-1] != [2]int{-1, 9} {
		t.Fatalf("manager-only group termination is insufficient: %+v", f.signals)
	}
	host := &fakeProcesses{self: 42, boot: boot, now: int64(time.Second)}
	if _, err := supervise(context.Background(), p, "1", []string{"/controller/manager"}, 3*time.Second, host); err == nil || host.started != 0 || len(host.signals) != 0 {
		t.Fatal("non-PID1 execution must never launch or signal namespace processes")
	}
}

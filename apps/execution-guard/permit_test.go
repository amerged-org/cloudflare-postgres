// SPDX-License-Identifier: Apache-2.0
package executionguard

import (
	"context"
	"runtime"
	"testing"
)

func TestPermitBootBindingAndAbsoluteDeadline(t *testing.T) {
	const boot = "11111111-1111-4111-8111-111111111111"
	permit, err := ParsePermit([]byte(`{"version":1,"bootId":"11111111-1111-4111-8111-111111111111","runEpoch":"7","notBeforeBootNs":"100","expiresAtBootNs":"200"}`))
	if err != nil {
		t.Fatalf("valid protected permit must parse: %v", err)
	}
	if permit.BootID != boot || permit.RunEpoch != "7" || permit.NotBeforeBootNs != 100 || permit.ExpiresAtBootNs != 200 {
		t.Fatal("permit changed its exact values")
	}
	if err = permit.Validate(boot, "7", 150); err != nil {
		t.Fatal("current matching boot/run must be admitted")
	}
	if permit.Validate(boot, "7", 200) == nil {
		t.Fatal("absolute expiry cannot restart execution")
	}
	if permit.Validate("22222222-2222-4222-8222-222222222222", "7", 150) == nil {
		t.Fatal("another boot cannot reuse a permit")
	}
	if permit.Validate(boot, "8", 150) == nil {
		t.Fatal("another run cannot reuse a permit")
	}
	if _, err = ParsePermit([]byte(`{"version":1,"bootId":"11111111-1111-4111-8111-111111111111","runEpoch":"7","runEpoch":"8","notBeforeBootNs":"100","expiresAtBootNs":"200"}`)); err == nil {
		t.Fatal("duplicate member cannot override run authority")
	}
	if _, err = ParsePermit([]byte(`{"version":1,"bootId":"11111111-1111-4111-8111-111111111111","runEpoch":"7","notBeforeBootNs":"100","expiresAtBootNs":"200","extra":true}`)); err == nil {
		t.Fatal("unknown field cannot extend permit schema")
	}
	if _, err = ParsePermit([]byte(`{"version":1,"bootId":"11111111-1111-4111-8111-111111111111","runEpoch":"7","notBeforeBootNs":"100","expiresAtBootNs":"200"} {}`)); err == nil {
		t.Fatal("second JSON value cannot be accepted")
	}
	if runtime.GOOS != "linux" {
		if _, _, err = ReadBootClock(); err == nil {
			t.Fatal("unsupported clock must fail closed")
		}
		return
	}
	actual, now, err := ReadBootClock()
	if err != nil || actual == "" || now <= 0 {
		t.Fatal("kernel boot clock unavailable")
	}
	if err = WaitDeadline(context.Background(), now+10_000_000); err != nil {
		t.Fatal("absolute boot deadline failed")
	}
	_, after, err := ReadBootClock()
	if err != nil || after < now+10_000_000 {
		t.Fatal("timer returned before the absolute deadline")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if WaitDeadline(ctx, after+1_000_000_000) == nil {
		t.Fatal("cancelled wait must not claim elapsed expiry")
	}
}

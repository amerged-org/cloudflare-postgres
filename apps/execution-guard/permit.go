// SPDX-License-Identifier: Apache-2.0
package executionguard

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strconv"
)

type Permit struct {
	Version         int
	BootID          string
	RunEpoch        string
	NotBeforeBootNs int64
	ExpiresAtBootNs int64
}

var permitUUID = regexp.MustCompile(`^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$`)
var permitEpoch = regexp.MustCompile(`^[1-9][0-9]{0,18}$`)
var permitDecimal = regexp.MustCompile(`^(?:0|[1-9][0-9]{0,18})$`)
var invalidPermit = errors.New("execution_permit_invalid")

func ParsePermit(data []byte) (Permit, error) {
	if len(data) == 0 || len(data) > 4096 {
		return Permit{}, invalidPermit
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('{') {
		return Permit{}, invalidPermit
	}
	seen := make(map[string]bool, 5)
	var permit Permit
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			return Permit{}, invalidPermit
		}
		name, ok := key.(string)
		if !ok || seen[name] {
			return Permit{}, invalidPermit
		}
		seen[name] = true
		value, err := decoder.Token()
		if err != nil {
			return Permit{}, invalidPermit
		}
		switch name {
		case "version":
			number, ok := value.(json.Number)
			if !ok || number.String() != "1" {
				return Permit{}, invalidPermit
			}
			permit.Version = 1
		case "bootId":
			text, ok := value.(string)
			if !ok || !permitUUID.MatchString(text) {
				return Permit{}, invalidPermit
			}
			permit.BootID = text
		case "runEpoch":
			text, ok := value.(string)
			if !ok || !permitEpoch.MatchString(text) {
				return Permit{}, invalidPermit
			}
			permit.RunEpoch = text
		case "notBeforeBootNs", "expiresAtBootNs":
			text, ok := value.(string)
			if !ok || !permitDecimal.MatchString(text) {
				return Permit{}, invalidPermit
			}
			number, err := strconv.ParseInt(text, 10, 64)
			if err != nil {
				return Permit{}, invalidPermit
			}
			if name == "notBeforeBootNs" {
				permit.NotBeforeBootNs = number
			} else {
				permit.ExpiresAtBootNs = number
			}
		default:
			return Permit{}, invalidPermit
		}
	}
	closing, err := decoder.Token()
	if err != nil || closing != json.Delim('}') || len(seen) != 5 {
		return Permit{}, invalidPermit
	}
	if _, err := decoder.Token(); err != io.EOF {
		return Permit{}, invalidPermit
	}
	if permit.ExpiresAtBootNs <= permit.NotBeforeBootNs || permit.ExpiresAtBootNs-permit.NotBeforeBootNs > 300_000_000_000 {
		return Permit{}, invalidPermit
	}
	return permit, nil
}

func (p Permit) Validate(bootID, runEpoch string, bootNs int64) error {
	if p.Version != 1 || !permitUUID.MatchString(p.BootID) || !permitEpoch.MatchString(p.RunEpoch) ||
		p.NotBeforeBootNs < 0 || p.ExpiresAtBootNs <= p.NotBeforeBootNs || p.ExpiresAtBootNs-p.NotBeforeBootNs > 300_000_000_000 || p.BootID != bootID ||
		p.RunEpoch != runEpoch || bootNs < p.NotBeforeBootNs || bootNs >= p.ExpiresAtBootNs {
		return invalidPermit
	}
	return nil
}

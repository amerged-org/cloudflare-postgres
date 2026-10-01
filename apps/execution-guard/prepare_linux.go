//go:build linux

// SPDX-License-Identifier: Apache-2.0
package executionguard

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

func inputDirectory(path string) (directoryPin, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || path == "/" || realParents(filepath.Dir(path)) != nil {
		return directoryPin{}, failed
	}
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		// Only this explicitly authorized private child may be created. Existing
		// roots and ownership/modes are never repaired or adopted by chmod/chown.
		if os.Mkdir(path, 0700) != nil || syncDirectory(filepath.Dir(path)) != nil {
			return directoryPin{}, failed
		}
	} else if err != nil {
		return directoryPin{}, failed
	}
	return pinDirectory(path)
}
func inputDirectoryIdentity(pin directoryPin) map[string]any {
	return map[string]any{"path": pin.path, "device": pin.device, "inode": pin.inode, "uid": pin.uid, "gid": pin.gid, "mode": pin.mode}
}

// Preparation trusts the external installation's capsule provenance. It reuses
// the guard's exact parser/custody rules, and never produces runtime authority.
func prepareSignedInputs(ctx context.Context, config SignedInputConfiguration) (SignedInputResult, error) {
	if ctx == nil || ctx.Err() != nil || config.InputDirectory == config.IPCDirectory ||
		strings.HasPrefix(config.InputDirectory, config.IPCDirectory+"/") || strings.HasPrefix(config.IPCDirectory, config.InputDirectory+"/") {
		return SignedInputResult{}, failed
	}
	value, err := strictJSON(config.Capsule)
	if err != nil || !exactFields(value, "expected", "publicKeyPin") {
		return SignedInputResult{}, failed
	}
	expectedBytes, err := canonicalJSON(value["expected"])
	if err != nil {
		return SignedInputResult{}, failed
	}
	expected, err := ParseSignedExpected(expectedBytes)
	if err != nil {
		return SignedInputResult{}, failed
	}
	keyBytes, err := canonicalJSON(value["publicKeyPin"])
	if err != nil {
		return SignedInputResult{}, failed
	}
	if _, _, err = ParseSignedKeyPin(keyBytes); err != nil {
		return SignedInputResult{}, failed
	}
	boot, _, err := ReadBootClock()
	if err != nil || boot != expected.Binding.BootID ||
		os.Getenv("PGCF_EXECUTION_POD_UID") != expected.Binding.PodUID ||
		os.Getenv("PGCF_EXECUTION_NAMESPACE") != expected.Binding.Namespace ||
		os.Getenv("PGCF_EXECUTION_NODE_NAME") != expected.Binding.NodeName {
		return SignedInputResult{}, failed
	}
	inputs, err := inputDirectory(config.InputDirectory)
	if err != nil {
		return SignedInputResult{}, failed
	}
	ipc, err := inputDirectory(config.IPCDirectory)
	if err != nil {
		return SignedInputResult{}, failed
	}
	if inputs.device == ipc.device && inputs.inode == ipc.inode {
		return SignedInputResult{}, failed
	}
	expectedHash, keyHash := sha256.Sum256(expectedBytes), sha256.Sum256(keyBytes)
	result := SignedInputResult{ExpectedHash: hex.EncodeToString(expectedHash[:]), PublicKeyHash: hex.EncodeToString(keyHash[:])}
	capsuleBytes, err := canonicalJSON(map[string]any{"version": 1, "expectedHash": result.ExpectedHash,
		"publicKeyHash": result.PublicKeyHash, "inputDirectory": inputDirectoryIdentity(inputs), "ipcDirectory": inputDirectoryIdentity(ipc)})
	if err != nil {
		return SignedInputResult{}, failed
	}
	check := func() error {
		if ctx.Err() != nil || inputs.check() != nil || ipc.check() != nil {
			return failed
		}
		actualBoot, _, err := ReadBootClock()
		if err != nil || actualBoot != expected.Binding.BootID {
			return failed
		}
		return nil
	}
	capsulePath := filepath.Join(config.InputDirectory, "capsule.json")
	original, capsulePin, err := privateFile(capsulePath)
	if errors.Is(err, unix.ENOENT) {
		// Matching input files without original capsule custody are not provenance.
		for _, name := range []string{"expected.json", "key.json"} {
			if _, err := os.Lstat(filepath.Join(config.InputDirectory, name)); !errors.Is(err, os.ErrNotExist) {
				return SignedInputResult{}, failed
			}
		}
		if check() != nil || writeChallenge(capsulePath, capsuleBytes) != nil {
			return SignedInputResult{}, failed
		}
		original, capsulePin, err = privateFile(capsulePath)
	}
	if err != nil || !bytes.Equal(original, capsuleBytes) || check() != nil {
		return SignedInputResult{}, failed
	}
	var files []filePin
	for _, item := range []struct {
		name string
		data []byte
	}{{"expected.json", expectedBytes}, {"key.json", keyBytes}} {
		if check() != nil || capsulePin.check() != nil {
			return SignedInputResult{}, failed
		}
		path := filepath.Join(config.InputDirectory, item.name)
		data, pin, err := privateFile(path)
		if errors.Is(err, unix.ENOENT) {
			// A missing file may be resumed only under the exact durable capsule.
			if writeChallenge(path, item.data) != nil {
				return SignedInputResult{}, failed
			}
			data, pin, err = privateFile(path)
		}
		if err != nil || !bytes.Equal(data, item.data) || pin.check() != nil || capsulePin.check() != nil || check() != nil {
			return SignedInputResult{}, failed
		}
		files = append(files, pin)
	}
	if syncDirectory(config.InputDirectory) != nil || syncDirectory(config.IPCDirectory) != nil || capsulePin.check() != nil || check() != nil {
		return SignedInputResult{}, failed
	}
	for _, pin := range files {
		if pin.check() != nil {
			return SignedInputResult{}, failed
		}
	}
	if check() != nil || capsulePin.check() != nil {
		return SignedInputResult{}, failed
	}
	return result, nil
}

//go:build !linux && !darwin

// SPDX-License-Identifier: Apache-2.0
package delivery

import "os"

func OwnedPipe(*os.File) (*os.File, error) { return nil, Incomplete }

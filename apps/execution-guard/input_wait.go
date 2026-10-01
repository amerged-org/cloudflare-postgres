// SPDX-License-Identifier: Apache-2.0
package executionguard

type signedStartupAnchor struct {
	boot  string
	now   int64
	check func() error
	close func()
}

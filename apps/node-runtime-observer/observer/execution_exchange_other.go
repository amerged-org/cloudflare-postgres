//go:build !linux

// SPDX-License-Identifier: Apache-2.0
package observer

import "context"

type executionExchangePlatform struct{}

func openExecutionExchange(context.Context, ExecutionExchangeConfiguration) (*executionExchangePlatform, error) {
	return nil, ErrExecutionDeliveryIncomplete
}
func (p *executionExchangePlatform) requestBytes() []byte { return nil }
func (p *executionExchangePlatform) close() error         { return nil }
func (p *executionExchangePlatform) publish(context.Context, []byte, func(context.Context) error) (bool, error) {
	return false, ErrExecutionDeliveryIncomplete
}

// SPDX-License-Identifier: Apache-2.0
package observer

import (
	"context"
	"errors"
)

var ErrExecutionDeliveryIncomplete = errors.New("execution_delivery_incomplete")
var ErrExecutionPublicationUncertain = errors.New("execution_publication_uncertain")

// All fields come from the authenticated installation recipe and actual Pod/Node
// projection. Neither host paths nor ownership are selected by a container.
// That recipe must prove a nonroot guard without DAC-bypass capabilities. CRI
// reports initial credentials; it does not prove privilege cannot change later.
type ExecutionChallengeProjection struct {
	InstallationID string
	NamespaceUID   string
	PodUID         string
	ContainerName  string
	NodeName       string
	NodeUID        string
	BootID         string
	ImageHash      string
	CommandHash    string
}

type ExecutionExchangeConfiguration struct {
	Resolver           ExecutionMountResolver
	Pod                ExecutionMountProjection
	KubeletRoot        string
	PrivateDirectory   string
	GuardUID, GuardGID uint32
	Nonce              string
	Challenge          ExecutionChallengeProjection
}

// ExecutionExchange retains original local descriptor/file custody. It is not
// an authorization token. The guard must still authenticate the signed permit.
type ExecutionExchange struct{ platform *executionExchangePlatform }

func OpenExecutionExchange(ctx context.Context, config ExecutionExchangeConfiguration) (*ExecutionExchange, error) {
	p, err := openExecutionExchange(ctx, config)
	if err != nil {
		return nil, err
	}
	return &ExecutionExchange{platform: p}, nil
}
func (e *ExecutionExchange) Request() []byte { return e.platform.requestBytes() }
func (e *ExecutionExchange) Close() error    { return e.platform.close() }

// Publish writes only permit.json. The caller must supply fresh broker/lease
// authorization; this callback is checked again immediately before publication.
// An uncertain error after visibility does not imply that execution was stopped.
func (e *ExecutionExchange) Publish(ctx context.Context, response []byte, authorized func(context.Context) error) (bool, error) {
	return e.platform.publish(ctx, response, authorized)
}

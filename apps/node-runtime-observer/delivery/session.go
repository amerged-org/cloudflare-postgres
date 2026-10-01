// SPDX-License-Identifier: Apache-2.0
package delivery

import (
	"context"
	"encoding/json"
	"errors"
	"io"

	guard "github.com/amerged-org/cloudflare-postgres/apps/execution-guard"
	"github.com/amerged-org/cloudflare-postgres/apps/node-runtime-observer/observer"
)

var Incomplete = errors.New("node_execution_delivery_incomplete")

type Self struct {
	PodUID         string `json:"podUid"`
	Namespace      string `json:"namespace"`
	NodeName       string `json:"nodeName"`
	InstallationID string `json:"installationId"`
	RegionID       string `json:"regionId"`
}
type Initialization struct {
	Version          int                               `json:"version"`
	RequestID        string                            `json:"requestId"`
	Scope            observer.Scope                    `json:"scope"`
	Pod              observer.ExecutionMountProjection `json:"pod"`
	KubeletRoot      string                            `json:"kubeletRoot"`
	PrivateDirectory string                            `json:"privateDirectory"`
	GuardUID         uint32                            `json:"guardUid"`
	GuardGID         uint32                            `json:"guardGid"`
	Nonce            string                            `json:"nonce"`
	Expected         json.RawMessage                   `json:"expected"`
	PublicKeyPin     json.RawMessage                   `json:"publicKeyPin"`
}
type Exchange interface {
	Request() []byte
	Publish(context.Context, []byte, func(context.Context) error) (bool, error)
	Close() error
}
type Dependencies struct {
	Open  func(context.Context, Initialization) (Exchange, error)
	Clock func() (string, int64, error)
}
type Authorization struct {
	Version       int             `json:"version"`
	Type          string          `json:"type"`
	RequestID     string          `json:"requestId"`
	ChallengeHash string          `json:"challengeHash"`
	Permit        json.RawMessage `json:"permit"`
}

func Session(ctx context.Context, input io.Reader, output io.Writer, self Self, deps Dependencies) error {
	return runSession(ctx, input, output, self, deps)
}

func expectedChallenge(init Initialization) ([]byte, error) {
	expected, err := guard.ParseSignedExpected(init.Expected)
	if err != nil {
		return nil, Incomplete
	}
	b := expected.Binding
	return guard.ProtocolJSON(guard.SignedChallenge{Version: 2, Nonce: init.Nonce, Binding: guard.ChallengeBinding{InstallationID: b.InstallationID, NamespaceUID: b.NamespaceUID, PodUID: b.PodUID, ContainerName: b.ContainerName, NodeName: b.NodeName, NodeUID: b.NodeUID, BootID: b.BootID, ImageHash: b.ImageHash, CommandHash: b.CommandHash}})
}

// SPDX-License-Identifier: Apache-2.0
package delivery

import (
	"context"
	"encoding/binary"
	"io"
	"os"
	"time"
	"unicode/utf8"

	guard "github.com/amerged-org/cloudflare-postgres/apps/execution-guard"
)

const MaxFrame = 16 * 1024

func WriteFrame(output io.Writer, value any) error {
	body, err := guard.ProtocolJSON(value)
	if err != nil || len(body) == 0 || len(body) > MaxFrame {
		return Incomplete
	}
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(body)))
	for _, part := range [][]byte{header[:], body} {
		for len(part) > 0 {
			n, err := output.Write(part)
			if err != nil || n <= 0 {
				return Incomplete
			}
			part = part[n:]
		}
	}
	return nil
}
func ReadFrame(input io.Reader) ([]byte, error) {
	var header [4]byte
	if _, err := io.ReadFull(input, header[:]); err != nil {
		return nil, Incomplete
	}
	length := binary.BigEndian.Uint32(header[:])
	if length == 0 || length > MaxFrame {
		return nil, Incomplete
	}
	body := make([]byte, int(length))
	if _, err := io.ReadFull(input, body); err != nil {
		return nil, Incomplete
	}
	if !utf8.Valid(body) {
		return nil, Incomplete
	}
	if _, err := guard.ProtocolObject(body); err != nil {
		return nil, Incomplete
	}
	return body, nil
}

// Exec v4 must keep stdin open through the receipt. A real pipe deadline, not
// EOF or an abandoned read goroutine, bounds each wait.
func PipeDeadline(ctx context.Context, input *os.File) (func(), error) {
	deadline, ok := ctx.Deadline()
	if !ok || ctx.Err() != nil || input == nil || input.SetReadDeadline(deadline) != nil {
		return nil, Incomplete
	}
	stop := context.AfterFunc(ctx, func() { _ = input.SetReadDeadline(time.Now()) })
	return func() { stop() }, nil
}

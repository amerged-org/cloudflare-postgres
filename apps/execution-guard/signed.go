// SPDX-License-Identifier: Apache-2.0
package executionguard

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"io"
	"math"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"time"
	"unicode/utf8"
)

type SignedBinding struct {
	InstallationID       string `json:"installationId"`
	OrganizationID       string `json:"organizationId"`
	ProjectID            string `json:"projectId"`
	RegionID             string `json:"regionId"`
	ReservationID        string `json:"reservationId"`
	ReservationRevision  string `json:"reservationRevision"`
	ReservationEpoch     string `json:"reservationEpoch"`
	OperationID          string `json:"operationId"`
	EnvironmentID        string `json:"environmentId"`
	SpecRevision         int64  `json:"specRevision"`
	SpecHash             string `json:"specHash"`
	RunEpoch             string `json:"runEpoch"`
	Namespace            string `json:"namespace"`
	NamespaceUID         string `json:"namespaceUid"`
	PodUID               string `json:"podUid"`
	ContainerName        string `json:"containerName"`
	NodeName             string `json:"nodeName"`
	NodeUID              string `json:"nodeUid"`
	BootID               string `json:"bootId"`
	ImageHash            string `json:"imageHash"`
	CommandHash          string `json:"commandHash"`
	ResourceEnvelopeHash string `json:"resourceEnvelopeHash"`
}

type SignedExpected struct {
	Version int           `json:"version"`
	Binding SignedBinding `json:"binding"`
	Command []string      `json:"command"`
}

type SignedKeyPin struct {
	Version   int    `json:"version"`
	KeyID     string `json:"keyId"`
	PublicKey string `json:"publicKey"`
}

type SignedRunConfiguration struct {
	ExpectedFile   string
	PublicKeyFile  string
	IPCDirectory   string
	Command        []string
	Grace          time.Duration
	StartupTimeout time.Duration
	ReadyWriter    io.Writer
}

type ChallengeBinding struct {
	InstallationID string `json:"installationId"`
	NamespaceUID   string `json:"namespaceUid"`
	PodUID         string `json:"podUid"`
	ContainerName  string `json:"containerName"`
	NodeName       string `json:"nodeName"`
	NodeUID        string `json:"nodeUid"`
	BootID         string `json:"bootId"`
	ImageHash      string `json:"imageHash"`
	CommandHash    string `json:"commandHash"`
}

type SignedChallenge struct {
	Version int              `json:"version"`
	Nonce   string           `json:"nonce"`
	Binding ChallengeBinding `json:"binding"`
}

type signedExchange func(context.Context, SignedChallenge, string, int64) ([]byte, error)

func runSignedWindow(ctx context.Context, expected SignedExpected, keyID string, key ed25519.PublicKey, command []string, grace, startup time.Duration, exchange signedExchange, system processSystem) (Result, error) {
	permit, err := prepareSignedWindow(ctx, expected, keyID, key, command, grace, startup, exchange, system)
	if err != nil {
		return Result{}, err
	}
	return supervise(ctx, permit, expected.Binding.RunEpoch, command, grace, system)
}

const maxSignedBytes = 16 * 1024
const signedDomain = "cloudflare-postgres/execution-permit/v2\x00"

var signedKeyID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$`)
var signedScope = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
var signedHash = regexp.MustCompile(`^[a-f0-9]{64}$`)
var signedLabel = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
var signedInstant = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$`)

var bindingFields = []string{"installationId", "organizationId", "projectId", "regionId", "reservationId", "reservationRevision", "reservationEpoch", "operationId", "environmentId", "specRevision", "specHash", "runEpoch", "namespace", "namespaceUid", "podUid", "containerName", "nodeName", "nodeUid", "bootId", "imageHash", "commandHash", "resourceEnvelopeHash"}

func exactFields(value map[string]any, fields ...string) bool {
	if len(value) != len(fields) {
		return false
	}
	for _, field := range fields {
		if _, found := value[field]; !found {
			return false
		}
	}
	return true
}
func strictJSON(data []byte) (map[string]any, error) {
	if len(data) == 0 || len(data) > maxSignedBytes || !utf8.Valid(data) {
		return nil, invalidPermit
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	value, err := strictValue(decoder, 0)
	if err != nil {
		return nil, invalidPermit
	}
	if _, err = decoder.Token(); err != io.EOF {
		return nil, invalidPermit
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil, invalidPermit
	}
	return object, nil
}
func strictValue(decoder *json.Decoder, depth int) (any, error) {
	if depth > 4 {
		return nil, invalidPermit
	}
	token, err := decoder.Token()
	if err != nil {
		return nil, invalidPermit
	}
	switch token {
	case json.Delim('{'):
		object := map[string]any{}
		for decoder.More() {
			key, err := decoder.Token()
			if err != nil {
				return nil, invalidPermit
			}
			name, ok := key.(string)
			if !ok || len(object) >= 32 {
				return nil, invalidPermit
			}
			if _, exists := object[name]; exists {
				return nil, invalidPermit
			}
			value, err := strictValue(decoder, depth+1)
			if err != nil {
				return nil, invalidPermit
			}
			object[name] = value
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim('}') {
			return nil, invalidPermit
		}
		return object, nil
	case json.Delim('['):
		array := []any{}
		for decoder.More() {
			if len(array) >= 64 {
				return nil, invalidPermit
			}
			value, err := strictValue(decoder, depth+1)
			if err != nil {
				return nil, invalidPermit
			}
			array = append(array, value)
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim(']') {
			return nil, invalidPermit
		}
		return array, nil
	default:
		switch token.(type) {
		case string, json.Number, bool:
			return token, nil
		}
		return nil, invalidPermit
	}
}
func canonicalJSON(value any) ([]byte, error) {
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	if encoder.Encode(value) != nil {
		return nil, invalidPermit
	}
	return bytes.TrimSuffix(out.Bytes(), []byte{'\n'}), nil
}
func versionTwo(value any) bool {
	number, ok := value.(json.Number)
	return ok && number.String() == "2"
}
func decodeURL(value string, size int) ([]byte, error) {
	data, err := base64.RawURLEncoding.Strict().DecodeString(value)
	if err != nil || len(data) != size || base64.RawURLEncoding.EncodeToString(data) != value {
		return nil, invalidPermit
	}
	return data, nil
}
func validNodeName(value string) bool {
	if len(value) == 0 || len(value) > 253 {
		return false
	}
	for _, part := range bytes.Split([]byte(value), []byte{'.'}) {
		if !signedLabel.Match(part) {
			return false
		}
	}
	return true
}
func validBinding(binding SignedBinding) bool {
	return signedScope.MatchString(binding.InstallationID) &&
		permitUUID.MatchString(binding.OrganizationID) && permitUUID.MatchString(binding.ProjectID) && permitUUID.MatchString(binding.RegionID) &&
		permitUUID.MatchString(binding.ReservationID) && permitDecimal.MatchString(binding.ReservationRevision) && permitDecimal.MatchString(binding.ReservationEpoch) &&
		permitUUID.MatchString(binding.OperationID) && permitUUID.MatchString(binding.EnvironmentID) && binding.SpecRevision > 0 && binding.SpecRevision <= 9007199254740991 &&
		signedHash.MatchString(binding.SpecHash) && permitEpoch.MatchString(binding.RunEpoch) && signedLabel.MatchString(binding.Namespace) &&
		permitUUID.MatchString(binding.NamespaceUID) && permitUUID.MatchString(binding.PodUID) && signedLabel.MatchString(binding.ContainerName) && validNodeName(binding.NodeName) &&
		permitUUID.MatchString(binding.NodeUID) && permitUUID.MatchString(binding.BootID) && signedHash.MatchString(binding.ImageHash) &&
		signedHash.MatchString(binding.CommandHash) && signedHash.MatchString(binding.ResourceEnvelopeHash)
}
func parseBinding(value any) (SignedBinding, error) {
	object, ok := value.(map[string]any)
	if !ok || !exactFields(object, bindingFields...) {
		return SignedBinding{}, invalidPermit
	}
	bytes, err := canonicalJSON(object)
	if err != nil {
		return SignedBinding{}, err
	}
	var binding SignedBinding
	if json.Unmarshal(bytes, &binding) != nil || !validBinding(binding) {
		return SignedBinding{}, invalidPermit
	}
	return binding, nil
}

// CommandHash frames the actual UTF-8 arguments, without shell or JSON escaping.
func CommandHash(command []string) (string, error) {
	if len(command) == 0 || len(command) > 64 || !filepath.IsAbs(command[0]) || filepath.Clean(command[0]) != command[0] {
		return "", invalidPermit
	}
	hash := sha256.New()
	hash.Write([]byte("cloudflare-postgres/execution-command/v2\x00"))
	var size [4]byte
	binary.BigEndian.PutUint32(size[:], uint32(len(command)))
	hash.Write(size[:])
	total := 0
	for _, argument := range command {
		if !utf8.ValidString(argument) || bytes.IndexByte([]byte(argument), 0) >= 0 {
			return "", invalidPermit
		}
		total += len(argument)
		if total > maxSignedBytes {
			return "", invalidPermit
		}
		binary.BigEndian.PutUint32(size[:], uint32(len(argument)))
		hash.Write(size[:])
		hash.Write([]byte(argument))
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
func ParseSignedExpected(data []byte) (SignedExpected, error) {
	value, err := strictJSON(data)
	if err != nil || !exactFields(value, "version", "binding", "command") || !versionTwo(value["version"]) {
		return SignedExpected{}, invalidPermit
	}
	binding, err := parseBinding(value["binding"])
	if err != nil {
		return SignedExpected{}, err
	}
	items, ok := value["command"].([]any)
	if !ok {
		return SignedExpected{}, invalidPermit
	}
	command := make([]string, len(items))
	for index, item := range items {
		command[index], ok = item.(string)
		if !ok {
			return SignedExpected{}, invalidPermit
		}
	}
	hash, err := CommandHash(command)
	if err != nil || hash != binding.CommandHash {
		return SignedExpected{}, invalidPermit
	}
	return SignedExpected{Version: 2, Binding: binding, Command: command}, nil
}
func ParseSignedKeyPin(data []byte) (SignedKeyPin, ed25519.PublicKey, error) {
	value, err := strictJSON(data)
	if err != nil || !exactFields(value, "version", "keyId", "publicKey") || !versionTwo(value["version"]) {
		return SignedKeyPin{}, nil, invalidPermit
	}
	kid, ok := value["keyId"].(string)
	if !ok || !signedKeyID.MatchString(kid) {
		return SignedKeyPin{}, nil, invalidPermit
	}
	encoded, ok := value["publicKey"].(string)
	if !ok {
		return SignedKeyPin{}, nil, invalidPermit
	}
	key, err := decodeURL(encoded, ed25519.PublicKeySize)
	if err != nil {
		return SignedKeyPin{}, nil, err
	}
	return SignedKeyPin{Version: 2, KeyID: kid, PublicKey: encoded}, ed25519.PublicKey(key), nil
}
func signedDuration(response []byte, nonce string, binding SignedBinding, keyID string, key ed25519.PublicKey) (int64, error) {
	outer, err := strictJSON(response)
	if err != nil || !exactFields(outer, "version", "keyId", "payload", "signature") || !versionTwo(outer["version"]) {
		return 0, invalidPermit
	}
	kid, ok := outer["keyId"].(string)
	if !ok || kid != keyID {
		return 0, invalidPermit
	}
	encoded, ok := outer["payload"].(string)
	if !ok {
		return 0, invalidPermit
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	if err != nil || len(raw) > maxSignedBytes || base64.RawURLEncoding.EncodeToString(raw) != encoded {
		return 0, invalidPermit
	}
	encodedSignature, ok := outer["signature"].(string)
	if !ok {
		return 0, invalidPermit
	}
	signature, err := decodeURL(encodedSignature, ed25519.SignatureSize)
	if err != nil {
		return 0, err
	}
	message := append([]byte(signedDomain+keyID+"\x00"), raw...)
	if !ed25519.Verify(key, message, signature) {
		return 0, invalidPermit
	}
	payload, err := strictJSON(raw)
	if err != nil || !exactFields(payload, "version", "nonce", "binding", "durationNs", "issuedAt", "validUntil") || !versionTwo(payload["version"]) {
		return 0, invalidPermit
	}
	canonical, err := canonicalJSON(payload)
	if err != nil || !bytes.Equal(canonical, raw) {
		return 0, invalidPermit
	}
	if payload["nonce"] != nonce {
		return 0, invalidPermit
	}
	received, err := parseBinding(payload["binding"])
	if err != nil || received != binding {
		return 0, invalidPermit
	}
	decimal, ok := payload["durationNs"].(string)
	if !ok || !permitEpoch.MatchString(decimal) {
		return 0, invalidPermit
	}
	duration, err := strconv.ParseInt(decimal, 10, 64)
	if err != nil || duration <= 0 || duration > int64(15*time.Second) {
		return 0, invalidPermit
	}
	issued, ok := payload["issuedAt"].(string)
	if !ok || !signedInstant.MatchString(issued) {
		return 0, invalidPermit
	}
	until, ok := payload["validUntil"].(string)
	if !ok || !signedInstant.MatchString(until) {
		return 0, invalidPermit
	}
	start, err := time.Parse("2006-01-02T15:04:05.000Z", issued)
	if err != nil {
		return 0, invalidPermit
	}
	end, err := time.Parse("2006-01-02T15:04:05.000Z", until)
	if err != nil || end.Sub(start) != time.Duration(duration) {
		return 0, invalidPermit
	}
	return duration, nil
}
func prepareSignedWindow(ctx context.Context, expected SignedExpected, keyID string, key ed25519.PublicKey, command []string, grace, startup time.Duration, exchange signedExchange, system processSystem) (Permit, error) {
	if ctx == nil || ctx.Err() != nil || system == nil || system.pid() != 1 || exchange == nil || expected.Version != 2 || !validBinding(expected.Binding) || !signedKeyID.MatchString(keyID) || len(key) != ed25519.PublicKeySize || grace <= 0 || grace > 10*time.Second || startup <= 0 || startup > 15*time.Second || !reflect.DeepEqual(expected.Command, command) {
		return Permit{}, failed
	}
	hash, err := CommandHash(command)
	if err != nil || hash != expected.Binding.CommandHash {
		return Permit{}, failed
	}
	boot, anchor, err := system.clock()
	if err != nil || anchor < 0 || boot != expected.Binding.BootID || anchor > math.MaxInt64-int64(startup) {
		return Permit{}, failed
	}
	var random [32]byte
	if _, err = rand.Read(random[:]); err != nil {
		return Permit{}, failed
	}
	challenge := SignedChallenge{Version: 2, Nonce: base64.RawURLEncoding.EncodeToString(random[:]), Binding: ChallengeBinding{
		InstallationID: expected.Binding.InstallationID, NamespaceUID: expected.Binding.NamespaceUID, PodUID: expected.Binding.PodUID, ContainerName: expected.Binding.ContainerName,
		NodeName: expected.Binding.NodeName, NodeUID: expected.Binding.NodeUID, BootID: boot, ImageHash: expected.Binding.ImageHash, CommandHash: hash,
	}}
	response, err := exchange(ctx, challenge, boot, anchor+int64(startup))
	if err != nil || ctx.Err() != nil {
		return Permit{}, failed
	}
	duration, err := signedDuration(response, challenge.Nonce, expected.Binding, keyID, key)
	if err != nil || anchor > math.MaxInt64-duration {
		return Permit{}, failed
	}
	afterBoot, now, err := system.clock()
	expiry := anchor + duration
	if err != nil || afterBoot != boot || now < anchor || now >= anchor+int64(startup) || expiry-now <= int64(grace) {
		return Permit{}, failed
	}
	// The v1-shaped value is private to this verified call into the maintained
	// supervisor; no unsigned file is parsed or accepted by the signed lane.
	return Permit{Version: 1, BootID: boot, RunEpoch: expected.Binding.RunEpoch, NotBeforeBootNs: anchor, ExpiresAtBootNs: expiry}, nil
}

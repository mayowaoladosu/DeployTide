package protocol

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const Version = "deploytide.runtime-controller.v1"

const wireTimestampLayout = "2006-01-02T15:04:05.000Z"

type Kind string

const (
	ReleaseCreate     Kind = "release_create"
	ReleaseHealth     Kind = "release_health"
	ReleaseDrain      Kind = "release_drain"
	ReleaseLogs       Kind = "release_logs"
	ClusterHealth     Kind = "cluster_health"
	CertificateRotate Kind = "certificate_rotate"
)

var allowedKinds = map[Kind]struct{}{
	ReleaseCreate: {}, ReleaseHealth: {}, ReleaseDrain: {}, ReleaseLogs: {},
	ClusterHealth: {}, CertificateRotate: {},
}

const (
	maxSafeInteger = int64(9_007_199_254_740_991)
	maxPayloadSize = 1024 * 1024
)

var identifierPattern = regexp.MustCompile(`^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,191}$`)

type Envelope struct {
	Version      string `json:"version"`
	AttemptID    string `json:"attemptId"`
	ClusterID    string `json:"clusterId"`
	Sequence     int64  `json:"sequence"`
	FencingToken int64  `json:"fencingToken"`
	ResourceKey  string `json:"resourceKey"`
	Kind         Kind   `json:"kind"`
	IssuedAt     string `json:"issuedAt"`
	ExpiresAt    string `json:"expiresAt"`
	Payload      string `json:"payload"`
	Signature    string `json:"signature"`
}

func (envelope *Envelope) UnmarshalJSON(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return errors.New("controller envelope must be a JSON object")
	}
	expected := map[string]struct{}{
		"version": {}, "attemptId": {}, "clusterId": {}, "sequence": {},
		"fencingToken": {}, "resourceKey": {}, "kind": {}, "issuedAt": {},
		"expiresAt": {}, "payload": {}, "signature": {},
	}
	seen := make(map[string]struct{}, len(expected))
	for decoder.More() {
		rawKey, err := decoder.Token()
		if err != nil {
			return err
		}
		key, ok := rawKey.(string)
		if !ok {
			return errors.New("controller envelope field name is invalid")
		}
		if _, ok := expected[key]; !ok {
			return fmt.Errorf("controller envelope contains unknown field %q", key)
		}
		if _, duplicate := seen[key]; duplicate {
			return fmt.Errorf("controller envelope field %q is duplicated", key)
		}
		seen[key] = struct{}{}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return err
		}
	}
	closing, err := decoder.Token()
	if err != nil || closing != json.Delim('}') {
		return errors.New("controller envelope is incomplete")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("controller envelope contains trailing data")
		}
		return err
	}
	if len(seen) != len(expected) {
		return errors.New("controller envelope is missing a required field")
	}
	type envelopeAlias Envelope
	var decoded envelopeAlias
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	*envelope = Envelope(decoded)
	return nil
}

func EncodePayload(payload []byte) string {
	return base64.RawURLEncoding.EncodeToString(payload)
}

func DecodePayload(payload string) ([]byte, error) {
	if payload == "" || len(payload) > base64.RawURLEncoding.EncodedLen(maxPayloadSize) {
		return nil, errors.New("controller payload encoding is invalid")
	}
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(payload)
	if err != nil || len(decoded) == 0 || len(decoded) > maxPayloadSize ||
		!utf8.Valid(decoded) || EncodePayload(decoded) != payload {
		return nil, errors.New("controller payload encoding is invalid")
	}
	return decoded, nil
}

func validResourceKey(envelope Envelope) bool {
	switch envelope.Kind {
	case ReleaseCreate, ReleaseHealth, ReleaseDrain, ReleaseLogs:
		return strings.HasPrefix(envelope.ResourceKey, "release:") &&
			identifierPattern.MatchString(strings.TrimPrefix(envelope.ResourceKey, "release:"))
	case ClusterHealth, CertificateRotate:
		return envelope.ResourceKey == "cluster:"+envelope.ClusterID
	default:
		return false
	}
}

func validityWindow(envelope Envelope) (time.Time, time.Time, error) {
	issuedAt, issuedErr := time.Parse(wireTimestampLayout, envelope.IssuedAt)
	expiresAt, expiresErr := time.Parse(wireTimestampLayout, envelope.ExpiresAt)
	if issuedErr != nil || expiresErr != nil ||
		!expiresAt.After(issuedAt) || expiresAt.Sub(issuedAt) > 2*time.Minute {
		return time.Time{}, time.Time{}, errors.New("controller job validity window is invalid")
	}
	return issuedAt, expiresAt, nil
}

func SigningInput(envelope Envelope) ([]byte, error) {
	if envelope.Version != Version ||
		!identifierPattern.MatchString(envelope.AttemptID) ||
		!identifierPattern.MatchString(envelope.ClusterID) ||
		envelope.Sequence <= 0 || envelope.Sequence > maxSafeInteger ||
		envelope.FencingToken <= 0 || envelope.FencingToken > maxSafeInteger {
		return nil, errors.New("controller job identity is invalid")
	}
	if _, ok := allowedKinds[envelope.Kind]; !ok || !validResourceKey(envelope) {
		return nil, errors.New("controller job kind or resource is invalid")
	}
	if _, _, err := validityWindow(envelope); err != nil {
		return nil, err
	}
	payload, err := DecodePayload(envelope.Payload)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(payload)
	return []byte(strings.Join([]string{
		envelope.Version,
		envelope.AttemptID,
		envelope.ClusterID,
		strconv.FormatInt(envelope.Sequence, 10),
		strconv.FormatInt(envelope.FencingToken, 10),
		envelope.ResourceKey,
		string(envelope.Kind),
		envelope.IssuedAt,
		envelope.ExpiresAt,
		hex.EncodeToString(digest[:]),
	}, "\n")), nil
}

func Sign(envelope Envelope, privateKey ed25519.PrivateKey) (Envelope, error) {
	if len(privateKey) != ed25519.PrivateKeySize {
		return Envelope{}, errors.New("controller signing key is invalid")
	}
	input, err := SigningInput(envelope)
	if err != nil {
		return Envelope{}, err
	}
	envelope.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(privateKey, input))
	return envelope, nil
}

func Verify(envelope Envelope, publicKey ed25519.PublicKey, clusterID string, now time.Time) error {
	if len(publicKey) != ed25519.PublicKeySize {
		return errors.New("controller verification key is invalid")
	}
	if envelope.ClusterID != clusterID {
		return errors.New("controller job belongs to another cluster")
	}
	issuedAt, expiresAt, windowErr := validityWindow(envelope)
	if windowErr != nil || issuedAt.After(now.Add(time.Minute)) || !expiresAt.After(now) {
		return errors.New("controller job is outside its validity window")
	}
	input, err := SigningInput(envelope)
	if err != nil {
		return err
	}
	signature, err := base64.RawURLEncoding.Strict().DecodeString(envelope.Signature)
	if err != nil || len(signature) != ed25519.SignatureSize ||
		base64.RawURLEncoding.EncodeToString(signature) != envelope.Signature ||
		!ed25519.Verify(publicKey, input, signature) {
		return errors.New("controller job signature is invalid")
	}
	return nil
}

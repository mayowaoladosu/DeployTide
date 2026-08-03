package protocol_test

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"os"
	"testing"
	"time"

	"github.com/mayowaoladosu/DeployTide/apps/runtime-controller/internal/protocol"
)

type interoperabilityVector struct {
	PrivateKeyPEM         string            `json:"privateKeyPem"`
	PublicKeyPEM          string            `json:"publicKeyPem"`
	PayloadJSON           string            `json:"payloadJson"`
	Envelope              protocol.Envelope `json:"envelope"`
	SigningInputBase64URL string            `json:"signingInputBase64url"`
}

func parsePublicKey(t *testing.T, value string) ed25519.PublicKey {
	t.Helper()
	block, _ := pem.Decode([]byte(value))
	if block == nil {
		t.Fatal("interop public key is not PEM")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	publicKey, ok := parsed.(ed25519.PublicKey)
	if !ok {
		t.Fatal("interop public key is not Ed25519")
	}
	return publicKey
}

func parsePrivateKey(t *testing.T, value string) ed25519.PrivateKey {
	t.Helper()
	block, _ := pem.Decode([]byte(value))
	if block == nil {
		t.Fatal("interop private key is not PEM")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	privateKey, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		t.Fatal("interop private key is not Ed25519")
	}
	return privateKey
}

func TestTypeScriptInteropVectorUsesExactPayloadBytes(t *testing.T) {
	data, err := os.ReadFile("testdata/controller-interop.json")
	if err != nil {
		t.Fatal(err)
	}
	var vector interoperabilityVector
	if err := json.Unmarshal(data, &vector); err != nil {
		t.Fatal(err)
	}
	publicKey := parsePublicKey(t, vector.PublicKeyPEM)
	now := time.Date(2026, time.August, 3, 0, 0, 30, 0, time.UTC)
	if err := protocol.Verify(vector.Envelope, publicKey, vector.Envelope.ClusterID, now); err != nil {
		t.Fatalf("Go rejected the TypeScript signature: %v", err)
	}
	payload, err := protocol.DecodePayload(vector.Envelope.Payload)
	if err != nil {
		t.Fatal(err)
	}
	if string(payload) != vector.PayloadJSON {
		t.Fatalf("payload bytes changed across languages:\nwant %q\n got %q", vector.PayloadJSON, string(payload))
	}
	input, err := protocol.SigningInput(vector.Envelope)
	if err != nil {
		t.Fatal(err)
	}
	if base64.RawURLEncoding.EncodeToString(input) != vector.SigningInputBase64URL {
		t.Fatal("Go and TypeScript produced different signing bytes")
	}
	unsigned := vector.Envelope
	unsigned.Signature = ""
	signed, err := protocol.Sign(unsigned, parsePrivateKey(t, vector.PrivateKeyPEM))
	if err != nil {
		t.Fatal(err)
	}
	if signed.Signature != vector.Envelope.Signature {
		t.Fatalf("Go signature differs from fixed TypeScript signature: %q", signed.Signature)
	}
}

func TestEnvelopeJSONRejectsUnknownAndDuplicateFields(t *testing.T) {
	valid := `{"version":"deploytide.runtime-controller.v1","attemptId":"attempt-a","clusterId":"cluster-a","sequence":1,"fencingToken":1,"resourceKey":"cluster:cluster-a","kind":"cluster_health","issuedAt":"2026-08-03T00:00:00.000Z","expiresAt":"2026-08-03T00:01:00.000Z","payload":"e30","signature":"signature"}`
	for name, encoded := range map[string]string{
		"unknown":   valid[:len(valid)-1] + `,"command":"whoami"}`,
		"duplicate": valid[:len(valid)-1] + `,"payload":"e30"}`,
	} {
		t.Run(name, func(t *testing.T) {
			var envelope protocol.Envelope
			if err := json.Unmarshal([]byte(encoded), &envelope); err == nil {
				t.Fatalf("%s envelope field was accepted", name)
			}
		})
	}
}

package controller_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mayowaoladosu/DeployTide/apps/runtime-controller/internal/controller"
	"github.com/mayowaoladosu/DeployTide/apps/runtime-controller/internal/protocol"
)

type fakeEngine struct {
	creates   int
	createErr error
}

func (engine *fakeEngine) CreateRelease(_ context.Context, request controller.ReleaseCreateRequest, fencingToken int64) (map[string]any, error) {
	engine.creates++
	if engine.createErr != nil {
		return nil, engine.createErr
	}
	return map[string]any{"releaseId": request.ReleaseID, "fencingToken": fencingToken}, nil
}
func (*fakeEngine) ReleaseHealth(context.Context, string) (map[string]any, error) {
	return map[string]any{"health": "healthy"}, nil
}
func (*fakeEngine) DrainRelease(context.Context, string, int) (map[string]any, error) {
	return map[string]any{"drained": true}, nil
}
func (*fakeEngine) ReleaseLogs(context.Context, string, int) (map[string]any, error) {
	return map[string]any{"lines": []string{}}, nil
}
func (*fakeEngine) ClusterHealth(context.Context) (map[string]any, error) {
	return map[string]any{"health": "healthy"}, nil
}

func signedEnvelope(t *testing.T, privateKey ed25519.PrivateKey, clusterID string, attemptID string, sequence int64, fencingToken int64, resourceKey string, payload string) protocol.Envelope {
	t.Helper()
	now := time.Now().UTC()
	envelope, err := protocol.Sign(protocol.Envelope{
		Version: protocol.Version, AttemptID: attemptID, ClusterID: clusterID,
		Sequence: sequence, FencingToken: fencingToken, Kind: protocol.ReleaseCreate,
		ResourceKey: resourceKey,
		IssuedAt:    now.Format("2006-01-02T15:04:05.000Z"), ExpiresAt: now.Add(time.Minute).Format("2006-01-02T15:04:05.000Z"),
		Payload: protocol.EncodePayload([]byte(payload)),
	}, privateKey)
	if err != nil {
		t.Fatal(err)
	}
	return envelope
}

func newController(t *testing.T) (*controller.Controller, ed25519.PrivateKey, *fakeEngine) {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	engine := &fakeEngine{}
	runtimeController, err := controller.New(
		"cluster-a",
		publicKey,
		filepath.Join(t.TempDir(), "state.json"),
		engine,
	)
	if err != nil {
		t.Fatal(err)
	}
	return runtimeController, privateKey, engine
}

func TestControllerExecutesAllowlistedSignedJob(t *testing.T) {
	runtimeController, privateKey, engine := newController(t)
	envelope := signedEnvelope(t, privateKey, "cluster-a", "attempt-1", 1, 10, "release:release-a", `{
		"releaseId":"release-a",
		"imageReference":"fixture:phase4",
		"imageDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"environment":{},
		"containerPort":8080,
		"cpuMillis":100,
		"memoryMb":64
	}`)
	result, err := runtimeController.Handle(context.Background(), envelope)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Succeeded || engine.creates != 1 {
		t.Fatalf("expected one successful create, got result=%+v creates=%d", result, engine.creates)
	}
	if sequence, err := runtimeController.LastSequence(); err != nil || sequence != 0 {
		t.Fatalf("sequence advanced before completion was confirmed: sequence=%d error=%v", sequence, err)
	}
	pending, err := runtimeController.PendingCompletion()
	if err != nil || pending == nil || pending.AttemptID != envelope.AttemptID {
		t.Fatalf("result was not durably pending: pending=%+v error=%v", pending, err)
	}
	if err := runtimeController.ConfirmPending(envelope.AttemptID, envelope.Sequence); err != nil {
		t.Fatal(err)
	}
	if sequence, err := runtimeController.LastSequence(); err != nil || sequence != 1 {
		t.Fatalf("confirmed sequence was not advanced: sequence=%d error=%v", sequence, err)
	}
}

func TestControllerRejectsUnknownPayloadFields(t *testing.T) {
	runtimeController, privateKey, engine := newController(t)
	envelope := signedEnvelope(t, privateKey, "cluster-a", "attempt-unknown", 1, 10, "release:release-a", `{
		"releaseId":"release-a",
		"imageReference":"fixture:phase4",
		"imageDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"environment":{},
		"containerPort":8080,
		"cpuMillis":100,
		"memoryMb":64,
		"command":"sh -c whoami"
	}`)
	result, err := runtimeController.Handle(context.Background(), envelope)
	if err != nil {
		t.Fatal(err)
	}
	if result.Succeeded || result.Retryable || engine.creates != 0 {
		t.Fatalf("unknown command field must be rejected: %+v", result)
	}
}

func TestControllerRejectsResourcesBelowDockerMinimum(t *testing.T) {
	for name, resources := range map[string]string{
		"memory": `"cpuMillis":100,"memoryMb":5`,
		"cpu":    `"cpuMillis":9,"memoryMb":64`,
	} {
		t.Run(name, func(t *testing.T) {
			runtimeController, privateKey, engine := newController(t)
			envelope := signedEnvelope(t, privateKey, "cluster-a", "attempt-low-"+name, 1, 10, "release:release-a", `{
				"releaseId":"release-a",
				"imageReference":"fixture:phase4",
				"imageDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				"environment":{},
				"containerPort":8080,`+resources+`
			}`)
			result, err := runtimeController.Handle(context.Background(), envelope)
			if err != nil || result.Succeeded || result.Retryable || engine.creates != 0 {
				t.Fatalf("sub-minimum resources reached Docker: result=%+v error=%v", result, err)
			}
		})
	}
}

func TestControllerRejectsDuplicateNestedPayloadFields(t *testing.T) {
	runtimeController, privateKey, engine := newController(t)
	envelope := signedEnvelope(t, privateKey, "cluster-a", "attempt-duplicate", 1, 10, "release:release-a", `{
		"releaseId":"release-a",
		"imageReference":"fixture:phase4",
		"imageDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"environment":{"SPECIAL":"first","SPECIAL":"second"},
		"containerPort":8080,
		"cpuMillis":100,
		"memoryMb":64
	}`)
	result, err := runtimeController.Handle(context.Background(), envelope)
	if err != nil || result.Succeeded || result.Retryable || engine.creates != 0 || !strings.Contains(result.Diagnostics, "duplicated") {
		t.Fatalf("duplicate nested field was not rejected permanently: result=%+v error=%v", result, err)
	}
}

func TestControllerRejectsForgedAndCrossClusterJobs(t *testing.T) {
	runtimeController, privateKey, engine := newController(t)
	forged := signedEnvelope(t, privateKey, "cluster-a", "attempt-forged", 1, 10, "release:release-a", `{"releaseId":"release-a"}`)
	forged.Signature = "forged"
	if result, err := runtimeController.Handle(context.Background(), forged); err != nil || result.Succeeded || result.Retryable {
		t.Fatal("forged signature was accepted")
	}
	if err := runtimeController.ConfirmPending(forged.AttemptID, forged.Sequence); err != nil {
		t.Fatal(err)
	}
	if sequence, err := runtimeController.LastSequence(); err != nil || sequence != 0 {
		t.Fatalf("forged sequence advanced trusted state: sequence=%d error=%v", sequence, err)
	}
	otherController, err := controller.New(
		"cluster-a",
		privateKey.Public().(ed25519.PublicKey),
		filepath.Join(t.TempDir(), "cross-cluster-state.json"),
		engine,
	)
	if err != nil {
		t.Fatal(err)
	}
	crossCluster := signedEnvelope(t, privateKey, "cluster-b", "attempt-cross", 2, 11, "release:release-a", `{"releaseId":"release-a"}`)
	if result, err := otherController.Handle(context.Background(), crossCluster); err != nil || result.Succeeded || result.Retryable {
		t.Fatal("cross-cluster job was accepted")
	}
	if engine.creates != 0 {
		t.Fatal("rejected jobs reached the runtime engine")
	}
}

func TestControllerRejectsReplayAndStaleFencing(t *testing.T) {
	runtimeController, privateKey, engine := newController(t)
	first := signedEnvelope(t, privateKey, "cluster-a", "attempt-first", 1, 20, "release:release-a", `{
		"releaseId":"release-a","imageReference":"fixture:phase4",
		"imageDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"environment":{},"containerPort":8080,"cpuMillis":100,"memoryMb":64
	}`)
	if result, err := runtimeController.Handle(context.Background(), first); err != nil || !result.Succeeded {
		t.Fatalf("first job failed: %+v", result)
	}
	if err := runtimeController.ConfirmPending(first.AttemptID, first.Sequence); err != nil {
		t.Fatal(err)
	}
	if result, err := runtimeController.Handle(context.Background(), first); err != nil || result.Succeeded || result.Retryable {
		t.Fatal("replayed sequence was accepted")
	}
	if err := runtimeController.ConfirmPending(first.AttemptID, first.Sequence); err != nil {
		t.Fatal(err)
	}
	staleFence := signedEnvelope(t, privateKey, "cluster-a", "attempt-stale", 2, 19, "release:release-a", `{
		"releaseId":"release-a","imageReference":"fixture:phase4",
		"imageDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"environment":{},"containerPort":8080,"cpuMillis":100,"memoryMb":64
	}`)
	if result, err := runtimeController.Handle(context.Background(), staleFence); err != nil || result.Succeeded || result.Retryable {
		t.Fatal("stale fencing token was accepted")
	}
	if engine.creates != 1 {
		t.Fatalf("expected one engine call, got %d", engine.creates)
	}
}

func TestControllerScopesFencesByProtectedResource(t *testing.T) {
	runtimeController, privateKey, engine := newController(t)
	payload := func(releaseID string) string {
		value, err := json.Marshal(map[string]any{
			"releaseId": releaseID, "imageReference": "fixture:phase4",
			"imageDigest":   "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"environment":   map[string]string{"SPECIAL": "A&B <東京>"},
			"containerPort": 8080, "cpuMillis": 100, "memoryMb": 64,
		})
		if err != nil {
			t.Fatal(err)
		}
		return string(value)
	}
	first := signedEnvelope(t, privateKey, "cluster-a", "attempt-a-20", 1, 20, "release:release-a", payload("release-a"))
	if result, err := runtimeController.Handle(context.Background(), first); err != nil || !result.Succeeded {
		t.Fatalf("first resource failed: result=%+v error=%v", result, err)
	}
	if err := runtimeController.ConfirmPending(first.AttemptID, first.Sequence); err != nil {
		t.Fatal(err)
	}
	second := signedEnvelope(t, privateKey, "cluster-a", "attempt-b-10", 2, 10, "release:release-b", payload("release-b"))
	if result, err := runtimeController.Handle(context.Background(), second); err != nil || !result.Succeeded {
		t.Fatalf("lower fence for another resource was rejected: result=%+v error=%v", result, err)
	}
	if err := runtimeController.ConfirmPending(second.AttemptID, second.Sequence); err != nil {
		t.Fatal(err)
	}
	stale := signedEnvelope(t, privateKey, "cluster-a", "attempt-a-19", 3, 19, "release:release-a", payload("release-a"))
	if result, err := runtimeController.Handle(context.Background(), stale); err != nil || result.Succeeded || result.Retryable {
		t.Fatalf("stale same-resource fence was accepted: result=%+v error=%v", result, err)
	}
	if engine.creates != 2 {
		t.Fatalf("expected two engine calls, got %d", engine.creates)
	}
}

func TestControllerRejectsMalformedBase64WithoutRetry(t *testing.T) {
	runtimeController, privateKey, engine := newController(t)
	now := time.Now().UTC()
	envelope := protocol.Envelope{
		Version: protocol.Version, AttemptID: "attempt-base64", ClusterID: "cluster-a",
		Sequence: 1, FencingToken: 1, ResourceKey: "release:release-a", Kind: protocol.ReleaseCreate,
		IssuedAt: now.Format("2006-01-02T15:04:05.000Z"), ExpiresAt: now.Add(time.Minute).Format("2006-01-02T15:04:05.000Z"),
		Payload: "not+base64",
	}
	_, err := protocol.Sign(envelope, privateKey)
	if err == nil {
		t.Fatal("signing accepted malformed base64 payload")
	}
	envelope.Signature = base64.RawURLEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))
	result, handleErr := runtimeController.Handle(context.Background(), envelope)
	if handleErr != nil || result.Succeeded || result.Retryable || engine.creates != 0 || !strings.Contains(result.Diagnostics, "payload encoding") {
		t.Fatalf("malformed base64 was not rejected permanently: result=%+v error=%v", result, handleErr)
	}
}

func TestControllerMarksEngineFailureRetryable(t *testing.T) {
	runtimeController, privateKey, engine := newController(t)
	engine.createErr = errors.New("docker engine temporarily unavailable")
	envelope := signedEnvelope(t, privateKey, "cluster-a", "attempt-engine", 1, 1, "release:release-a", `{
		"releaseId":"release-a","imageReference":"fixture:phase4",
		"imageDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"environment":{},"containerPort":8080,"cpuMillis":100,"memoryMb":64
	}`)
	result, err := runtimeController.Handle(context.Background(), envelope)
	if err != nil || result.Succeeded || !result.Retryable || engine.creates != 1 {
		t.Fatalf("engine failure was not retryable: result=%+v error=%v", result, err)
	}
}

func TestControllerRejectsUnknownKindAndExpiredWindowWithoutRetry(t *testing.T) {
	for name, mutate := range map[string]func(*protocol.Envelope){
		"unknown-kind": func(envelope *protocol.Envelope) {
			envelope.Kind = protocol.Kind("arbitrary_command")
			envelope.Signature = base64.RawURLEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))
		},
		"expired-window": func(envelope *protocol.Envelope) {
			now := time.Now().UTC()
			envelope.IssuedAt = now.Add(-2 * time.Minute).Format("2006-01-02T15:04:05.000Z")
			envelope.ExpiresAt = now.Add(-time.Minute).Format("2006-01-02T15:04:05.000Z")
		},
	} {
		t.Run(name, func(t *testing.T) {
			runtimeController, privateKey, engine := newController(t)
			envelope := signedEnvelope(t, privateKey, "cluster-a", "attempt-"+name, 1, 1, "release:release-a", `{
				"releaseId":"release-a","imageReference":"fixture:phase4",
				"imageDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				"environment":{},"containerPort":8080,"cpuMillis":100,"memoryMb":64
			}`)
			mutate(&envelope)
			if name == "expired-window" {
				var err error
				envelope, err = protocol.Sign(envelope, privateKey)
				if err != nil {
					t.Fatal(err)
				}
			}
			result, err := runtimeController.Handle(context.Background(), envelope)
			if err != nil || result.Succeeded || result.Retryable || engine.creates != 0 {
				t.Fatalf("invalid protocol envelope was not rejected permanently: result=%+v error=%v", result, err)
			}
		})
	}
}

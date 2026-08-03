package client

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"io"
	"log/slog"
	"path/filepath"
	"testing"
	"time"

	"github.com/mayowaoladosu/DeployTide/apps/runtime-controller/internal/controller"
	"github.com/mayowaoladosu/DeployTide/apps/runtime-controller/internal/protocol"
)

type pollerEngine struct {
	creates int
	health  string
}

func (engine *pollerEngine) CreateRelease(_ context.Context, request controller.ReleaseCreateRequest, fencingToken int64) (map[string]any, error) {
	engine.creates++
	return map[string]any{"releaseId": request.ReleaseID, "fencingToken": fencingToken}, nil
}
func (*pollerEngine) ReleaseHealth(context.Context, string) (map[string]any, error) {
	return map[string]any{"health": "healthy"}, nil
}
func (*pollerEngine) DrainRelease(context.Context, string, int) (map[string]any, error) {
	return map[string]any{"drained": true}, nil
}
func (*pollerEngine) ReleaseLogs(context.Context, string, int) (map[string]any, error) {
	return map[string]any{"lines": []string{}}, nil
}
func (engine *pollerEngine) ClusterHealth(context.Context) (map[string]any, error) {
	return map[string]any{"health": engine.health}, nil
}

type fakeControlPlane struct {
	job              *protocol.Envelope
	nextCalls        int
	ackCalls         int
	completeCalls    int
	heartbeatVersion string
	heartbeatHealth  string
	ackErrors        []error
	completionErrors []error
}

func (plane *fakeControlPlane) NextJob(_ context.Context, afterSequence int64) (*protocol.Envelope, error) {
	plane.nextCalls++
	if plane.job == nil || plane.job.Sequence <= afterSequence {
		return nil, nil
	}
	copy := *plane.job
	return &copy, nil
}

func (plane *fakeControlPlane) Acknowledge(context.Context, protocol.Envelope) error {
	plane.ackCalls++
	if len(plane.ackErrors) == 0 {
		return nil
	}
	err := plane.ackErrors[0]
	plane.ackErrors = plane.ackErrors[1:]
	return err
}

func (plane *fakeControlPlane) Complete(_ context.Context, pending controller.PendingCompletion) error {
	plane.completeCalls++
	if len(plane.completionErrors) == 0 {
		return nil
	}
	err := plane.completionErrors[0]
	plane.completionErrors = plane.completionErrors[1:]
	return err
}

func (plane *fakeControlPlane) Heartbeat(_ context.Context, version, health string) error {
	plane.heartbeatVersion = version
	plane.heartbeatHealth = health
	return nil
}

func pollerFixture(t *testing.T, statePath string, engine *pollerEngine) (*controller.Controller, protocol.Envelope) {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	runtimeController, err := controller.New("cluster-a", publicKey, statePath, engine)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	envelope, err := protocol.Sign(protocol.Envelope{
		Version: protocol.Version, AttemptID: "attempt-1", ClusterID: "cluster-a",
		Sequence: 1, FencingToken: 7, ResourceKey: "release:release-a", Kind: protocol.ReleaseCreate,
		IssuedAt: now.Format("2006-01-02T15:04:05.000Z"), ExpiresAt: now.Add(time.Minute).Format("2006-01-02T15:04:05.000Z"),
		Payload: protocol.EncodePayload([]byte(`{"releaseId":"release-a","imageReference":"fixture:phase4","imageDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","environment":{},"containerPort":8080,"cpuMillis":100,"memoryMb":64}`)),
	}, privateKey)
	if err != nil {
		t.Fatal(err)
	}
	return runtimeController, envelope
}

func TestPollerRetriesPendingCompletionBeforePollingAfterRestart(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "controller-state.json")
	engine := &pollerEngine{health: "healthy"}
	firstController, envelope := pollerFixture(t, statePath, engine)
	firstPlane := &fakeControlPlane{
		job:              &envelope,
		completionErrors: []error{errors.New("completion response was lost")},
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	firstPoller := NewPoller(firstPlane, firstController, "1.0.0", time.Second, logger)
	if err := firstPoller.PollOnce(context.Background()); err == nil {
		t.Fatal("lost completion response did not fail the poll")
	}
	if engine.creates != 1 || firstPlane.completeCalls != 1 {
		t.Fatalf("unexpected first delivery: creates=%d completions=%d", engine.creates, firstPlane.completeCalls)
	}

	restartedController, err := controller.New("cluster-a", firstController.PublicKey(), statePath, engine)
	if err != nil {
		t.Fatal(err)
	}
	restartedPlane := &fakeControlPlane{job: &envelope}
	restartedPoller := NewPoller(restartedPlane, restartedController, "1.0.0", time.Second, logger)
	if err := restartedPoller.PollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if restartedPlane.nextCalls != 0 || restartedPlane.completeCalls != 1 || engine.creates != 1 {
		t.Fatalf("restart did not retry the pending result first: next=%d complete=%d creates=%d", restartedPlane.nextCalls, restartedPlane.completeCalls, engine.creates)
	}
	if sequence, err := restartedController.LastSequence(); err != nil || sequence != envelope.Sequence {
		t.Fatalf("completion confirmation was not persisted: sequence=%d error=%v", sequence, err)
	}
}

func TestPollerHandlesLostAcknowledgementByRedelivery(t *testing.T) {
	engine := &pollerEngine{health: "healthy"}
	runtimeController, envelope := pollerFixture(t, filepath.Join(t.TempDir(), "state.json"), engine)
	plane := &fakeControlPlane{
		job:       &envelope,
		ackErrors: []error{errors.New("acknowledgement response was lost")},
	}
	poller := NewPoller(plane, runtimeController, "1.0.0", time.Second, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := poller.PollOnce(context.Background()); err == nil {
		t.Fatal("lost acknowledgement response did not fail the first poll")
	}
	if engine.creates != 0 {
		t.Fatal("job ran before acknowledgement was confirmed")
	}
	if err := poller.PollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if plane.nextCalls != 2 || plane.ackCalls != 2 || engine.creates != 1 {
		t.Fatalf("acknowledged job was not safely redelivered: next=%d ack=%d creates=%d", plane.nextCalls, plane.ackCalls, engine.creates)
	}
}

func TestHeartbeatReportsVersionAndEngineHealth(t *testing.T) {
	engine := &pollerEngine{health: "degraded"}
	runtimeController, _ := pollerFixture(t, filepath.Join(t.TempDir(), "state.json"), engine)
	plane := &fakeControlPlane{}
	poller := NewPoller(plane, runtimeController, "1.0.0", time.Second, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := poller.HeartbeatOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if plane.heartbeatVersion != "1.0.0" || plane.heartbeatHealth != "degraded" {
		t.Fatalf("heartbeat did not report version and engine health: version=%q health=%q", plane.heartbeatVersion, plane.heartbeatHealth)
	}
}

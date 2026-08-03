package controller

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"github.com/mayowaoladosu/DeployTide/apps/runtime-controller/internal/protocol"
)

type ReleaseCreateRequest struct {
	ReleaseID     string            `json:"releaseId"`
	Image         string            `json:"imageReference"`
	ImageDigest   string            `json:"imageDigest"`
	Environment   map[string]string `json:"environment"`
	ContainerPort int               `json:"containerPort"`
	CPUMillis     int64             `json:"cpuMillis"`
	MemoryMB      int64             `json:"memoryMb"`
}

type ReleaseRequest struct {
	ReleaseID string `json:"releaseId"`
}

type ReleaseDrainRequest struct {
	ReleaseID    string `json:"releaseId"`
	GraceSeconds int    `json:"graceSeconds"`
}

type ReleaseLogsRequest struct {
	ReleaseID string `json:"releaseId"`
	Tail      int    `json:"tail"`
}

type Engine interface {
	CreateRelease(context.Context, ReleaseCreateRequest, int64) (map[string]any, error)
	ReleaseHealth(context.Context, string) (map[string]any, error)
	DrainRelease(context.Context, string, int) (map[string]any, error)
	ReleaseLogs(context.Context, string, int) (map[string]any, error)
	ClusterHealth(context.Context) (map[string]any, error)
}

type Result struct {
	Succeeded   bool           `json:"succeeded"`
	Result      map[string]any `json:"result,omitempty"`
	Retryable   bool           `json:"retryable"`
	Diagnostics string         `json:"diagnostics,omitempty"`
}

type state struct {
	ConfirmedSequence    int64              `json:"confirmedSequence"`
	ResourceFencingToken map[string]int64   `json:"resourceFencingTokens"`
	Pending              *PendingCompletion `json:"pending,omitempty"`
}

type PendingCompletion struct {
	AttemptID       string `json:"attemptId"`
	Sequence        int64  `json:"sequence"`
	FencingToken    int64  `json:"fencingToken"`
	AdvanceSequence bool   `json:"advanceSequence"`
	Result          Result `json:"result"`
}

type Controller struct {
	clusterID string
	publicKey ed25519.PublicKey
	statePath string
	engine    Engine
	now       func() time.Time
	mu        sync.Mutex
	state     state
	loaded    bool
}

var (
	protectedIdentifierPattern = regexp.MustCompile(`^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,191}$`)
	environmentKeyPattern      = regexp.MustCompile(`^[A-Z_][A-Z0-9_]{0,127}$`)
	imageReferencePattern      = regexp.MustCompile(`^[a-z0-9][a-z0-9._/@:-]{0,511}$`)
	imageDigestPattern         = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
)

func New(clusterID string, publicKey ed25519.PublicKey, statePath string, engine Engine) (*Controller, error) {
	if clusterID == "" || len(publicKey) != ed25519.PublicKeySize || statePath == "" || engine == nil {
		return nil, errors.New("controller configuration is incomplete")
	}
	return &Controller{
		clusterID: clusterID,
		publicKey: append(ed25519.PublicKey(nil), publicKey...),
		statePath: statePath,
		engine:    engine,
		now:       time.Now,
	}, nil
}

func (controller *Controller) loadState() error {
	if controller.loaded {
		return nil
	}
	data, err := os.ReadFile(controller.statePath)
	if errors.Is(err, os.ErrNotExist) {
		controller.state.ResourceFencingToken = make(map[string]int64)
		controller.loaded = true
		return nil
	}
	if err != nil {
		return fmt.Errorf("read controller state: %w", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&controller.state); err != nil {
		return fmt.Errorf("decode controller state: %w", err)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return fmt.Errorf("decode controller state: %w", err)
	}
	if controller.state.ConfirmedSequence < 0 {
		return errors.New("decode controller state: confirmed sequence is invalid")
	}
	if controller.state.ResourceFencingToken == nil {
		controller.state.ResourceFencingToken = make(map[string]int64)
	}
	controller.loaded = true
	return nil
}

func cloneState(current state) state {
	fences := make(map[string]int64, len(current.ResourceFencingToken))
	for resourceKey, fencingToken := range current.ResourceFencingToken {
		fences[resourceKey] = fencingToken
	}
	cloned := state{
		ConfirmedSequence:    current.ConfirmedSequence,
		ResourceFencingToken: fences,
	}
	if current.Pending != nil {
		pending := *current.Pending
		cloned.Pending = &pending
	}
	return cloned
}

func (controller *Controller) saveState(next state) error {
	if err := os.MkdirAll(filepath.Dir(controller.statePath), 0o700); err != nil {
		return fmt.Errorf("create controller state directory: %w", err)
	}
	data, err := json.Marshal(next)
	if err != nil {
		return err
	}
	temporary := controller.statePath + ".tmp"
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("open controller state: %w", err)
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		return fmt.Errorf("write controller state: %w", err)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return fmt.Errorf("sync controller state: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("write controller state: %w", err)
	}
	if err := os.Rename(temporary, controller.statePath); err != nil {
		return fmt.Errorf("replace controller state: %w", err)
	}
	controller.state = next
	return nil
}

func (controller *Controller) LastSequence() (int64, error) {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	if err := controller.loadState(); err != nil {
		return 0, err
	}
	return controller.state.ConfirmedSequence, nil
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("controller payload contains trailing data")
		}
		return err
	}
	return nil
}

func validateObjectKeys(payload []byte, expectedKeys ...string) error {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return errors.New("controller payload must be a JSON object")
	}
	expected := make(map[string]struct{}, len(expectedKeys))
	for _, key := range expectedKeys {
		expected[key] = struct{}{}
	}
	seen := make(map[string]struct{}, len(expectedKeys))
	for decoder.More() {
		rawKey, err := decoder.Token()
		if err != nil {
			return err
		}
		key, ok := rawKey.(string)
		if !ok {
			return errors.New("controller payload key is invalid")
		}
		if _, ok := expected[key]; !ok {
			return fmt.Errorf("json: unknown field %q", key)
		}
		if _, duplicate := seen[key]; duplicate {
			return fmt.Errorf("controller payload field %q is duplicated", key)
		}
		seen[key] = struct{}{}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return err
		}
	}
	if token, err = decoder.Token(); err != nil || token != json.Delim('}') {
		return errors.New("controller payload object is incomplete")
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return err
	}
	if len(seen) != len(expected) {
		return errors.New("controller payload is missing a required field")
	}
	return nil
}

func walkJSONValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delimiter {
	case '{':
		seen := make(map[string]struct{})
		for decoder.More() {
			rawKey, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := rawKey.(string)
			if !ok {
				return errors.New("controller payload object key is invalid")
			}
			if _, duplicate := seen[key]; duplicate {
				return fmt.Errorf("controller payload field %q is duplicated", key)
			}
			seen[key] = struct{}{}
			if err := walkJSONValue(decoder); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil || closing != json.Delim('}') {
			return errors.New("controller payload object is incomplete")
		}
	case '[':
		for decoder.More() {
			if err := walkJSONValue(decoder); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil || closing != json.Delim(']') {
			return errors.New("controller payload array is incomplete")
		}
	default:
		return errors.New("controller payload delimiter is invalid")
	}
	return nil
}

func rejectDuplicateJSONKeys(payload []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.UseNumber()
	if err := walkJSONValue(decoder); err != nil {
		return err
	}
	return ensureJSONEOF(decoder)
}

func decodeStrict[T any](payload []byte, expectedKeys ...string) (T, error) {
	var value T
	if err := rejectDuplicateJSONKeys(payload); err != nil {
		return value, err
	}
	if err := validateObjectKeys(payload, expectedKeys...); err != nil {
		return value, err
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return value, err
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return value, err
	}
	return value, nil
}

func validateReleaseCreate(request ReleaseCreateRequest) error {
	const maxSafeInteger = int64(9_007_199_254_740_991)
	if !protectedIdentifierPattern.MatchString(request.ReleaseID) ||
		!imageReferencePattern.MatchString(request.Image) ||
		!imageDigestPattern.MatchString(request.ImageDigest) ||
		request.Environment == nil ||
		request.ContainerPort < 1 || request.ContainerPort > 65535 ||
		request.CPUMillis < 10 || request.CPUMillis > maxSafeInteger ||
		request.MemoryMB < 6 || request.MemoryMB > maxSafeInteger {
		return errors.New("release_create payload contains an invalid value")
	}
	for key, value := range request.Environment {
		if !environmentKeyPattern.MatchString(key) || len([]byte(value)) > 32768 {
			return errors.New("release_create environment entry is invalid")
		}
	}
	return nil
}

func (controller *Controller) PublicKey() ed25519.PublicKey {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	return append(ed25519.PublicKey(nil), controller.publicKey...)
}

func (controller *Controller) PendingCompletion() (*PendingCompletion, error) {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	if err := controller.loadState(); err != nil {
		return nil, err
	}
	if controller.state.Pending == nil {
		return nil, nil
	}
	pending := *controller.state.Pending
	return &pending, nil
}

func (controller *Controller) ConfirmPending(attemptID string, sequence int64) error {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	if err := controller.loadState(); err != nil {
		return err
	}
	if controller.state.Pending == nil ||
		controller.state.Pending.AttemptID != attemptID ||
		controller.state.Pending.Sequence != sequence {
		return errors.New("controller pending completion identity changed")
	}
	next := cloneState(controller.state)
	if controller.state.Pending.AdvanceSequence && sequence > next.ConfirmedSequence {
		next.ConfirmedSequence = sequence
	}
	next.Pending = nil
	return controller.saveState(next)
}

func (controller *Controller) EngineHealth(ctx context.Context) string {
	result, err := controller.engine.ClusterHealth(ctx)
	if err != nil {
		return "unavailable"
	}
	health, _ := result["health"].(string)
	switch health {
	case "healthy", "degraded", "unavailable":
		return health
	default:
		return "unavailable"
	}
}

func (controller *Controller) Handle(ctx context.Context, envelope protocol.Envelope) (Result, error) {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	if err := controller.loadState(); err != nil {
		return Result{}, err
	}
	if controller.state.Pending != nil {
		if controller.state.Pending.AttemptID == envelope.AttemptID &&
			controller.state.Pending.Sequence == envelope.Sequence {
			return controller.state.Pending.Result, nil
		}
		return Result{}, errors.New("controller completion must be confirmed before another job")
	}

	next := cloneState(controller.state)
	completionResult := Result{}
	authenticated := true
	executable := true
	if err := protocol.Verify(envelope, controller.publicKey, controller.clusterID, controller.now()); err != nil {
		completionResult.Diagnostics = err.Error()
		authenticated = false
		executable = false
	} else if envelope.Sequence <= controller.state.ConfirmedSequence {
		completionResult.Diagnostics = "controller job sequence is stale"
		executable = false
	} else if envelope.FencingToken < controller.state.ResourceFencingToken[envelope.ResourceKey] {
		completionResult.Diagnostics = "controller job fencing token is stale for the protected resource"
		executable = false
	}

	var operationResult map[string]any
	var operationErr error
	protocolFailure := false
	if executable {
		payload, decodeErr := protocol.DecodePayload(envelope.Payload)
		if decodeErr != nil {
			operationErr = decodeErr
			protocolFailure = true
		} else {
			switch envelope.Kind {
			case protocol.ReleaseCreate:
				request, err := decodeStrict[ReleaseCreateRequest](payload,
					"releaseId", "imageReference", "imageDigest", "environment",
					"containerPort", "cpuMillis", "memoryMb")
				if err != nil {
					operationErr, protocolFailure = err, true
				} else if err := validateReleaseCreate(request); err != nil {
					operationErr, protocolFailure = err, true
				} else if envelope.ResourceKey != "release:"+request.ReleaseID {
					operationErr, protocolFailure = errors.New("controller resource key does not match the release payload"), true
				} else {
					operationResult, operationErr = controller.engine.CreateRelease(ctx, request, envelope.FencingToken)
				}
			case protocol.ReleaseHealth:
				request, err := decodeStrict[ReleaseRequest](payload, "releaseId")
				if err != nil {
					operationErr, protocolFailure = err, true
				} else if !protectedIdentifierPattern.MatchString(request.ReleaseID) || envelope.ResourceKey != "release:"+request.ReleaseID {
					operationErr, protocolFailure = errors.New("controller resource key does not match the release payload"), true
				} else {
					operationResult, operationErr = controller.engine.ReleaseHealth(ctx, request.ReleaseID)
				}
			case protocol.ReleaseDrain:
				request, err := decodeStrict[ReleaseDrainRequest](payload, "releaseId", "graceSeconds")
				if err != nil {
					operationErr, protocolFailure = err, true
				} else if !protectedIdentifierPattern.MatchString(request.ReleaseID) || request.GraceSeconds < 0 || request.GraceSeconds > 300 || envelope.ResourceKey != "release:"+request.ReleaseID {
					operationErr, protocolFailure = errors.New("controller resource key does not match the release payload"), true
				} else {
					operationResult, operationErr = controller.engine.DrainRelease(ctx, request.ReleaseID, request.GraceSeconds)
				}
			case protocol.ReleaseLogs:
				request, err := decodeStrict[ReleaseLogsRequest](payload, "releaseId", "tail")
				if err != nil {
					operationErr, protocolFailure = err, true
				} else if !protectedIdentifierPattern.MatchString(request.ReleaseID) || request.Tail < 1 || request.Tail > 5000 || envelope.ResourceKey != "release:"+request.ReleaseID {
					operationErr, protocolFailure = errors.New("controller resource key does not match the release payload"), true
				} else {
					operationResult, operationErr = controller.engine.ReleaseLogs(ctx, request.ReleaseID, request.Tail)
				}
			case protocol.ClusterHealth:
				_, err := decodeStrict[struct{}](payload)
				if err != nil {
					operationErr, protocolFailure = err, true
				} else {
					operationResult, operationErr = controller.engine.ClusterHealth(ctx)
				}
			case protocol.CertificateRotate:
				_, err := decodeStrict[struct{}](payload)
				if err != nil {
					operationErr, protocolFailure = err, true
				} else {
					operationResult = map[string]any{"reloadedOnNextPoll": true}
				}
			}
		}
		if !protocolFailure {
			next.ResourceFencingToken[envelope.ResourceKey] = envelope.FencingToken
		}
	}

	if executable {
		if operationErr != nil {
			completionResult = Result{
				Diagnostics: operationErr.Error(),
				Retryable:   !protocolFailure,
			}
		} else {
			completionResult = Result{Succeeded: true, Result: operationResult}
		}
	}
	next.Pending = &PendingCompletion{
		AttemptID: envelope.AttemptID, Sequence: envelope.Sequence,
		FencingToken: envelope.FencingToken, AdvanceSequence: authenticated,
		Result: completionResult,
	}
	if err := controller.saveState(next); err != nil {
		return Result{}, err
	}
	return completionResult, nil
}

package engine

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/mayowaoladosu/DeployTide/apps/runtime-controller/internal/controller"
)

const (
	engineTestDigest            = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	engineTestContainerID       = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	engineTestNetworkID         = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	engineTestNetworkEndpointID = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
	engineTestName              = "deploytide-release-release-a"
	engineTestHostPort          = "49152"
)

type rewriteTransport struct {
	base   http.RoundTripper
	target *url.URL
}

func (transport rewriteTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	cloned := request.Clone(request.Context())
	cloned.URL.Scheme = transport.target.Scheme
	cloned.URL.Host = transport.target.Host
	cloned.Host = transport.target.Host
	return transport.base.RoundTrip(cloned)
}

func testDocker(t *testing.T, handler http.Handler) *Docker {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	target, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	return &Docker{
		client: &http.Client{
			Transport: rewriteTransport{base: server.Client().Transport, target: target},
		},
		apiVersion: "v1.47",
	}
}

func engineReleaseRequest() controller.ReleaseCreateRequest {
	return controller.ReleaseCreateRequest{
		ReleaseID:     "release-a",
		Image:         "registry.example/deploytide/app:immutable-metadata",
		ImageDigest:   engineTestDigest,
		Environment:   map[string]string{"GREETING": "hello"},
		ContainerPort: 8080,
		CPUMillis:     100,
		MemoryMB:      64,
	}
}

func engineContainerInspectPayload(status string, running bool, fencingToken string) []byte {
	payload, _ := json.Marshal(map[string]any{
		"Id":    engineTestContainerID,
		"Name":  "/" + engineTestName,
		"Image": engineTestDigest,
		"State": map[string]any{"Status": status, "Running": running},
		"Config": map[string]any{
			"Image":        engineTestDigest,
			"User":         "65534:65534",
			"ExposedPorts": map[string]any{"8080/tcp": map[string]any{}},
			"Labels": map[string]string{
				"com.deploytide.plane":           "runtime",
				"com.deploytide.release":         "release-a",
				"com.deploytide.image-digest":    engineTestDigest,
				"com.deploytide.fencing-token":   fencingToken,
				"com.deploytide.controller-mode": "typed",
			},
		},
		"HostConfig": map[string]any{
			"NetworkMode": engineTestName,
			"Memory":      64 * 1024 * 1024,
			"NanoCpus":    100 * 1_000_000,
		},
		"NetworkSettings": map[string]any{
			"Ports": map[string]any{
				"8080/tcp": []any{map[string]any{"HostIp": "127.0.0.1", "HostPort": engineTestHostPort}},
			},
			"Networks": map[string]any{
				engineTestName: map[string]any{"NetworkID": engineTestNetworkID, "EndpointID": engineTestNetworkEndpointID},
			},
		},
	})
	return payload
}

func engineNetworkInspectPayload(fencingToken string, withContainer ...bool) []byte {
	containers := map[string]any{}
	if len(withContainer) > 0 && withContainer[0] {
		containers[engineTestContainerID] = map[string]any{"Name": engineTestName}
	}
	payload, _ := json.Marshal(map[string]any{
		"Id":         engineTestNetworkID,
		"Name":       engineTestName,
		"Driver":     "bridge",
		"Scope":      "local",
		"Internal":   false,
		"Attachable": false,
		"Ingress":    false,
		"Options": map[string]string{
			"com.docker.network.bridge.enable_icc":        "false",
			"com.docker.network.bridge.host_binding_ipv4": "127.0.0.1",
		},
		"Labels": map[string]string{
			"com.deploytide.plane":           "runtime",
			"com.deploytide.release":         "release-a",
			"com.deploytide.fencing-token":   fencingToken,
			"com.deploytide.controller-mode": "typed",
		},
		"Containers": containers,
	})
	return payload
}

func recordEngineCall(calls *[]string, request *http.Request) {
	call := request.Method + " " + request.URL.Path
	if request.URL.RawQuery != "" {
		call += "?" + request.URL.RawQuery
	}
	*calls = append(*calls, call)
}

func TestCreateReleaseResolvesAndCreatesByImmutableDigest(t *testing.T) {
	var calls []string
	networkExists := false
	containerExists := false
	containerRunning := false
	docker := testDocker(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		recordEngineCall(&calls, request)
		response.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasPrefix(request.URL.Path, "/v1.47/images/"):
			_, _ = response.Write([]byte(`{"Id":"` + engineTestDigest + `"}`))
		case strings.HasPrefix(request.URL.Path, "/v1.47/containers/") && strings.HasSuffix(request.URL.Path, "/json"):
			if containerExists {
				_, _ = response.Write(engineContainerInspectPayload("running", containerRunning, "17"))
				return
			}
			response.WriteHeader(http.StatusNotFound)
			_, _ = response.Write([]byte(`{"message":"not found"}`))
		case strings.HasPrefix(request.URL.Path, "/v1.47/networks/") && request.Method == http.MethodGet:
			if networkExists {
				_, _ = response.Write(engineNetworkInspectPayload("17", containerExists))
				return
			}
			response.WriteHeader(http.StatusNotFound)
			_, _ = response.Write([]byte(`{"message":"not found"}`))
		case request.URL.Path == "/v1.47/networks/create":
			payload, err := io.ReadAll(request.Body)
			if err != nil {
				t.Fatal(err)
			}
			var created map[string]any
			if err := json.Unmarshal(payload, &created); err != nil {
				t.Fatal(err)
			}
			if created["Name"] != engineTestName || created["Driver"] != "bridge" || created["CheckDuplicate"] != true ||
				created["Internal"] != false || created["Attachable"] != false || created["Ingress"] != false {
				t.Fatalf("network create was not typed: %+v", created)
			}
			options := created["Options"].(map[string]any)
			if options["com.docker.network.bridge.enable_icc"] != "false" ||
				options["com.docker.network.bridge.host_binding_ipv4"] != "127.0.0.1" {
				t.Fatalf("network isolation options are unsafe: %+v", options)
			}
			labels := created["Labels"].(map[string]any)
			if len(labels) != 4 || labels["com.deploytide.plane"] != "runtime" ||
				labels["com.deploytide.release"] != "release-a" ||
				labels["com.deploytide.fencing-token"] != "17" ||
				labels["com.deploytide.controller-mode"] != "typed" {
				t.Fatalf("network ownership labels are not exact: %+v", labels)
			}
			networkExists = true
			_, _ = response.Write([]byte(`{"Id":"` + engineTestNetworkID + `"}`))
		case request.URL.Path == "/v1.47/containers/create":
			payload, err := io.ReadAll(request.Body)
			if err != nil {
				t.Fatal(err)
			}
			var created map[string]any
			if err := json.Unmarshal(payload, &created); err != nil {
				t.Fatal(err)
			}
			if created["Image"] != engineTestDigest {
				t.Fatalf("container was not created by digest: %v", created["Image"])
			}
			labels := created["Labels"].(map[string]any)
			if labels["com.deploytide.image-digest"] != engineTestDigest {
				t.Fatal("immutable image ownership label is missing")
			}
			host := created["HostConfig"].(map[string]any)
			if host["NetworkMode"] != engineTestName || host["PublishAllPorts"] != false {
				t.Fatalf("container was not isolated on its release network: %+v", host)
			}
			bindings := host["PortBindings"].(map[string]any)["8080/tcp"].([]any)
			binding := bindings[0].(map[string]any)
			if binding["HostIp"] != "127.0.0.1" || binding["HostPort"] != "" {
				t.Fatalf("container binding was not loopback ephemeral: %+v", binding)
			}
			containerExists = true
			_, _ = response.Write([]byte(`{"Id":"` + engineTestContainerID + `"}`))
		case strings.HasSuffix(request.URL.Path, "/start"):
			containerRunning = true
			response.WriteHeader(http.StatusNoContent)
		default:
			response.WriteHeader(http.StatusNoContent)
		}
	}))

	result, err := docker.CreateRelease(context.Background(), engineReleaseRequest(), 17)
	if err != nil {
		t.Fatal(err)
	}
	if result["runtimePlacementReference"] != engineTestContainerID {
		t.Fatalf("unexpected placement result: %+v", result)
	}
	if result["endpoint"] != "http://127.0.0.1:"+engineTestHostPort || result["imageDigest"] != engineTestDigest {
		t.Fatalf("result was not derived from safe inspect data: %+v", result)
	}
	expected := []string{
		"GET /v1.47/images/" + engineTestDigest + "/json",
		"GET /v1.47/containers/" + engineTestName + "/json",
		"GET /v1.47/networks/" + engineTestName,
		"POST /v1.47/networks/create",
		"GET /v1.47/networks/" + engineTestNetworkID,
		"POST /v1.47/containers/create?name=" + engineTestName,
		"POST /v1.47/containers/" + engineTestContainerID + "/start",
		"GET /v1.47/containers/" + engineTestContainerID + "/json",
		"GET /v1.47/networks/" + engineTestNetworkID,
	}
	if len(calls) != len(expected) {
		t.Fatalf("unexpected Docker calls: %v", calls)
	}
	for index, want := range expected {
		if calls[index] != want {
			t.Fatalf("Docker call %d: want %q, got %q", index, want, calls[index])
		}
	}
}

func TestDrainReleaseRemovesContainerVolumesThenOwnedNetwork(t *testing.T) {
	var calls []string
	containerExists := true
	networkExists := true
	docker := testDocker(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		recordEngineCall(&calls, request)
		response.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasPrefix(request.URL.Path, "/v1.47/containers/") && strings.HasSuffix(request.URL.Path, "/json"):
			if !containerExists {
				response.WriteHeader(http.StatusNotFound)
				_, _ = response.Write([]byte(`{"message":"not found"}`))
				return
			}
			_, _ = response.Write(engineContainerInspectPayload("running", true, "17"))
		case strings.HasPrefix(request.URL.Path, "/v1.47/networks/") && request.Method == http.MethodGet:
			if !networkExists {
				response.WriteHeader(http.StatusNotFound)
				_, _ = response.Write([]byte(`{"message":"not found"}`))
				return
			}
			_, _ = response.Write(engineNetworkInspectPayload("17", containerExists))
		case strings.HasPrefix(request.URL.Path, "/v1.47/containers/") && request.Method == http.MethodDelete:
			containerExists = false
			response.WriteHeader(http.StatusNoContent)
		case strings.HasPrefix(request.URL.Path, "/v1.47/networks/") && request.Method == http.MethodDelete:
			networkExists = false
			response.WriteHeader(http.StatusNoContent)
		default:
			response.WriteHeader(http.StatusNoContent)
		}
	}))

	result, err := docker.DrainRelease(context.Background(), "release-a", 300)
	if err != nil || result["drained"] != true {
		t.Fatalf("drain failed: result=%+v error=%v", result, err)
	}
	expected := []string{
		"GET /v1.47/containers/" + engineTestName + "/json",
		"POST /v1.47/containers/" + engineTestContainerID + "/stop?t=25",
		"DELETE /v1.47/containers/" + engineTestContainerID + "?force=true&v=true",
		"GET /v1.47/containers/" + engineTestName + "/json",
		"GET /v1.47/networks/" + engineTestName,
		"DELETE /v1.47/networks/" + engineTestNetworkID,
		"GET /v1.47/networks/" + engineTestName,
	}
	if len(calls) != len(expected) {
		t.Fatalf("unexpected Docker calls: %v", calls)
	}
	for index, want := range expected {
		if calls[index] != want {
			t.Fatalf("Docker call %d: want %q, got %q", index, want, calls[index])
		}
	}
}

func TestCreateReleaseSameFenceStartsCreatedPlacementAndReinspects(t *testing.T) {
	var calls []string
	running := false
	docker := testDocker(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		recordEngineCall(&calls, request)
		response.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasPrefix(request.URL.Path, "/v1.47/images/"):
			_, _ = response.Write([]byte(`{"Id":"` + engineTestDigest + `"}`))
		case strings.HasPrefix(request.URL.Path, "/v1.47/containers/") && strings.HasSuffix(request.URL.Path, "/json"):
			status := "created"
			if running {
				status = "running"
			}
			_, _ = response.Write(engineContainerInspectPayload(status, running, "17"))
		case strings.HasPrefix(request.URL.Path, "/v1.47/networks/"):
			_, _ = response.Write(engineNetworkInspectPayload("17", true))
		case strings.HasSuffix(request.URL.Path, "/start"):
			running = true
			response.WriteHeader(http.StatusNoContent)
		default:
			t.Fatalf("unexpected mutating retry call: %s %s", request.Method, request.URL.String())
		}
	}))

	result, err := docker.CreateRelease(context.Background(), engineReleaseRequest(), 17)
	if err != nil || result["endpoint"] != "http://127.0.0.1:"+engineTestHostPort ||
		result["runtimePlacementReference"] != engineTestContainerID || result["imageDigest"] != engineTestDigest {
		t.Fatalf("same-fence retry did not start safely: result=%+v error=%v", result, err)
	}
	expected := []string{
		"GET /v1.47/images/" + engineTestDigest + "/json",
		"GET /v1.47/containers/" + engineTestName + "/json",
		"GET /v1.47/networks/" + engineTestName,
		"POST /v1.47/containers/" + engineTestContainerID + "/start",
		"GET /v1.47/containers/" + engineTestContainerID + "/json",
		"GET /v1.47/networks/" + engineTestNetworkID,
	}
	if strings.Join(calls, "\n") != strings.Join(expected, "\n") {
		t.Fatalf("unexpected retry sequence: %v", calls)
	}
}

func TestCreateReleaseRejectsDifferentFenceWithoutMutation(t *testing.T) {
	var calls []string
	docker := testDocker(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		recordEngineCall(&calls, request)
		response.Header().Set("Content-Type", "application/json")
		if strings.HasPrefix(request.URL.Path, "/v1.47/images/") {
			_, _ = response.Write([]byte(`{"Id":"` + engineTestDigest + `"}`))
			return
		}
		if strings.HasSuffix(request.URL.Path, "/json") {
			_, _ = response.Write(engineContainerInspectPayload("running", true, "18"))
			return
		}
		t.Fatalf("different-fence retry mutated Docker: %s %s", request.Method, request.URL.String())
	}))

	result, err := docker.CreateRelease(context.Background(), engineReleaseRequest(), 17)
	if err == nil || result != nil || !strings.Contains(err.Error(), "another fencing token") {
		t.Fatalf("different fence was not rejected: result=%+v error=%v", result, err)
	}
	if len(calls) != 2 {
		t.Fatalf("different-fence retry made unexpected calls: %v", calls)
	}
}

func TestCreateReleaseStartFailureCleansContainerAndNetwork(t *testing.T) {
	var calls []string
	networkExists := false
	containerExists := false
	docker := testDocker(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		recordEngineCall(&calls, request)
		response.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasPrefix(request.URL.Path, "/v1.47/images/"):
			_, _ = response.Write([]byte(`{"Id":"` + engineTestDigest + `"}`))
		case strings.HasPrefix(request.URL.Path, "/v1.47/containers/") && strings.HasSuffix(request.URL.Path, "/json"):
			if !containerExists {
				response.WriteHeader(http.StatusNotFound)
				_, _ = response.Write([]byte(`{"message":"not found"}`))
				return
			}
			_, _ = response.Write(engineContainerInspectPayload("created", false, "17"))
		case strings.HasPrefix(request.URL.Path, "/v1.47/networks/") && request.Method == http.MethodGet:
			if !networkExists {
				response.WriteHeader(http.StatusNotFound)
				_, _ = response.Write([]byte(`{"message":"not found"}`))
				return
			}
			_, _ = response.Write(engineNetworkInspectPayload("17", containerExists))
		case request.URL.Path == "/v1.47/networks/create":
			networkExists = true
			_, _ = response.Write([]byte(`{"Id":"` + engineTestNetworkID + `"}`))
		case request.URL.Path == "/v1.47/containers/create":
			containerExists = true
			_, _ = response.Write([]byte(`{"Id":"` + engineTestContainerID + `"}`))
		case strings.HasSuffix(request.URL.Path, "/start"):
			response.WriteHeader(http.StatusInternalServerError)
			_, _ = response.Write([]byte(`{"message":"start failed"}`))
		case strings.HasPrefix(request.URL.Path, "/v1.47/containers/") && request.Method == http.MethodDelete:
			containerExists = false
			response.WriteHeader(http.StatusNoContent)
		case strings.HasPrefix(request.URL.Path, "/v1.47/networks/") && request.Method == http.MethodDelete:
			networkExists = false
			response.WriteHeader(http.StatusNoContent)
		default:
			response.WriteHeader(http.StatusNoContent)
		}
	}))

	result, err := docker.CreateRelease(context.Background(), engineReleaseRequest(), 17)
	if err == nil || result != nil || containerExists || networkExists {
		t.Fatalf("start failure was not fully cleaned: result=%+v error=%v container=%v network=%v", result, err, containerExists, networkExists)
	}
	joined := strings.Join(calls, "\n")
	for _, expected := range []string{
		"DELETE /v1.47/containers/" + engineTestContainerID + "?force=true&v=true",
		"GET /v1.47/containers/" + engineTestName + "/json",
		"DELETE /v1.47/networks/" + engineTestNetworkID,
		"GET /v1.47/networks/" + engineTestName,
	} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("cleanup call %q was missing: %v", expected, calls)
		}
	}
}

func TestCreateReleaseContainerCreateFailureRemovesNetwork(t *testing.T) {
	var calls []string
	networkExists := false
	docker := testDocker(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		recordEngineCall(&calls, request)
		response.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasPrefix(request.URL.Path, "/v1.47/images/"):
			_, _ = response.Write([]byte(`{"Id":"` + engineTestDigest + `"}`))
		case strings.HasPrefix(request.URL.Path, "/v1.47/containers/") && strings.HasSuffix(request.URL.Path, "/json"):
			response.WriteHeader(http.StatusNotFound)
			_, _ = response.Write([]byte(`{"message":"not found"}`))
		case strings.HasPrefix(request.URL.Path, "/v1.47/networks/") && request.Method == http.MethodGet:
			if !networkExists {
				response.WriteHeader(http.StatusNotFound)
				_, _ = response.Write([]byte(`{"message":"not found"}`))
				return
			}
			_, _ = response.Write(engineNetworkInspectPayload("17"))
		case request.URL.Path == "/v1.47/networks/create":
			networkExists = true
			_, _ = response.Write([]byte(`{"Id":"` + engineTestNetworkID + `"}`))
		case request.URL.Path == "/v1.47/containers/create":
			response.WriteHeader(http.StatusInternalServerError)
			_, _ = response.Write([]byte(`{"message":"create failed"}`))
		case strings.HasPrefix(request.URL.Path, "/v1.47/networks/") && request.Method == http.MethodDelete:
			networkExists = false
			response.WriteHeader(http.StatusNoContent)
		default:
			response.WriteHeader(http.StatusNoContent)
		}
	}))

	result, err := docker.CreateRelease(context.Background(), engineReleaseRequest(), 17)
	if err == nil || result != nil || networkExists {
		t.Fatalf("container create failure left a network: result=%+v error=%v network=%v", result, err, networkExists)
	}
	joined := strings.Join(calls, "\n")
	for _, expected := range []string{
		"POST /v1.47/networks/create",
		"POST /v1.47/containers/create?name=" + engineTestName,
		"DELETE /v1.47/networks/" + engineTestNetworkID,
		"GET /v1.47/networks/" + engineTestName,
	} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("container-create cleanup call %q was missing: %v", expected, calls)
		}
	}
}

func TestDrainReleaseObservesMissingContainerAndNetwork(t *testing.T) {
	var calls []string
	docker := testDocker(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		recordEngineCall(&calls, request)
		response.Header().Set("Content-Type", "application/json")
		response.WriteHeader(http.StatusNotFound)
		_, _ = response.Write([]byte(`{"message":"not found"}`))
	}))
	result, err := docker.DrainRelease(context.Background(), "release-a", 0)
	if err != nil || result["drained"] != true {
		t.Fatalf("missing release drain was not idempotent: result=%+v error=%v", result, err)
	}
	expected := []string{
		"GET /v1.47/containers/" + engineTestName + "/json",
		"GET /v1.47/networks/" + engineTestName,
	}
	if strings.Join(calls, "\n") != strings.Join(expected, "\n") {
		t.Fatalf("missing resources were not observed explicitly: %v", calls)
	}
}

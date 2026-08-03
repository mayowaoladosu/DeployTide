package dockerproxy

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
)

const (
	testContainerID       = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	testDigest            = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	testNetworkID         = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	testNetworkEndpointID = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
	testName              = "deploytide-release-release-a"
	testHostPort          = "49152"
)

type recordedUpstream struct {
	mu       sync.Mutex
	requests []string
}

func (record *recordedUpstream) add(request *http.Request) {
	record.mu.Lock()
	defer record.mu.Unlock()
	target := request.Method + " " + request.URL.Path
	if request.URL.RawQuery != "" {
		target += "?" + request.URL.RawQuery
	}
	record.requests = append(record.requests, target)
}

func (record *recordedUpstream) count() int {
	record.mu.Lock()
	defer record.mu.Unlock()
	return len(record.requests)
}

func ownedInspectPayloadForState(status string, running bool) []byte {
	endpointID := ""
	ports := map[string]any{"8080/tcp": nil}
	if running {
		endpointID = testNetworkEndpointID
		ports["8080/tcp"] = []any{map[string]any{"HostIp": "127.0.0.1", "HostPort": testHostPort}}
	}
	payload, _ := json.Marshal(map[string]any{
		"Id":    testContainerID,
		"Name":  "/" + testName,
		"Image": testDigest,
		"Config": map[string]any{
			"Image":        testDigest,
			"User":         "65534:65534",
			"ExposedPorts": map[string]any{"8080/tcp": map[string]any{}},
			"Volumes":      map[string]any{},
			"Labels": map[string]string{
				"com.deploytide.plane":           "runtime",
				"com.deploytide.release":         "release-a",
				"com.deploytide.image-digest":    testDigest,
				"com.deploytide.fencing-token":   "17",
				"com.deploytide.controller-mode": "typed",
			},
		},
		"HostConfig": map[string]any{
			"AutoRemove":      false,
			"Privileged":      false,
			"ReadonlyRootfs":  true,
			"Binds":           nil,
			"CapAdd":          nil,
			"CapDrop":         []string{"ALL"},
			"SecurityOpt":     []string{"no-new-privileges"},
			"PidsLimit":       128,
			"Memory":          64 * 1024 * 1024,
			"NanoCpus":        100 * 1_000_000,
			"NetworkMode":     testName,
			"PortBindings":    map[string]any{"8080/tcp": []any{map[string]any{"HostIp": "127.0.0.1", "HostPort": ""}}},
			"PublishAllPorts": false,
			"Tmpfs":           map[string]string{"/tmp": "rw,nosuid,nodev,noexec,size=32m,uid=65534,gid=65534"},
			"Devices":         nil,
			"DeviceRequests":  nil,
			"VolumesFrom":     nil,
			"RestartPolicy":   map[string]any{"Name": "no", "MaximumRetryCount": 0},
		},
		"NetworkSettings": map[string]any{
			"Ports": ports,
			"Networks": map[string]any{
				testName: map[string]any{"NetworkID": testNetworkID, "EndpointID": endpointID},
			},
		},
		"Mounts": []any{},
		"State":  map[string]any{"Status": status, "Running": running},
	})
	return payload
}

func ownedInspectPayload() []byte {
	return ownedInspectPayloadForState("running", true)
}

func ownedNetworkPayload(withContainer bool) []byte {
	containers := map[string]any{}
	if withContainer {
		containers[testContainerID] = map[string]any{
			"Name":       testName,
			"EndpointID": testNetworkEndpointID,
		}
	}
	payload, _ := json.Marshal(map[string]any{
		"Id":         testNetworkID,
		"Name":       testName,
		"Driver":     "bridge",
		"Scope":      "local",
		"Internal":   false,
		"Attachable": false,
		"Ingress":    false,
		"ConfigOnly": false,
		"Options": map[string]string{
			"com.docker.network.bridge.enable_icc":        "false",
			"com.docker.network.bridge.host_binding_ipv4": "127.0.0.1",
		},
		"Labels": map[string]string{
			"com.deploytide.plane":           "runtime",
			"com.deploytide.release":         "release-a",
			"com.deploytide.fencing-token":   "17",
			"com.deploytide.controller-mode": "typed",
		},
		"Containers": containers,
	})
	return payload
}

func validNetworkCreatePayload() []byte {
	payload, _ := json.Marshal(networkCreateRequest{
		Name:           testName,
		CheckDuplicate: true,
		Driver:         "bridge",
		Internal:       false,
		Attachable:     false,
		Ingress:        false,
		Options: map[string]string{
			"com.docker.network.bridge.enable_icc":        "false",
			"com.docker.network.bridge.host_binding_ipv4": "127.0.0.1",
		},
		Labels: map[string]string{
			"com.deploytide.plane":           "runtime",
			"com.deploytide.release":         "release-a",
			"com.deploytide.fencing-token":   "17",
			"com.deploytide.controller-mode": "typed",
		},
	})
	return payload
}

func validCreatePayload() []byte {
	payload, _ := json.Marshal(createRequest{
		Image: testDigest,
		User:  "65534:65534",
		Env:   []string{"GREETING=hello"},
		Labels: map[string]string{
			"com.deploytide.plane":           "runtime",
			"com.deploytide.release":         "release-a",
			"com.deploytide.image-digest":    testDigest,
			"com.deploytide.fencing-token":   "17",
			"com.deploytide.controller-mode": "typed",
		},
		ExposedPorts: map[string]map[string]struct{}{"8080/tcp": {}},
		HostConfig: createHostConfig{
			AutoRemove:     false,
			CapDrop:        []string{"ALL"},
			ReadonlyRootfs: true,
			PidsLimit:      128,
			Memory:         64 * 1024 * 1024,
			NanoCPUs:       100 * 1_000_000,
			NetworkMode:    testName,
			PortBindings: map[string][]portBinding{
				"8080/tcp": {{HostIP: "127.0.0.1", HostPort: ""}},
			},
			PublishAllPorts: false,
			SecurityOpt:     []string{"no-new-privileges"},
			Tmpfs: map[string]string{
				"/tmp": "rw,nosuid,nodev,noexec,size=32m,uid=65534,gid=65534",
			},
		},
	})
	return payload
}

func newProxyTestServer(t *testing.T, handler http.Handler) (*httptest.Server, *httptest.Server) {
	t.Helper()
	upstream := httptest.NewServer(handler)
	upstreamURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	proxy := newWithUpstream(upstream.Client(), upstreamURL, DefaultAPIVersion)
	server := httptest.NewServer(proxy)
	t.Cleanup(server.Close)
	t.Cleanup(upstream.Close)
	return server, upstream
}

func doProxyRequest(t *testing.T, client *http.Client, method, target string, body []byte, headers map[string]string) *http.Response {
	t.Helper()
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	request, err := http.NewRequest(method, target, reader)
	if err != nil {
		t.Fatal(err)
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func TestProxyAllowsOnlyTheTypedRuntimeControllerSurface(t *testing.T) {
	record := &recordedUpstream{}
	networkExists := false
	containerExists := false
	containerStatus := "created"
	containerRunning := false
	upstream := http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		record.add(request)
		switch {
		case request.URL.Path == "/_ping":
			response.Header().Set("Content-Type", "text/plain")
			_, _ = response.Write([]byte("OK"))
		case request.URL.Path == "/v1.47/version":
			response.Header().Set("Content-Type", "application/json")
			_, _ = response.Write([]byte(`{"Version":"29.0.0"}`))
		case strings.HasPrefix(request.URL.Path, "/v1.47/images/"):
			response.Header().Set("Content-Type", "application/json")
			_, _ = response.Write([]byte(`{"Id":"` + testDigest + `"}`))
		case request.URL.Path == "/v1.47/networks/create":
			networkExists = true
			response.Header().Set("Content-Type", "application/json")
			_, _ = response.Write([]byte(`{"Id":"` + testNetworkID + `","Warning":""}`))
		case strings.HasPrefix(request.URL.Path, "/v1.47/networks/") && request.Method == http.MethodGet:
			response.Header().Set("Content-Type", "application/json")
			if !networkExists {
				response.WriteHeader(http.StatusNotFound)
				_, _ = response.Write([]byte(`{"message":"not found"}`))
				return
			}
			_, _ = response.Write(ownedNetworkPayload(containerRunning))
		case request.URL.Path == "/v1.47/containers/create":
			containerExists = true
			containerStatus = "created"
			containerRunning = false
			response.Header().Set("Content-Type", "application/json")
			_, _ = response.Write([]byte(`{"Id":"` + testContainerID + `","Warnings":[]}`))
		case strings.HasSuffix(request.URL.Path, "/json") && strings.Contains(request.URL.Path, "/containers/"):
			response.Header().Set("Content-Type", "application/json")
			if !containerExists {
				response.WriteHeader(http.StatusNotFound)
				_, _ = response.Write([]byte(`{"message":"not found"}`))
				return
			}
			_, _ = response.Write(ownedInspectPayloadForState(containerStatus, containerRunning))
		case strings.HasSuffix(request.URL.Path, "/start"):
			containerStatus = "running"
			containerRunning = true
			response.WriteHeader(http.StatusNoContent)
		case strings.HasSuffix(request.URL.Path, "/stop"):
			containerStatus = "exited"
			containerRunning = false
			response.WriteHeader(http.StatusNoContent)
		case strings.HasSuffix(request.URL.Path, "/logs"):
			response.Header().Set("Content-Type", "application/octet-stream")
			_, _ = response.Write([]byte("runtime log\n"))
		case strings.HasPrefix(request.URL.Path, "/v1.47/containers/") && request.Method == http.MethodDelete:
			containerExists = false
			response.WriteHeader(http.StatusNoContent)
		case strings.HasPrefix(request.URL.Path, "/v1.47/networks/") && request.Method == http.MethodDelete:
			networkExists = false
			response.WriteHeader(http.StatusNoContent)
		default:
			response.WriteHeader(http.StatusNoContent)
		}
	})
	server, _ := newProxyTestServer(t, upstream)

	requests := []struct {
		method string
		path   string
		body   []byte
	}{
		{http.MethodGet, "/_ping", nil},
		{http.MethodGet, "/v1.47/version", nil},
		{http.MethodGet, "/v1.47/images/" + testDigest + "/json", nil},
		{http.MethodPost, "/v1.47/networks/create", validNetworkCreatePayload()},
		{http.MethodGet, "/v1.47/networks/" + testName, nil},
		{http.MethodPost, "/v1.47/containers/create?name=" + testName, validCreatePayload()},
		{http.MethodGet, "/v1.47/containers/" + testName + "/json", nil},
		{http.MethodGet, "/v1.47/containers/" + testContainerID + "/json", nil},
		{http.MethodPost, "/v1.47/containers/" + testContainerID + "/start", nil},
		{http.MethodPost, "/v1.47/containers/" + testContainerID + "/stop?t=300", nil},
		{http.MethodGet, "/v1.47/containers/" + testContainerID + "/logs?stdout=true&stderr=true&timestamps=true&tail=100", nil},
		{http.MethodDelete, "/v1.47/containers/" + testContainerID + "?force=true&v=true", nil},
		{http.MethodGet, "/v1.47/networks/" + testNetworkID, nil},
		{http.MethodDelete, "/v1.47/networks/" + testNetworkID, nil},
	}
	for _, test := range requests {
		response := doProxyRequest(t, server.Client(), test.method, server.URL+test.path, test.body, nil)
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			t.Fatalf("allowlisted request failed: %s %s returned %d", test.method, test.path, response.StatusCode)
		}
	}
	joined := strings.Join(record.requests, "\n")
	for _, expected := range []string{
		"POST /v1.47/networks/create",
		"POST /v1.47/containers/" + testContainerID + "/stop?t=25",
		"DELETE /v1.47/containers/" + testContainerID + "?force=true&v=true",
		"DELETE /v1.47/networks/" + testNetworkID,
	} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("allowlisted upstream operation %q was not observed: %v", expected, record.requests)
		}
	}
}

func TestProxyRejectsUnknownAPIsMethodsAndQueryTricksWithoutForwarding(t *testing.T) {
	record := &recordedUpstream{}
	server, _ := newProxyTestServer(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		record.add(request)
		response.WriteHeader(http.StatusNoContent)
	}))

	denied := []struct {
		method  string
		path    string
		headers map[string]string
	}{
		{http.MethodPost, "/v1.47/build", nil},
		{http.MethodGet, "/v1.47/containers/json", nil},
		{http.MethodPost, "/v1.47/containers/" + testContainerID + "/exec", nil},
		{http.MethodGet, "/v1.47/containers/" + testContainerID + "/archive?path=/etc", nil},
		{http.MethodGet, "/v1.47/swarm", nil},
		{http.MethodGet, "/v1.47/secrets", nil},
		{http.MethodGet, "/v1.47/plugins", nil},
		{http.MethodGet, "/v1.47/volumes", nil},
		{http.MethodGet, "/v1.47/networks", nil},
		{http.MethodGet, "/v1.47/networks?filters=%7B%7D", nil},
		{http.MethodPost, "/v1.47/networks/prune", nil},
		{http.MethodPost, "/v1.47/networks/" + testNetworkID + "/connect", nil},
		{http.MethodPost, "/v1.47/networks/" + testNetworkID + "/disconnect", nil},
		{http.MethodGet, "/v1.47/networks/customer-network", nil},
		{http.MethodPatch, "/v1.47/networks/" + testNetworkID, nil},
		{http.MethodDelete, "/v1.47/networks/" + testName, nil},
		{http.MethodDelete, "/v1.47/networks/" + testNetworkID + "?force=true", nil},
		{http.MethodPost, "/v1.47/networks/create?name=" + testName, nil},
		{http.MethodGet, "/v1.47/images/alpine:latest/json", nil},
		{http.MethodGet, "/v1.47/images/" + testDigest + "/json?platform=linux", nil},
		{http.MethodGet, "/v1.47/containers/" + testContainerID + "/logs?stdout=true&stderr=true&timestamps=true&tail=1&tail=5000", nil},
		{http.MethodGet, "/v1.47/containers/" + testContainerID + "/logs?tail=100&stdout=true&stderr=true&timestamps=true", nil},
		{http.MethodPost, "/v1.47/containers/" + testContainerID + "/stop?t=01", nil},
		{http.MethodDelete, "/v1.47/containers/" + testContainerID + "?force=true", nil},
		{http.MethodDelete, "/v1.47/containers/" + testContainerID + "?v=true&force=true", nil},
		{http.MethodDelete, "/v1.47/containers/" + testName + "?force=true&v=true", nil},
		{http.MethodPost, "/v1.47/containers/aaaaaaaaaaaa/start", nil},
		{http.MethodPost, "/v1.47/containers/" + testContainerID + "/start?force=true", nil},
		{http.MethodPost, "/v1.47/containers/" + testContainerID + "/start", map[string]string{"X-HTTP-Method-Override": "DELETE"}},
		{http.MethodGet, "/v1.47/../v1.47/version", nil},
		{http.MethodPatch, "/_ping", nil},
	}
	for _, test := range denied {
		before := record.count()
		response := doProxyRequest(t, server.Client(), test.method, server.URL+test.path, nil, test.headers)
		body, _ := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if response.StatusCode != http.StatusForbidden || len(body) > 256 {
			t.Fatalf("request was not rejected safely: %s %s status=%d body=%q", test.method, test.path, response.StatusCode, body)
		}
		if record.count() != before {
			t.Fatalf("denied request reached Docker: %s %s", test.method, test.path)
		}
	}
}

func TestProxyRejectsAdversarialContainerCreateBodies(t *testing.T) {
	record := &recordedUpstream{}
	server, _ := newProxyTestServer(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		record.add(request)
		response.WriteHeader(http.StatusCreated)
		_, _ = response.Write([]byte(`{"Id":"` + testContainerID + `"}`))
	}))

	var valid map[string]any
	if err := json.Unmarshal(validCreatePayload(), &valid); err != nil {
		t.Fatal(err)
	}
	mutations := map[string]func(map[string]any){
		"mutable-image": func(body map[string]any) { body["Image"] = "registry.example/app:latest" },
		"root-user":     func(body map[string]any) { body["User"] = "0:0" },
		"command":       func(body map[string]any) { body["Cmd"] = []string{"sh", "-c", "id"} },
		"wrong-plane": func(body map[string]any) {
			body["Labels"].(map[string]any)["com.deploytide.plane"] = "build"
		},
		"extra-label": func(body map[string]any) {
			body["Labels"].(map[string]any)["attacker"] = "true"
		},
		"duplicate-env": func(body map[string]any) { body["Env"] = []any{"A=one", "A=two"} },
		"udp-port":      func(body map[string]any) { body["ExposedPorts"] = map[string]any{"8080/udp": map[string]any{}} },
		"privileged": func(body map[string]any) {
			body["HostConfig"].(map[string]any)["Privileged"] = true
		},
		"raw-socket-bind": func(body map[string]any) {
			body["HostConfig"].(map[string]any)["Binds"] = []any{"/var/run/docker.sock:/var/run/docker.sock"}
		},
		"host-network": func(body map[string]any) {
			body["HostConfig"].(map[string]any)["NetworkMode"] = "host"
		},
		"published-port": func(body map[string]any) {
			body["HostConfig"].(map[string]any)["PortBindings"] = map[string]any{"8080/tcp": []any{map[string]any{"HostPort": "8080"}}}
		},
		"wildcard-binding": func(body map[string]any) {
			body["HostConfig"].(map[string]any)["PortBindings"] = map[string]any{
				"8080/tcp": []any{map[string]any{"HostIp": "0.0.0.0", "HostPort": ""}},
			}
		},
		"fixed-loopback-binding": func(body map[string]any) {
			body["HostConfig"].(map[string]any)["PortBindings"] = map[string]any{
				"8080/tcp": []any{map[string]any{"HostIp": "127.0.0.1", "HostPort": "8080"}},
			}
		},
		"extra-binding": func(body map[string]any) {
			body["HostConfig"].(map[string]any)["PortBindings"] = map[string]any{
				"8080/tcp": []any{map[string]any{"HostIp": "127.0.0.1", "HostPort": ""}},
				"9090/tcp": []any{map[string]any{"HostIp": "127.0.0.1", "HostPort": ""}},
			}
		},
		"volume": func(body map[string]any) {
			body["HostConfig"].(map[string]any)["Mounts"] = []any{map[string]any{"Type": "volume", "Target": "/data"}}
		},
		"writable-root": func(body map[string]any) {
			body["HostConfig"].(map[string]any)["ReadonlyRootfs"] = false
		},
		"unbounded-memory": func(body map[string]any) {
			body["HostConfig"].(map[string]any)["Memory"] = float64(2 * 1024 * 1024 * 1024 * 1024)
		},
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			serialized, _ := json.Marshal(valid)
			var body map[string]any
			_ = json.Unmarshal(serialized, &body)
			mutate(body)
			payload, _ := json.Marshal(body)
			response := doProxyRequest(t, server.Client(), http.MethodPost, server.URL+"/v1.47/containers/create?name="+testName, payload, nil)
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
			if response.StatusCode != http.StatusForbidden {
				t.Fatalf("malicious create body was accepted: status=%d payload=%s", response.StatusCode, payload)
			}
		})
	}

	duplicate := bytes.Replace(validCreatePayload(), []byte(`{"Image":`), []byte(`{"Image":"`+testDigest+`","Image":`), 1)
	response := doProxyRequest(t, server.Client(), http.MethodPost, server.URL+"/v1.47/containers/create?name="+testName, duplicate, nil)
	_ = response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Fatal("duplicate JSON field was accepted")
	}

	oversized := bytes.Repeat([]byte("x"), int(maxRequestBody)+1)
	response = doProxyRequest(t, server.Client(), http.MethodPost, server.URL+"/v1.47/containers/create?name="+testName, oversized, nil)
	_ = response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Fatal("oversized create body was accepted")
	}

	response = doProxyRequest(t, server.Client(), http.MethodPost, server.URL+"/v1.47/containers/create?name=customer-container", validCreatePayload(), nil)
	_ = response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Fatal("arbitrary container name was accepted")
	}
	if record.count() != 0 {
		t.Fatalf("malicious create request reached Docker: %v", record.requests)
	}
}

func TestProxyRejectsAdversarialNetworkCreateBodiesAndQueries(t *testing.T) {
	record := &recordedUpstream{}
	server, _ := newProxyTestServer(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		record.add(request)
		response.WriteHeader(http.StatusCreated)
		_, _ = response.Write([]byte(`{"Id":"` + testNetworkID + `"}`))
	}))

	var valid map[string]any
	if err := json.Unmarshal(validNetworkCreatePayload(), &valid); err != nil {
		t.Fatal(err)
	}
	mutations := map[string]func(map[string]any){
		"arbitrary-name":     func(body map[string]any) { body["Name"] = "customer-network" },
		"duplicate-disabled": func(body map[string]any) { body["CheckDuplicate"] = false },
		"host-driver":        func(body map[string]any) { body["Driver"] = "host" },
		"internal":           func(body map[string]any) { body["Internal"] = true },
		"attachable":         func(body map[string]any) { body["Attachable"] = true },
		"ingress":            func(body map[string]any) { body["Ingress"] = true },
		"icc-enabled": func(body map[string]any) {
			body["Options"].(map[string]any)["com.docker.network.bridge.enable_icc"] = "true"
		},
		"wildcard-host-binding": func(body map[string]any) {
			body["Options"].(map[string]any)["com.docker.network.bridge.host_binding_ipv4"] = "0.0.0.0"
		},
		"extra-option": func(body map[string]any) {
			body["Options"].(map[string]any)["com.docker.network.driver.mtu"] = "1500"
		},
		"extra-label": func(body map[string]any) {
			body["Labels"].(map[string]any)["customer"] = "untyped"
		},
		"zero-fence": func(body map[string]any) {
			body["Labels"].(map[string]any)["com.deploytide.fencing-token"] = "0"
		},
		"ipam": func(body map[string]any) {
			body["IPAM"] = map[string]any{"Driver": "default", "Config": []any{map[string]any{"Subnet": "10.0.0.0/8"}}}
		},
		"unknown-field": func(body map[string]any) { body["EnableIPv6"] = true },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			serialized, _ := json.Marshal(valid)
			var body map[string]any
			_ = json.Unmarshal(serialized, &body)
			mutate(body)
			payload, _ := json.Marshal(body)
			response := doProxyRequest(t, server.Client(), http.MethodPost, server.URL+"/v1.47/networks/create", payload, nil)
			_ = response.Body.Close()
			if response.StatusCode != http.StatusForbidden {
				t.Fatalf("malicious network create body was accepted: status=%d payload=%s", response.StatusCode, payload)
			}
		})
	}

	duplicate := bytes.Replace(validNetworkCreatePayload(), []byte(`{"Name":`), []byte(`{"Name":"`+testName+`","Name":`), 1)
	response := doProxyRequest(t, server.Client(), http.MethodPost, server.URL+"/v1.47/networks/create", duplicate, nil)
	_ = response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Fatal("duplicate network JSON field was accepted")
	}
	response = doProxyRequest(t, server.Client(), http.MethodPost, server.URL+"/v1.47/networks/create?scope=local", validNetworkCreatePayload(), nil)
	_ = response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Fatal("network create query trick was accepted")
	}
	if record.count() != 0 {
		t.Fatalf("malicious network request reached Docker: %v", record.requests)
	}
}

func TestProxyCleansNewContainerWhenEffectiveImageMetadataIsUnsafe(t *testing.T) {
	mutations := map[string]func(map[string]any){
		"inherited-label": func(inspected map[string]any) {
			inspected["Config"].(map[string]any)["Labels"].(map[string]any)["image.inherited"] = "unsafe"
		},
		"inherited-volume": func(inspected map[string]any) {
			inspected["Config"].(map[string]any)["Volumes"] = map[string]any{"/data": map[string]any{}}
			inspected["Mounts"] = []any{map[string]any{
				"Type": "volume", "Source": "anonymous", "Destination": "/data",
			}}
		},
		"wrong-user": func(inspected map[string]any) {
			inspected["Config"].(map[string]any)["User"] = "0:0"
		},
		"wrong-digest": func(inspected map[string]any) {
			inspected["Image"] = "sha256:" + strings.Repeat("e", 64)
		},
		"weakened-security": func(inspected map[string]any) {
			inspected["HostConfig"].(map[string]any)["ReadonlyRootfs"] = false
		},
		"wrong-network": func(inspected map[string]any) {
			inspected["HostConfig"].(map[string]any)["NetworkMode"] = "bridge"
		},
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			record := &recordedUpstream{}
			containerExists := true
			var inspected map[string]any
			if err := json.Unmarshal(ownedInspectPayloadForState("created", false), &inspected); err != nil {
				t.Fatal(err)
			}
			mutate(inspected)
			unsafePayload, _ := json.Marshal(inspected)
			server, _ := newProxyTestServer(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				record.add(request)
				switch {
				case strings.HasPrefix(request.URL.Path, "/v1.47/networks/"):
					response.Header().Set("Content-Type", "application/json")
					_, _ = response.Write(ownedNetworkPayload(false))
				case request.URL.Path == "/v1.47/containers/create":
					response.Header().Set("Content-Type", "application/json")
					_, _ = response.Write([]byte(`{"Id":"` + testContainerID + `","Warnings":[]}`))
				case strings.HasSuffix(request.URL.Path, "/json"):
					response.Header().Set("Content-Type", "application/json")
					if !containerExists {
						response.WriteHeader(http.StatusNotFound)
						_, _ = response.Write([]byte(`{"message":"not found"}`))
						return
					}
					_, _ = response.Write(unsafePayload)
				case request.Method == http.MethodDelete:
					containerExists = false
					response.WriteHeader(http.StatusNoContent)
				default:
					response.WriteHeader(http.StatusNotFound)
				}
			}))

			response := doProxyRequest(t, server.Client(), http.MethodPost,
				server.URL+"/v1.47/containers/create?name="+testName, validCreatePayload(), nil)
			body, _ := io.ReadAll(response.Body)
			_ = response.Body.Close()
			if response.StatusCode != http.StatusForbidden {
				t.Fatalf("unsafe effective metadata was not rejected: status=%d body=%s", response.StatusCode, body)
			}
			if bytes.Contains(body, []byte(testContainerID)) {
				t.Fatal("unsafe container ID was returned to the controller")
			}
			expectedCleanup := "DELETE /v1.47/containers/" + testContainerID + "?force=true&v=true"
			if !strings.Contains(strings.Join(record.requests, "\n"), expectedCleanup) {
				t.Fatalf("unsafe container was not cleaned with volumes: %v", record.requests)
			}
		})
	}
}

func TestProxyRequiresOwnedMatchingNetworkBeforeContainerCreate(t *testing.T) {
	for name, networkPayload := range map[string][]byte{
		"unowned": bytes.Replace(ownedNetworkPayload(false),
			[]byte(`"com.deploytide.plane":"runtime"`), []byte(`"com.deploytide.plane":"customer"`), 1),
		"different-fence": bytes.Replace(ownedNetworkPayload(false),
			[]byte(`"com.deploytide.fencing-token":"17"`), []byte(`"com.deploytide.fencing-token":"18"`), 1),
		"occupied": ownedNetworkPayload(true),
	} {
		t.Run(name, func(t *testing.T) {
			createCalls := 0
			server, _ := newProxyTestServer(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				if request.URL.Path == "/v1.47/containers/create" {
					createCalls++
				}
				response.Header().Set("Content-Type", "application/json")
				_, _ = response.Write(networkPayload)
			}))
			response := doProxyRequest(t, server.Client(), http.MethodPost,
				server.URL+"/v1.47/containers/create?name="+testName, validCreatePayload(), nil)
			_ = response.Body.Close()
			if response.StatusCode != http.StatusForbidden || createCalls != 0 {
				t.Fatalf("container create reached an unsafe network: status=%d creates=%d", response.StatusCode, createCalls)
			}
		})
	}
}

func TestProxyInspectsOwnershipBeforeEveryIDBasedOperationAndFailsClosed(t *testing.T) {
	var mu sync.Mutex
	inspectionCalls := 0
	operationCalls := 0
	upstream := http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if strings.HasSuffix(request.URL.Path, "/json") {
			inspectionCalls++
			payload := ownedInspectPayload()
			payload = bytes.Replace(payload, []byte(`"com.deploytide.plane":"runtime"`), []byte(`"com.deploytide.plane":"customer"`), 1)
			response.Header().Set("Content-Type", "application/json")
			_, _ = response.Write(payload)
			return
		}
		operationCalls++
		response.WriteHeader(http.StatusNoContent)
	})
	server, _ := newProxyTestServer(t, upstream)
	operations := []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/v1.47/containers/" + testContainerID + "/start"},
		{http.MethodPost, "/v1.47/containers/" + testContainerID + "/stop?t=10"},
		{http.MethodGet, "/v1.47/containers/" + testContainerID + "/logs?stdout=true&stderr=true&timestamps=true&tail=10"},
		{http.MethodDelete, "/v1.47/containers/" + testContainerID + "?force=true&v=true"},
	}
	for _, operation := range operations {
		response := doProxyRequest(t, server.Client(), operation.method, server.URL+operation.path, nil, nil)
		_ = response.Body.Close()
		if response.StatusCode != http.StatusForbidden {
			t.Fatalf("unowned container operation was accepted: %s %s", operation.method, operation.path)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if inspectionCalls != len(operations) || operationCalls != 0 {
		t.Fatalf("ownership gate was bypassed: inspections=%d operations=%d", inspectionCalls, operationCalls)
	}
}

func TestProxyRejectsUnsafeContainerNetworkAndPortInspection(t *testing.T) {
	mutations := map[string]func(map[string]any){
		"wrong-network-mode": func(inspected map[string]any) {
			inspected["HostConfig"].(map[string]any)["NetworkMode"] = "bridge"
		},
		"wildcard-host-binding": func(inspected map[string]any) {
			bindings := inspected["HostConfig"].(map[string]any)["PortBindings"].(map[string]any)["8080/tcp"].([]any)
			bindings[0].(map[string]any)["HostIp"] = "0.0.0.0"
		},
		"fixed-requested-port": func(inspected map[string]any) {
			bindings := inspected["HostConfig"].(map[string]any)["PortBindings"].(map[string]any)["8080/tcp"].([]any)
			bindings[0].(map[string]any)["HostPort"] = "8080"
		},
		"wildcard-runtime-port": func(inspected map[string]any) {
			bindings := inspected["NetworkSettings"].(map[string]any)["Ports"].(map[string]any)["8080/tcp"].([]any)
			bindings[0].(map[string]any)["HostIp"] = "0.0.0.0"
		},
		"mismatched-network-id": func(inspected map[string]any) {
			endpoint := inspected["NetworkSettings"].(map[string]any)["Networks"].(map[string]any)[testName].(map[string]any)
			endpoint["NetworkID"] = strings.Repeat("e", 64)
		},
		"extra-network": func(inspected map[string]any) {
			networks := inspected["NetworkSettings"].(map[string]any)["Networks"].(map[string]any)
			networks["shared"] = map[string]any{"NetworkID": strings.Repeat("e", 64), "EndpointID": strings.Repeat("f", 64)}
		},
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			var inspected map[string]any
			if err := json.Unmarshal(ownedInspectPayload(), &inspected); err != nil {
				t.Fatal(err)
			}
			mutate(inspected)
			payload, _ := json.Marshal(inspected)
			server, _ := newProxyTestServer(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				response.Header().Set("Content-Type", "application/json")
				if strings.Contains(request.URL.Path, "/containers/") {
					_, _ = response.Write(payload)
					return
				}
				_, _ = response.Write(ownedNetworkPayload(true))
			}))
			response := doProxyRequest(t, server.Client(), http.MethodGet,
				server.URL+"/v1.47/containers/"+testContainerID+"/json", nil, nil)
			_ = response.Body.Close()
			if response.StatusCode != http.StatusForbidden {
				t.Fatalf("unsafe container inspection was accepted: status=%d", response.StatusCode)
			}
		})
	}
}

func TestProxyRejectsUnownedOrOccupiedNetworkOperations(t *testing.T) {
	var siblingNetwork map[string]any
	if err := json.Unmarshal(ownedNetworkPayload(true), &siblingNetwork); err != nil {
		t.Fatal(err)
	}
	siblingNetwork["Containers"].(map[string]any)[strings.Repeat("e", 64)] = map[string]any{
		"Name": "another-tenant", "EndpointID": strings.Repeat("f", 64),
	}
	siblingPayload, _ := json.Marshal(siblingNetwork)
	for name, payload := range map[string][]byte{
		"unowned-label": bytes.Replace(ownedNetworkPayload(false),
			[]byte(`"com.deploytide.plane":"runtime"`), []byte(`"com.deploytide.plane":"customer"`), 1),
		"wrong-option": bytes.Replace(ownedNetworkPayload(false),
			[]byte(`"com.docker.network.bridge.enable_icc":"false"`), []byte(`"com.docker.network.bridge.enable_icc":"true"`), 1),
		"occupied":         ownedNetworkPayload(true),
		"sibling-attached": siblingPayload,
	} {
		t.Run(name, func(t *testing.T) {
			deleteCalls := 0
			server, _ := newProxyTestServer(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				if request.Method == http.MethodDelete {
					deleteCalls++
					response.WriteHeader(http.StatusNoContent)
					return
				}
				response.Header().Set("Content-Type", "application/json")
				_, _ = response.Write(payload)
			}))
			response := doProxyRequest(t, server.Client(), http.MethodDelete,
				server.URL+"/v1.47/networks/"+testNetworkID, nil, nil)
			_ = response.Body.Close()
			if response.StatusCode != http.StatusForbidden || deleteCalls != 0 {
				t.Fatalf("unsafe network deletion was accepted: status=%d deletes=%d", response.StatusCode, deleteCalls)
			}
		})
	}
}

func TestProxyMissingDeletesRequireObservedAbsence(t *testing.T) {
	for name, path := range map[string]string{
		"container": "/v1.47/containers/" + testContainerID + "?force=true&v=true",
		"network":   "/v1.47/networks/" + testNetworkID,
	} {
		t.Run(name, func(t *testing.T) {
			gets := 0
			deletes := 0
			server, _ := newProxyTestServer(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				if request.Method == http.MethodDelete {
					deletes++
					response.WriteHeader(http.StatusNoContent)
					return
				}
				gets++
				response.Header().Set("Content-Type", "application/json")
				response.WriteHeader(http.StatusNotFound)
				_, _ = response.Write([]byte(`{"message":"not found"}`))
			}))
			response := doProxyRequest(t, server.Client(), http.MethodDelete, server.URL+path, nil, nil)
			_ = response.Body.Close()
			if response.StatusCode != http.StatusNotFound || gets != 2 || deletes != 0 {
				t.Fatalf("missing delete was not safely observed: status=%d gets=%d deletes=%d", response.StatusCode, gets, deletes)
			}
		})
	}
}

func TestProxyRejectsMismatchedImageAndOversizedDockerResponses(t *testing.T) {
	for name, handler := range map[string]http.HandlerFunc{
		"mismatched-image": func(response http.ResponseWriter, request *http.Request) {
			response.Header().Set("Content-Type", "application/json")
			_, _ = response.Write([]byte(`{"Id":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}`))
		},
		"oversized-version": func(response http.ResponseWriter, request *http.Request) {
			response.Header().Set("Content-Type", "application/json")
			_, _ = response.Write(bytes.Repeat([]byte("x"), int(maxVersionResponse)+1))
		},
	} {
		t.Run(name, func(t *testing.T) {
			server, _ := newProxyTestServer(t, handler)
			path := "/v1.47/images/" + testDigest + "/json"
			if name == "oversized-version" {
				path = "/v1.47/version"
			}
			response := doProxyRequest(t, server.Client(), http.MethodGet, server.URL+path, nil, nil)
			body, _ := io.ReadAll(response.Body)
			_ = response.Body.Close()
			if response.StatusCode < 400 || len(body) > 256 {
				t.Fatalf("unsafe Docker response was not bounded: status=%d bodyBytes=%d", response.StatusCode, len(body))
			}
		})
	}
}

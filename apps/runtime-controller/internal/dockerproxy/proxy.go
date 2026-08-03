package dockerproxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	DefaultAPIVersion  = "v1.47"
	maxRequestBody     = int64(1024 * 1024)
	maxVersionResponse = int64(256 * 1024)
	maxInspectResponse = int64(2 * 1024 * 1024)
	maxLogsResponse    = int64(8 * 1024 * 1024)
	maxSmallResponse   = int64(64 * 1024)
	maxSafeInteger     = int64(9_007_199_254_740_991)
	maxEffectiveStop   = 25
	cleanupTimeout     = 10 * time.Second
)

var (
	apiVersionPattern   = regexp.MustCompile(`^v1\.[0-9]{2}$`)
	containerIDPattern  = regexp.MustCompile(`^[a-f0-9]{64}$`)
	releaseIDPattern    = regexp.MustCompile(`^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,191}$`)
	imageDigestPattern  = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
	environmentPattern  = regexp.MustCompile(`^[A-Z_][A-Z0-9_]{0,127}$`)
	canonicalNumber     = regexp.MustCompile(`^(0|[1-9][0-9]*)$`)
	allowedContentTypes = map[string]struct{}{
		"application/json":         {},
		"application/octet-stream": {},
		"text/plain":               {},
	}
)

const deniedMessage = `{"message":"docker operation is not allowed"}`

type Proxy struct {
	client     *http.Client
	upstream   *url.URL
	apiVersion string
}

func New(rawSocketPath, apiVersion string) (*Proxy, error) {
	if !filepath.IsAbs(rawSocketPath) {
		return nil, errors.New("raw Docker socket path must be absolute")
	}
	if apiVersion == "" {
		apiVersion = DefaultAPIVersion
	}
	if !apiVersionPattern.MatchString(apiVersion) {
		return nil, errors.New("Docker API version is invalid")
	}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "unix", rawSocketPath)
		},
		DisableCompression:    true,
		DisableKeepAlives:     false,
		MaxIdleConns:          8,
		MaxIdleConnsPerHost:   8,
		IdleConnTimeout:       30 * time.Second,
		ResponseHeaderTimeout: 10 * time.Second,
	}
	upstream, _ := url.Parse("http://docker")
	return &Proxy{
		client: &http.Client{
			Transport: transport,
			Timeout:   35 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		upstream:   upstream,
		apiVersion: apiVersion,
	}, nil
}

func newWithUpstream(client *http.Client, upstream *url.URL, apiVersion string) *Proxy {
	return &Proxy{client: client, upstream: upstream, apiVersion: apiVersion}
}

func ListenUnix(socketPath string) (net.Listener, error) {
	if !filepath.IsAbs(socketPath) {
		return nil, errors.New("proxy socket path must be absolute")
	}
	if err := os.MkdirAll(filepath.Dir(socketPath), 0o750); err != nil {
		return nil, fmt.Errorf("create proxy socket directory: %w", err)
	}
	if info, err := os.Lstat(socketPath); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return nil, errors.New("refusing to replace a non-socket proxy path")
		}
		if err := os.Remove(socketPath); err != nil {
			return nil, fmt.Errorf("remove stale proxy socket: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("inspect proxy socket path: %w", err)
	}
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return nil, fmt.Errorf("listen on proxy socket: %w", err)
	}
	if err := os.Chmod(socketPath, 0o660); err != nil {
		_ = listener.Close()
		_ = os.Remove(socketPath)
		return nil, fmt.Errorf("restrict proxy socket: %w", err)
	}
	return listener, nil
}

type upstreamResponse struct {
	status      int
	contentType string
	body        []byte
}

func (proxy *Proxy) call(ctx context.Context, method, endpoint string, body []byte, maximum int64) (*upstreamResponse, error) {
	target := *proxy.upstream
	path, rawQuery, _ := strings.Cut(endpoint, "?")
	target.Path = path
	target.RawPath = ""
	target.RawQuery = rawQuery
	var payload io.Reader
	if body != nil {
		payload = bytes.NewReader(body)
	}
	request, err := http.NewRequestWithContext(ctx, method, target.String(), payload)
	if err != nil {
		return nil, err
	}
	request.Host = "docker"
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := proxy.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, maximum+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maximum {
		return nil, errors.New("Docker response exceeded the proxy limit")
	}
	contentType := strings.TrimSpace(strings.Split(response.Header.Get("Content-Type"), ";")[0])
	if _, allowed := allowedContentTypes[contentType]; !allowed {
		contentType = ""
	}
	return &upstreamResponse{status: response.StatusCode, contentType: contentType, body: data}, nil
}

func writeFixed(response http.ResponseWriter, status int, contentType string, body []byte) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	if contentType != "" {
		response.Header().Set("Content-Type", contentType)
	}
	response.WriteHeader(status)
	_, _ = response.Write(body)
}

func deny(response http.ResponseWriter) {
	writeFixed(response, http.StatusForbidden, "application/json", []byte(deniedMessage))
}

func badGateway(response http.ResponseWriter) {
	writeFixed(response, http.StatusBadGateway, "application/json", []byte(`{"message":"Docker engine response was rejected"}`))
}

func writeUpstream(response http.ResponseWriter, upstream *upstreamResponse, fallbackContentType string) {
	contentType := upstream.contentType
	if contentType == "" {
		contentType = fallbackContentType
	}
	writeFixed(response, upstream.status, contentType, upstream.body)
}

func bodyless(request *http.Request) bool {
	return request.ContentLength == 0 && len(request.TransferEncoding) == 0
}

func canonicalPath(request *http.Request, expected string) bool {
	return request.URL.Path == expected && request.URL.EscapedPath() == expected
}

func canonicalSegmentPath(request *http.Request, prefix, segment, suffix string) bool {
	if strings.Contains(segment, "/") || segment == "" {
		return false
	}
	expectedPath := prefix + segment + suffix
	expectedEscaped := prefix + url.PathEscape(segment) + suffix
	return request.URL.Path == expectedPath && request.URL.EscapedPath() == expectedEscaped
}

func requestHasForbiddenTransportFeatures(request *http.Request) bool {
	if request.URL.IsAbs() || request.URL.User != nil || request.URL.Fragment != "" {
		return true
	}
	if request.Header.Get("X-HTTP-Method-Override") != "" || request.Header.Get("Upgrade") != "" {
		return true
	}
	for _, token := range strings.Split(request.Header.Get("Connection"), ",") {
		if strings.EqualFold(strings.TrimSpace(token), "upgrade") {
			return true
		}
	}
	return request.ContentLength > maxRequestBody || len(request.TransferEncoding) > 0
}

func (proxy *Proxy) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if requestHasForbiddenTransportFeatures(request) {
		deny(response)
		return
	}
	prefix := "/" + proxy.apiVersion

	if request.Method == http.MethodGet && canonicalPath(request, "/_ping") && request.URL.RawQuery == "" && bodyless(request) {
		upstream, err := proxy.call(request.Context(), http.MethodGet, "/_ping", nil, maxSmallResponse)
		if err != nil {
			badGateway(response)
			return
		}
		writeUpstream(response, upstream, "text/plain")
		return
	}
	if request.Method == http.MethodGet && canonicalPath(request, prefix+"/version") && request.URL.RawQuery == "" && bodyless(request) {
		upstream, err := proxy.call(request.Context(), http.MethodGet, prefix+"/version", nil, maxVersionResponse)
		if err != nil {
			badGateway(response)
			return
		}
		writeUpstream(response, upstream, "application/json")
		return
	}
	if strings.HasPrefix(request.URL.Path, prefix+"/images/") && strings.HasSuffix(request.URL.Path, "/json") {
		digest := strings.TrimSuffix(strings.TrimPrefix(request.URL.Path, prefix+"/images/"), "/json")
		if request.Method != http.MethodGet || request.URL.RawQuery != "" || !bodyless(request) ||
			!imageDigestPattern.MatchString(digest) || !canonicalSegmentPath(request, prefix+"/images/", digest, "/json") {
			deny(response)
			return
		}
		proxy.inspectImage(response, request, digest)
		return
	}
	if request.Method == http.MethodPost && canonicalPath(request, prefix+"/containers/create") {
		proxy.createContainer(response, request)
		return
	}
	if request.Method == http.MethodPost && canonicalPath(request, prefix+"/networks/create") {
		proxy.createNetwork(response, request)
		return
	}
	if strings.HasPrefix(request.URL.Path, prefix+"/containers/") {
		proxy.handleContainer(response, request)
		return
	}
	if strings.HasPrefix(request.URL.Path, prefix+"/networks/") {
		proxy.handleNetwork(response, request)
		return
	}
	deny(response)
}

func rejectDuplicateJSONKeys(payload []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.UseNumber()
	var walk func() error
	walk = func() error {
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
					return errors.New("JSON object key is invalid")
				}
				if _, exists := seen[key]; exists {
					return fmt.Errorf("JSON field %q is duplicated", key)
				}
				seen[key] = struct{}{}
				if err := walk(); err != nil {
					return err
				}
			}
			closing, err := decoder.Token()
			if err != nil || closing != json.Delim('}') {
				return errors.New("JSON object is incomplete")
			}
		case '[':
			for decoder.More() {
				if err := walk(); err != nil {
					return err
				}
			}
			closing, err := decoder.Token()
			if err != nil || closing != json.Delim(']') {
				return errors.New("JSON array is incomplete")
			}
		default:
			return errors.New("JSON delimiter is invalid")
		}
		return nil
	}
	if err := walk(); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("JSON contains trailing data")
		}
		return err
	}
	return nil
}

func hasExactKeys(value map[string]json.RawMessage, expected ...string) bool {
	if len(value) != len(expected) {
		return false
	}
	for _, key := range expected {
		if _, ok := value[key]; !ok {
			return false
		}
	}
	return true
}

type createHostConfig struct {
	AutoRemove      bool                     `json:"AutoRemove"`
	CapDrop         []string                 `json:"CapDrop"`
	ReadonlyRootfs  bool                     `json:"ReadonlyRootfs"`
	PidsLimit       int64                    `json:"PidsLimit"`
	Memory          int64                    `json:"Memory"`
	NanoCPUs        int64                    `json:"NanoCpus"`
	NetworkMode     string                   `json:"NetworkMode"`
	PortBindings    map[string][]portBinding `json:"PortBindings"`
	PublishAllPorts bool                     `json:"PublishAllPorts"`
	SecurityOpt     []string                 `json:"SecurityOpt"`
	Tmpfs           map[string]string        `json:"Tmpfs"`
}

type portBinding struct {
	HostIP   string `json:"HostIp"`
	HostPort string `json:"HostPort"`
}

type createRequest struct {
	Image        string                         `json:"Image"`
	User         string                         `json:"User"`
	Env          []string                       `json:"Env"`
	Labels       map[string]string              `json:"Labels"`
	ExposedPorts map[string]map[string]struct{} `json:"ExposedPorts"`
	HostConfig   createHostConfig               `json:"HostConfig"`
}

func decodeCreateRequest(payload []byte) (createRequest, error) {
	var decoded createRequest
	if len(payload) == 0 || int64(len(payload)) > maxRequestBody {
		return decoded, errors.New("create body size is invalid")
	}
	if err := rejectDuplicateJSONKeys(payload); err != nil {
		return decoded, err
	}
	var root map[string]json.RawMessage
	if err := json.Unmarshal(payload, &root); err != nil || !hasExactKeys(root, "Image", "User", "Env", "Labels", "ExposedPorts", "HostConfig") {
		return decoded, errors.New("create body fields are invalid")
	}
	var host map[string]json.RawMessage
	if err := json.Unmarshal(root["HostConfig"], &host); err != nil ||
		!hasExactKeys(host, "AutoRemove", "CapDrop", "ReadonlyRootfs", "PidsLimit", "Memory", "NanoCpus",
			"NetworkMode", "PortBindings", "PublishAllPorts", "SecurityOpt", "Tmpfs") {
		return decoded, errors.New("host configuration fields are invalid")
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&decoded); err != nil {
		return decoded, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return decoded, errors.New("create body contains trailing data")
	}
	return decoded, nil
}

func validCreateRequest(name string, request createRequest) bool {
	if !strings.HasPrefix(name, "deploytide-release-") {
		return false
	}
	releaseID := strings.TrimPrefix(name, "deploytide-release-")
	if !releaseIDPattern.MatchString(releaseID) || !imageDigestPattern.MatchString(request.Image) || request.User != "65534:65534" {
		return false
	}
	if len(request.Labels) != 5 ||
		request.Labels["com.deploytide.plane"] != "runtime" ||
		request.Labels["com.deploytide.release"] != releaseID ||
		request.Labels["com.deploytide.image-digest"] != request.Image ||
		request.Labels["com.deploytide.controller-mode"] != "typed" {
		return false
	}
	fencing := request.Labels["com.deploytide.fencing-token"]
	fencingToken, err := strconv.ParseInt(fencing, 10, 64)
	if err != nil || fencingToken < 1 || fencingToken > maxSafeInteger || strconv.FormatInt(fencingToken, 10) != fencing {
		return false
	}
	if len(request.Env) > 256 {
		return false
	}
	seenEnvironment := make(map[string]struct{}, len(request.Env))
	totalEnvironmentBytes := 0
	for _, entry := range request.Env {
		key, value, found := strings.Cut(entry, "=")
		totalEnvironmentBytes += len(entry)
		if !found || !environmentPattern.MatchString(key) || len(value) > 32*1024 || totalEnvironmentBytes > 512*1024 {
			return false
		}
		if _, duplicate := seenEnvironment[key]; duplicate {
			return false
		}
		seenEnvironment[key] = struct{}{}
	}
	if len(request.ExposedPorts) != 1 {
		return false
	}
	portKey := ""
	for port, value := range request.ExposedPorts {
		number, protocol, found := strings.Cut(port, "/")
		parsed, err := strconv.Atoi(number)
		if !found || protocol != "tcp" || err != nil || parsed < 1 || parsed > 65535 || len(value) != 0 {
			return false
		}
		portKey = port
	}
	host := request.HostConfig
	bindings := host.PortBindings[portKey]
	return !host.AutoRemove && len(host.CapDrop) == 1 && host.CapDrop[0] == "ALL" &&
		host.ReadonlyRootfs && host.PidsLimit == 128 &&
		host.Memory >= 6*1024*1024 && host.Memory <= 1024*1024*1024*1024 &&
		host.NanoCPUs >= 10_000_000 && host.NanoCPUs <= 1_024_000_000_000 &&
		host.NetworkMode == name && len(host.PortBindings) == 1 && len(bindings) == 1 &&
		bindings[0].HostIP == "127.0.0.1" && bindings[0].HostPort == "" && !host.PublishAllPorts &&
		len(host.SecurityOpt) == 1 && host.SecurityOpt[0] == "no-new-privileges" &&
		len(host.Tmpfs) == 1 && host.Tmpfs["/tmp"] == "rw,nosuid,nodev,noexec,size=32m,uid=65534,gid=65534"
}

type networkCreateRequest struct {
	Name           string            `json:"Name"`
	CheckDuplicate bool              `json:"CheckDuplicate"`
	Driver         string            `json:"Driver"`
	Internal       bool              `json:"Internal"`
	Attachable     bool              `json:"Attachable"`
	Ingress        bool              `json:"Ingress"`
	Options        map[string]string `json:"Options"`
	Labels         map[string]string `json:"Labels"`
}

type networkAttachment struct {
	Name       string `json:"Name"`
	EndpointID string `json:"EndpointID"`
}

type networkInspect struct {
	ID         string `json:"Id"`
	Name       string `json:"Name"`
	Driver     string `json:"Driver"`
	Scope      string `json:"Scope"`
	Internal   bool   `json:"Internal"`
	Attachable bool   `json:"Attachable"`
	Ingress    bool   `json:"Ingress"`
	ConfigOnly bool   `json:"ConfigOnly"`
	ConfigFrom struct {
		Network string `json:"Network"`
	} `json:"ConfigFrom"`
	IPAM struct {
		Driver  string            `json:"Driver"`
		Options map[string]string `json:"Options"`
		Config  []struct {
			Subnet     string            `json:"Subnet"`
			IPRange    string            `json:"IPRange"`
			Gateway    string            `json:"Gateway"`
			AuxAddress map[string]string `json:"AuxiliaryAddresses"`
		} `json:"Config"`
	} `json:"IPAM"`
	Options    map[string]string            `json:"Options"`
	Labels     map[string]string            `json:"Labels"`
	Containers map[string]networkAttachment `json:"Containers"`
}

func releaseNameFromRuntimeName(name string) (string, bool) {
	if !strings.HasPrefix(name, "deploytide-release-") {
		return "", false
	}
	releaseID := strings.TrimPrefix(name, "deploytide-release-")
	return releaseID, releaseIDPattern.MatchString(releaseID)
}

func validFencingToken(value string) bool {
	token, err := strconv.ParseInt(value, 10, 64)
	return err == nil && token >= 1 && token <= maxSafeInteger && strconv.FormatInt(token, 10) == value
}

func validRuntimeNetworkLabels(labels map[string]string, releaseID string) bool {
	return len(labels) == 4 &&
		labels["com.deploytide.plane"] == "runtime" &&
		labels["com.deploytide.release"] == releaseID &&
		labels["com.deploytide.controller-mode"] == "typed" &&
		validFencingToken(labels["com.deploytide.fencing-token"])
}

func decodeNetworkCreateRequest(payload []byte) (networkCreateRequest, error) {
	var decoded networkCreateRequest
	if len(payload) == 0 || int64(len(payload)) > maxRequestBody {
		return decoded, errors.New("network create body size is invalid")
	}
	if err := rejectDuplicateJSONKeys(payload); err != nil {
		return decoded, err
	}
	var root map[string]json.RawMessage
	if err := json.Unmarshal(payload, &root); err != nil ||
		!hasExactKeys(root, "Name", "CheckDuplicate", "Driver", "Internal", "Attachable", "Ingress", "Options", "Labels") {
		return decoded, errors.New("network create body fields are invalid")
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&decoded); err != nil {
		return decoded, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return decoded, errors.New("network create body contains trailing data")
	}
	return decoded, nil
}

func validNetworkCreateRequest(request networkCreateRequest) bool {
	releaseID, validName := releaseNameFromRuntimeName(request.Name)
	return validName && request.CheckDuplicate && request.Driver == "bridge" &&
		!request.Internal && !request.Attachable && !request.Ingress &&
		len(request.Options) == 2 &&
		request.Options["com.docker.network.bridge.enable_icc"] == "false" &&
		request.Options["com.docker.network.bridge.host_binding_ipv4"] == "127.0.0.1" &&
		validRuntimeNetworkLabels(request.Labels, releaseID)
}

func validNetworkIdentifier(identifier string) bool {
	if containerIDPattern.MatchString(identifier) {
		return true
	}
	_, valid := releaseNameFromRuntimeName(identifier)
	return valid
}

func validateOwnedNetwork(identifier string, inspected networkInspect) bool {
	if !containerIDPattern.MatchString(inspected.ID) {
		return false
	}
	releaseID, validName := releaseNameFromRuntimeName(inspected.Name)
	if !validName {
		return false
	}
	if containerIDPattern.MatchString(identifier) {
		if inspected.ID != identifier {
			return false
		}
	} else if inspected.Name != identifier {
		return false
	}
	if inspected.Driver != "bridge" || inspected.Scope != "local" || inspected.Internal ||
		inspected.Attachable || inspected.Ingress || inspected.ConfigOnly || inspected.ConfigFrom.Network != "" ||
		(inspected.IPAM.Driver != "" && inspected.IPAM.Driver != "default") || len(inspected.IPAM.Options) != 0 ||
		len(inspected.Options) != 2 ||
		inspected.Options["com.docker.network.bridge.enable_icc"] != "false" ||
		inspected.Options["com.docker.network.bridge.host_binding_ipv4"] != "127.0.0.1" ||
		!validRuntimeNetworkLabels(inspected.Labels, releaseID) || len(inspected.Containers) > 1 {
		return false
	}
	for containerID, attachment := range inspected.Containers {
		if !containerIDPattern.MatchString(containerID) || attachment.Name != inspected.Name ||
			!containerIDPattern.MatchString(attachment.EndpointID) {
			return false
		}
	}
	return true
}

func (proxy *Proxy) inspectOwnedNetwork(ctx context.Context, identifier string) (*upstreamResponse, *networkInspect, bool, error) {
	endpoint := "/" + proxy.apiVersion + "/networks/" + url.PathEscape(identifier)
	upstream, err := proxy.call(ctx, http.MethodGet, endpoint, nil, maxInspectResponse)
	if err != nil {
		return nil, nil, false, err
	}
	if upstream.status < 200 || upstream.status >= 300 {
		return upstream, nil, false, nil
	}
	if err := rejectDuplicateJSONKeys(upstream.body); err != nil {
		return nil, nil, false, err
	}
	var inspected networkInspect
	if err := json.Unmarshal(upstream.body, &inspected); err != nil {
		return nil, nil, false, err
	}
	return upstream, &inspected, validateOwnedNetwork(identifier, inspected), nil
}

func (proxy *Proxy) createNetwork(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost || request.URL.RawQuery != "" || len(request.TransferEncoding) != 0 ||
		request.ContentLength <= 0 || request.ContentLength > maxRequestBody {
		deny(response)
		return
	}
	payload, err := io.ReadAll(io.LimitReader(request.Body, maxRequestBody+1))
	if err != nil || int64(len(payload)) > maxRequestBody {
		deny(response)
		return
	}
	create, err := decodeNetworkCreateRequest(payload)
	if err != nil || !validNetworkCreateRequest(create) {
		deny(response)
		return
	}
	sanitized, err := json.Marshal(create)
	if err != nil {
		deny(response)
		return
	}
	endpoint := "/" + proxy.apiVersion + "/networks/create"
	upstream, err := proxy.call(request.Context(), http.MethodPost, endpoint, sanitized, maxSmallResponse)
	if err != nil {
		badGateway(response)
		return
	}
	if upstream.status >= 200 && upstream.status < 300 {
		var created struct {
			ID      string `json:"Id"`
			Warning string `json:"Warning"`
		}
		strictErr := rejectDuplicateJSONKeys(upstream.body)
		decodeErr := json.Unmarshal(upstream.body, &created)
		if strictErr != nil || decodeErr != nil || !containerIDPattern.MatchString(created.ID) {
			if decodeErr == nil && containerIDPattern.MatchString(created.ID) {
				_ = proxy.cleanupCreatedNetwork(created.ID, create)
			}
			badGateway(response)
			return
		}
	}
	writeUpstream(response, upstream, "application/json")
}

func (proxy *Proxy) cleanupCreatedNetwork(identifier string, create networkCreateRequest) bool {
	if !containerIDPattern.MatchString(identifier) {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), cleanupTimeout)
	defer cancel()
	inspection, network, owned, err := proxy.inspectOwnedNetwork(ctx, identifier)
	if err != nil || inspection == nil || inspection.status < 200 || inspection.status >= 300 ||
		!owned || network == nil || network.Name != create.Name || len(network.Containers) != 0 ||
		network.Labels["com.deploytide.fencing-token"] != create.Labels["com.deploytide.fencing-token"] {
		return false
	}
	endpoint := "/" + proxy.apiVersion + "/networks/" + identifier
	removed, err := proxy.call(ctx, http.MethodDelete, endpoint, nil, maxSmallResponse)
	if err != nil || removed == nil ||
		!((removed.status >= 200 && removed.status < 300) || removed.status == http.StatusNotFound) {
		return false
	}
	confirmed, _, _, err := proxy.inspectOwnedNetwork(ctx, identifier)
	return err == nil && confirmed != nil && confirmed.status == http.StatusNotFound
}

func (proxy *Proxy) handleNetwork(response http.ResponseWriter, request *http.Request) {
	prefix := "/" + proxy.apiVersion + "/networks/"
	identifier := strings.TrimPrefix(request.URL.Path, prefix)
	if !validNetworkIdentifier(identifier) || !canonicalSegmentPath(request, prefix, identifier, "") ||
		request.URL.RawQuery != "" || !bodyless(request) {
		deny(response)
		return
	}
	if request.Method != http.MethodGet && request.Method != http.MethodDelete {
		deny(response)
		return
	}
	if request.Method == http.MethodDelete && !containerIDPattern.MatchString(identifier) {
		deny(response)
		return
	}
	inspection, inspected, owned, err := proxy.inspectOwnedNetwork(request.Context(), identifier)
	if err != nil {
		badGateway(response)
		return
	}
	if inspection == nil {
		badGateway(response)
		return
	}
	if inspection.status < 200 || inspection.status >= 300 {
		if request.Method == http.MethodDelete && inspection.status == http.StatusNotFound {
			confirm, _, _, confirmErr := proxy.inspectOwnedNetwork(request.Context(), identifier)
			if confirmErr != nil || confirm == nil {
				badGateway(response)
				return
			}
			if confirm.status == http.StatusNotFound {
				writeUpstream(response, confirm, "application/json")
				return
			}
			deny(response)
			return
		}
		writeUpstream(response, inspection, "application/json")
		return
	}
	if !owned || inspected == nil {
		deny(response)
		return
	}
	if request.Method == http.MethodGet {
		writeUpstream(response, inspection, "application/json")
		return
	}
	if len(inspected.Containers) != 0 {
		deny(response)
		return
	}
	upstream, err := proxy.call(request.Context(), http.MethodDelete, prefix+identifier, nil, maxSmallResponse)
	if err != nil {
		badGateway(response)
		return
	}
	writeUpstream(response, upstream, "application/json")
}

func (proxy *Proxy) createContainer(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost || len(request.TransferEncoding) != 0 || request.ContentLength <= 0 || request.ContentLength > maxRequestBody {
		deny(response)
		return
	}
	values, err := url.ParseQuery(request.URL.RawQuery)
	if err != nil || len(values) != 1 || len(values["name"]) != 1 {
		deny(response)
		return
	}
	name := values.Get("name")
	if request.URL.RawQuery != "name="+url.QueryEscape(name) {
		deny(response)
		return
	}
	payload, err := io.ReadAll(io.LimitReader(request.Body, maxRequestBody+1))
	if err != nil || int64(len(payload)) > maxRequestBody {
		deny(response)
		return
	}
	create, err := decodeCreateRequest(payload)
	if err != nil || !validCreateRequest(name, create) {
		deny(response)
		return
	}
	networkResponse, network, ownedNetwork, err := proxy.inspectOwnedNetwork(request.Context(), create.HostConfig.NetworkMode)
	if err != nil {
		badGateway(response)
		return
	}
	if networkResponse == nil {
		badGateway(response)
		return
	}
	if networkResponse.status < 200 || networkResponse.status >= 300 || !ownedNetwork || network == nil ||
		network.Name != name || len(network.Containers) != 0 ||
		network.Labels["com.deploytide.fencing-token"] != create.Labels["com.deploytide.fencing-token"] {
		deny(response)
		return
	}
	sanitized, err := json.Marshal(create)
	if err != nil {
		deny(response)
		return
	}
	endpoint := "/" + proxy.apiVersion + "/containers/create?name=" + url.QueryEscape(name)
	upstream, err := proxy.call(request.Context(), http.MethodPost, endpoint, sanitized, maxSmallResponse)
	if err != nil {
		badGateway(response)
		return
	}
	if upstream.status >= 200 && upstream.status < 300 {
		var created struct {
			ID       string   `json:"Id"`
			Warnings []string `json:"Warnings"`
		}
		if rejectDuplicateJSONKeys(upstream.body) != nil || json.Unmarshal(upstream.body, &created) != nil || !containerIDPattern.MatchString(created.ID) {
			badGateway(response)
			return
		}
		inspection, inspected, owned, inspectErr := proxy.inspectOwned(request.Context(), created.ID)
		validInspection := inspectErr == nil && inspection != nil &&
			inspection.status >= 200 && inspection.status < 300 && owned && inspected != nil
		matchesCreate := validInspection && containerMatchesCreate(*inspected, create, *network)
		if !matchesCreate {
			cleaned := proxy.cleanupCreatedContainer(created.ID)
			if !cleaned || inspectErr != nil || inspection == nil ||
				inspection.status < 200 || inspection.status >= 300 {
				badGateway(response)
			} else {
				deny(response)
			}
			return
		}
	}
	writeUpstream(response, upstream, "application/json")
}

func (proxy *Proxy) cleanupCreatedContainer(identifier string) bool {
	if !containerIDPattern.MatchString(identifier) {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), cleanupTimeout)
	defer cancel()
	endpoint := "/" + proxy.apiVersion + "/containers/" + identifier + "?force=true&v=true"
	upstream, err := proxy.call(ctx, http.MethodDelete, endpoint, nil, maxSmallResponse)
	if err != nil || upstream == nil ||
		!((upstream.status >= 200 && upstream.status < 300) || upstream.status == http.StatusNotFound) {
		return false
	}
	inspection, _, _, err := proxy.inspectOwned(ctx, identifier)
	return err == nil && inspection != nil && inspection.status == http.StatusNotFound
}

type containerInspect struct {
	ID    string `json:"Id"`
	Name  string `json:"Name"`
	Image string `json:"Image"`
	State struct {
		Status  string `json:"Status"`
		Running bool   `json:"Running"`
	} `json:"State"`
	Mounts []struct {
		Type        string `json:"Type"`
		Source      string `json:"Source"`
		Destination string `json:"Destination"`
	} `json:"Mounts"`
	Config struct {
		Image        string                         `json:"Image"`
		User         string                         `json:"User"`
		Labels       map[string]string              `json:"Labels"`
		ExposedPorts map[string]map[string]struct{} `json:"ExposedPorts"`
		Volumes      map[string]struct{}            `json:"Volumes"`
	} `json:"Config"`
	HostConfig struct {
		AutoRemove      bool                     `json:"AutoRemove"`
		Privileged      bool                     `json:"Privileged"`
		ReadonlyRootfs  bool                     `json:"ReadonlyRootfs"`
		Binds           []string                 `json:"Binds"`
		CapAdd          []string                 `json:"CapAdd"`
		CapDrop         []string                 `json:"CapDrop"`
		SecurityOpt     []string                 `json:"SecurityOpt"`
		PidsLimit       int64                    `json:"PidsLimit"`
		Memory          int64                    `json:"Memory"`
		NanoCPUs        int64                    `json:"NanoCpus"`
		NetworkMode     string                   `json:"NetworkMode"`
		PortBindings    map[string][]portBinding `json:"PortBindings"`
		PublishAllPorts bool                     `json:"PublishAllPorts"`
		Tmpfs           map[string]string        `json:"Tmpfs"`
		Devices         []json.RawMessage        `json:"Devices"`
		DeviceRequests  []json.RawMessage        `json:"DeviceRequests"`
		VolumesFrom     []string                 `json:"VolumesFrom"`
		RestartPolicy   struct {
			Name              string `json:"Name"`
			MaximumRetryCount int    `json:"MaximumRetryCount"`
		} `json:"RestartPolicy"`
	} `json:"HostConfig"`
	NetworkSettings struct {
		Ports    map[string][]portBinding `json:"Ports"`
		Networks map[string]struct {
			NetworkID  string `json:"NetworkID"`
			EndpointID string `json:"EndpointID"`
		} `json:"Networks"`
	} `json:"NetworkSettings"`
}

func canonicalAllocatedPort(value string) bool {
	if !canonicalNumber.MatchString(value) || value == "0" {
		return false
	}
	port, err := strconv.Atoi(value)
	return err == nil && port >= 1 && port <= 65535 && strconv.Itoa(port) == value
}

func exposedTCPPort(exposed map[string]map[string]struct{}) (string, bool) {
	if len(exposed) != 1 {
		return "", false
	}
	for portKey, value := range exposed {
		number, protocol, found := strings.Cut(portKey, "/")
		port, err := strconv.Atoi(number)
		return portKey, found && protocol == "tcp" && err == nil && port >= 1 && port <= 65535 &&
			strconv.Itoa(port) == number && len(value) == 0
	}
	return "", false
}

func containerNetwork(inspected containerInspect) (string, string, string, bool) {
	if len(inspected.NetworkSettings.Networks) != 1 {
		return "", "", "", false
	}
	for name, endpoint := range inspected.NetworkSettings.Networks {
		validEndpoint := endpoint.EndpointID == "" || containerIDPattern.MatchString(endpoint.EndpointID)
		return name, endpoint.NetworkID, endpoint.EndpointID,
			containerIDPattern.MatchString(endpoint.NetworkID) && validEndpoint
	}
	return "", "", "", false
}

func validContainerPortBindings(inspected containerInspect, portKey string) bool {
	hostBindings := inspected.HostConfig.PortBindings[portKey]
	if len(inspected.HostConfig.PortBindings) != 1 || len(hostBindings) != 1 ||
		hostBindings[0].HostIP != "127.0.0.1" ||
		(hostBindings[0].HostPort != "" && !canonicalAllocatedPort(hostBindings[0].HostPort)) {
		return false
	}
	if len(inspected.NetworkSettings.Ports) > 1 {
		return false
	}
	runtimeBindings, hasRuntimePort := inspected.NetworkSettings.Ports[portKey]
	if len(inspected.NetworkSettings.Ports) == 1 && !hasRuntimePort {
		return false
	}
	if len(runtimeBindings) == 0 {
		return !inspected.State.Running
	}
	if len(runtimeBindings) != 1 || runtimeBindings[0].HostIP != "127.0.0.1" ||
		!canonicalAllocatedPort(runtimeBindings[0].HostPort) ||
		(hostBindings[0].HostPort != "" && hostBindings[0].HostPort != runtimeBindings[0].HostPort) {
		return false
	}
	return true
}

func validateOwnedContainer(identifier string, inspected containerInspect) bool {
	if !containerIDPattern.MatchString(inspected.ID) || !strings.HasPrefix(inspected.Name, "/") {
		return false
	}
	name := strings.TrimPrefix(inspected.Name, "/")
	releaseID, validName := releaseNameFromRuntimeName(name)
	if !validName {
		return false
	}
	if containerIDPattern.MatchString(identifier) {
		if inspected.ID != identifier {
			return false
		}
	} else if name != identifier {
		return false
	}
	labels := inspected.Config.Labels
	if len(labels) != 5 || labels["com.deploytide.plane"] != "runtime" ||
		labels["com.deploytide.release"] != releaseID ||
		labels["com.deploytide.controller-mode"] != "typed" ||
		!imageDigestPattern.MatchString(labels["com.deploytide.image-digest"]) ||
		labels["com.deploytide.image-digest"] != inspected.Image ||
		labels["com.deploytide.image-digest"] != inspected.Config.Image ||
		inspected.Config.User != "65534:65534" {
		return false
	}
	if !validFencingToken(labels["com.deploytide.fencing-token"]) {
		return false
	}
	portKey, validPort := exposedTCPPort(inspected.Config.ExposedPorts)
	networkName, _, endpointID, validNetwork := containerNetwork(inspected)
	if !validPort || !validNetwork || networkName != name {
		return false
	}
	if !validContainerPortBindings(inspected, portKey) || (inspected.State.Running && endpointID == "") {
		return false
	}
	host := inspected.HostConfig
	return len(inspected.Mounts) == 0 && len(inspected.Config.Volumes) == 0 &&
		!host.AutoRemove && !host.Privileged && host.ReadonlyRootfs &&
		len(host.Binds) == 0 && len(host.CapAdd) == 0 &&
		len(host.CapDrop) == 1 && host.CapDrop[0] == "ALL" &&
		len(host.SecurityOpt) == 1 && host.SecurityOpt[0] == "no-new-privileges" &&
		host.PidsLimit == 128 && host.Memory >= 6*1024*1024 && host.Memory <= 1024*1024*1024*1024 &&
		host.NanoCPUs >= 10_000_000 && host.NanoCPUs <= 1_024_000_000_000 &&
		host.NetworkMode == name && !host.PublishAllPorts &&
		len(host.Tmpfs) == 1 && host.Tmpfs["/tmp"] == "rw,nosuid,nodev,noexec,size=32m,uid=65534,gid=65534" &&
		len(host.Devices) == 0 && len(host.DeviceRequests) == 0 && len(host.VolumesFrom) == 0 &&
		(host.RestartPolicy.Name == "" || host.RestartPolicy.Name == "no") && host.RestartPolicy.MaximumRetryCount == 0
}

func networkMatchesContainerState(network networkInspect, inspected containerInspect) bool {
	_, networkID, endpointID, valid := containerNetwork(inspected)
	if !valid || network.ID != networkID {
		return false
	}
	if endpointID == "" {
		return !inspected.State.Running && len(network.Containers) == 0
	}
	if len(network.Containers) != 1 {
		return false
	}
	attachment, exists := network.Containers[inspected.ID]
	return exists && attachment.Name == strings.TrimPrefix(inspected.Name, "/") && attachment.EndpointID == endpointID
}

func containerMatchesCreate(inspected containerInspect, create createRequest, network networkInspect) bool {
	portKey, validPort := exposedTCPPort(inspected.Config.ExposedPorts)
	requestedPortKey, validRequestedPort := exposedTCPPort(create.ExposedPorts)
	_, networkID, _, validNetwork := containerNetwork(inspected)
	if !validPort || !validRequestedPort || portKey != requestedPortKey || !validNetwork || networkID != network.ID ||
		inspected.State.Status != "created" || inspected.State.Running ||
		inspected.HostConfig.Memory != create.HostConfig.Memory ||
		inspected.HostConfig.NanoCPUs != create.HostConfig.NanoCPUs ||
		len(inspected.Config.Labels) != len(create.Labels) {
		return false
	}
	for key, value := range create.Labels {
		if inspected.Config.Labels[key] != value {
			return false
		}
	}
	return network.Name == create.HostConfig.NetworkMode &&
		network.Labels["com.deploytide.fencing-token"] == create.Labels["com.deploytide.fencing-token"]
}

func (proxy *Proxy) inspectOwned(ctx context.Context, identifier string) (*upstreamResponse, *containerInspect, bool, error) {
	endpoint := "/" + proxy.apiVersion + "/containers/" + url.PathEscape(identifier) + "/json"
	upstream, err := proxy.call(ctx, http.MethodGet, endpoint, nil, maxInspectResponse)
	if err != nil {
		return nil, nil, false, err
	}
	if upstream.status < 200 || upstream.status >= 300 {
		return upstream, nil, false, nil
	}
	if err := rejectDuplicateJSONKeys(upstream.body); err != nil {
		return nil, nil, false, err
	}
	var inspected containerInspect
	if err := json.Unmarshal(upstream.body, &inspected); err != nil {
		return nil, nil, false, err
	}
	if !validateOwnedContainer(identifier, inspected) {
		return upstream, &inspected, false, nil
	}
	_, networkID, _, _ := containerNetwork(inspected)
	networkResponse, network, ownedNetwork, err := proxy.inspectOwnedNetwork(ctx, networkID)
	if err != nil {
		return nil, nil, false, err
	}
	if networkResponse == nil {
		return nil, nil, false, errors.New("Docker network inspection response was missing")
	}
	if networkResponse.status < 200 || networkResponse.status >= 300 || !ownedNetwork || network == nil ||
		network.Name != strings.TrimPrefix(inspected.Name, "/") || !networkMatchesContainerState(*network, inspected) ||
		network.Labels["com.deploytide.fencing-token"] != inspected.Config.Labels["com.deploytide.fencing-token"] {
		return upstream, &inspected, false, nil
	}
	return upstream, &inspected, true, nil
}

func (proxy *Proxy) inspectImage(response http.ResponseWriter, request *http.Request, digest string) {
	endpoint := "/" + proxy.apiVersion + "/images/" + url.PathEscape(digest) + "/json"
	upstream, err := proxy.call(request.Context(), http.MethodGet, endpoint, nil, maxInspectResponse)
	if err != nil {
		badGateway(response)
		return
	}
	if upstream.status >= 200 && upstream.status < 300 {
		if err := rejectDuplicateJSONKeys(upstream.body); err != nil {
			badGateway(response)
			return
		}
		var inspected struct {
			ID string `json:"Id"`
		}
		if json.Unmarshal(upstream.body, &inspected) != nil || inspected.ID != digest {
			deny(response)
			return
		}
	}
	writeUpstream(response, upstream, "application/json")
}

func validContainerIdentifier(identifier string) bool {
	if containerIDPattern.MatchString(identifier) {
		return true
	}
	if !strings.HasPrefix(identifier, "deploytide-release-") {
		return false
	}
	return releaseIDPattern.MatchString(strings.TrimPrefix(identifier, "deploytide-release-"))
}

func (proxy *Proxy) handleContainer(response http.ResponseWriter, request *http.Request) {
	prefix := "/" + proxy.apiVersion + "/containers/"
	remainder := strings.TrimPrefix(request.URL.Path, prefix)
	if strings.HasSuffix(remainder, "/json") {
		identifier := strings.TrimSuffix(remainder, "/json")
		if request.Method != http.MethodGet || request.URL.RawQuery != "" || !bodyless(request) ||
			!validContainerIdentifier(identifier) || !canonicalSegmentPath(request, prefix, identifier, "/json") {
			deny(response)
			return
		}
		upstream, _, owned, err := proxy.inspectOwned(request.Context(), identifier)
		if err != nil {
			badGateway(response)
			return
		}
		if upstream == nil {
			badGateway(response)
			return
		}
		if upstream.status >= 200 && upstream.status < 300 && !owned {
			deny(response)
			return
		}
		writeUpstream(response, upstream, "application/json")
		return
	}

	operation := ""
	identifier := ""
	for _, candidate := range []string{"/start", "/stop", "/logs"} {
		if strings.HasSuffix(remainder, candidate) {
			operation = strings.TrimPrefix(candidate, "/")
			identifier = strings.TrimSuffix(remainder, candidate)
			if !canonicalSegmentPath(request, prefix, identifier, candidate) {
				deny(response)
				return
			}
			break
		}
	}
	if operation == "" {
		identifier = remainder
		operation = "delete"
		if !canonicalSegmentPath(request, prefix, identifier, "") {
			deny(response)
			return
		}
	}
	if !containerIDPattern.MatchString(identifier) || !bodyless(request) {
		deny(response)
		return
	}

	endpoint := ""
	method := request.Method
	maximum := maxSmallResponse
	fallbackContentType := "application/json"
	switch operation {
	case "start":
		if method != http.MethodPost || request.URL.RawQuery != "" {
			deny(response)
			return
		}
		endpoint = prefix + identifier + "/start"
	case "stop":
		seconds, valid := canonicalStopSeconds(request.URL.RawQuery)
		if method != http.MethodPost || !valid {
			deny(response)
			return
		}
		if seconds > maxEffectiveStop {
			seconds = maxEffectiveStop
		}
		endpoint = prefix + identifier + "/stop?t=" + strconv.Itoa(seconds)
	case "logs":
		if method != http.MethodGet || !canonicalLogsQuery(request.URL.RawQuery) {
			deny(response)
			return
		}
		endpoint = prefix + identifier + "/logs?" + request.URL.RawQuery
		maximum = maxLogsResponse
		fallbackContentType = "application/octet-stream"
	case "delete":
		if method != http.MethodDelete || request.URL.RawQuery != "force=true&v=true" {
			deny(response)
			return
		}
		endpoint = prefix + identifier + "?force=true&v=true"
	default:
		deny(response)
		return
	}

	inspection, inspected, owned, err := proxy.inspectOwned(request.Context(), identifier)
	if err != nil {
		badGateway(response)
		return
	}
	if inspection == nil {
		badGateway(response)
		return
	}
	if inspection.status < 200 || inspection.status >= 300 {
		if operation == "delete" && inspection.status == http.StatusNotFound {
			confirm, _, _, confirmErr := proxy.inspectOwned(request.Context(), identifier)
			if confirmErr != nil || confirm == nil {
				badGateway(response)
				return
			}
			if confirm.status == http.StatusNotFound {
				writeUpstream(response, confirm, "application/json")
				return
			}
			deny(response)
			return
		}
		writeUpstream(response, inspection, "application/json")
		return
	}
	if !owned {
		deny(response)
		return
	}
	if operation == "start" && inspected != nil && !inspected.State.Running && inspected.State.Status != "created" {
		deny(response)
		return
	}
	upstream, err := proxy.call(request.Context(), method, endpoint, nil, maximum)
	if err != nil {
		badGateway(response)
		return
	}
	writeUpstream(response, upstream, fallbackContentType)
}

func canonicalStopSeconds(rawQuery string) (int, bool) {
	if !strings.HasPrefix(rawQuery, "t=") {
		return 0, false
	}
	value := strings.TrimPrefix(rawQuery, "t=")
	if !canonicalNumber.MatchString(value) {
		return 0, false
	}
	seconds, err := strconv.Atoi(value)
	return seconds, err == nil && seconds >= 0 && seconds <= 300 && rawQuery == "t="+strconv.Itoa(seconds)
}

func canonicalLogsQuery(rawQuery string) bool {
	const prefix = "stdout=true&stderr=true&timestamps=true&tail="
	if !strings.HasPrefix(rawQuery, prefix) {
		return false
	}
	value := strings.TrimPrefix(rawQuery, prefix)
	if !canonicalNumber.MatchString(value) {
		return false
	}
	tail, err := strconv.Atoi(value)
	return err == nil && tail >= 1 && tail <= 5000 && rawQuery == prefix+strconv.Itoa(tail)
}

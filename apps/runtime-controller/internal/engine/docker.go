package engine

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/mayowaoladosu/DeployTide/apps/runtime-controller/internal/controller"
)

var (
	identifierPattern  = regexp.MustCompile(`^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,191}$`)
	envKeyPattern      = regexp.MustCompile(`^[A-Z_][A-Z0-9_]{0,127}$`)
	imagePattern       = regexp.MustCompile(`^[a-z0-9][a-z0-9._/@:-]{0,511}$`)
	imageDigestPattern = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
	apiVersionPattern  = regexp.MustCompile(`^v1\.[0-9]{2}$`)
	containerIDPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

const (
	maxDockerJSONResponse = int64(2 * 1024 * 1024)
	maxDockerLogResponse  = int64(8 * 1024 * 1024)
	maxSafeFencingToken   = int64(9_007_199_254_740_991)
	maxEffectiveDrainWait = 25
)

type Docker struct {
	client     *http.Client
	apiVersion string
}

func NewDocker(socketPath, apiVersion string) (*Docker, error) {
	if socketPath == "" {
		return nil, errors.New("docker socket path is required")
	}
	if apiVersion == "" {
		apiVersion = "v1.47"
	}
	if !apiVersionPattern.MatchString(apiVersion) {
		return nil, errors.New("docker API version is invalid")
	}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socketPath)
		},
		DisableCompression: true,
	}
	return &Docker{
		client:     &http.Client{Transport: transport, Timeout: 30 * time.Second},
		apiVersion: apiVersion,
	}, nil
}

func (docker *Docker) request(ctx context.Context, method, endpoint string, body any, output any) error {
	var payload io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		payload = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(
		ctx,
		method,
		"http://docker/"+docker.apiVersion+endpoint,
		payload,
	)
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := docker.client.Do(request)
	if err != nil {
		return fmt.Errorf("docker operation failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var apiError struct {
			Message string `json:"message"`
		}
		_ = json.NewDecoder(io.LimitReader(response.Body, 32*1024)).Decode(&apiError)
		if apiError.Message == "" {
			apiError.Message = response.Status
		}
		return &dockerError{status: response.StatusCode, message: apiError.Message}
	}
	if output == nil {
		written, copyErr := io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024+1))
		if copyErr != nil {
			return copyErr
		}
		if written > 64*1024 {
			return errors.New("docker response exceeds the allowed size")
		}
		return nil
	}
	if writer, ok := output.(io.Writer); ok {
		written, copyErr := io.Copy(writer, io.LimitReader(response.Body, maxDockerLogResponse+1))
		if copyErr != nil {
			return copyErr
		}
		if written > maxDockerLogResponse {
			return errors.New("docker log response exceeds the allowed size")
		}
		return nil
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, maxDockerJSONResponse+1))
	if err := decoder.Decode(output); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("docker response contains trailing JSON")
		}
		return err
	}
	return nil
}

type dockerError struct {
	status  int
	message string
}

func (err *dockerError) Error() string {
	return fmt.Sprintf("docker API %d: %s", err.status, err.message)
}

func releaseContainerName(releaseID string) string {
	return "deploytide-release-" + releaseID
}

func releaseNetworkName(releaseID string) string {
	return "deploytide-release-" + releaseID
}

type imageInspect struct {
	ID string `json:"Id"`
}

type containerInspect struct {
	ID    string `json:"Id"`
	Image string `json:"Image"`
	State struct {
		Status  string `json:"Status"`
		Running bool   `json:"Running"`
	} `json:"State"`
	RestartCount int `json:"RestartCount"`
	Config       struct {
		Image        string                         `json:"Image"`
		User         string                         `json:"User"`
		Labels       map[string]string              `json:"Labels"`
		ExposedPorts map[string]map[string]struct{} `json:"ExposedPorts"`
	} `json:"Config"`
	HostConfig struct {
		NetworkMode string `json:"NetworkMode"`
		Memory      int64  `json:"Memory"`
		NanoCPUs    int64  `json:"NanoCpus"`
	} `json:"HostConfig"`
	NetworkSettings struct {
		Ports map[string][]struct {
			HostIP   string `json:"HostIp"`
			HostPort string `json:"HostPort"`
		} `json:"Ports"`
		Networks map[string]struct {
			NetworkID string `json:"NetworkID"`
		} `json:"Networks"`
	} `json:"NetworkSettings"`
}

type networkInspect struct {
	ID         string            `json:"Id"`
	Name       string            `json:"Name"`
	Driver     string            `json:"Driver"`
	Scope      string            `json:"Scope"`
	Internal   bool              `json:"Internal"`
	Attachable bool              `json:"Attachable"`
	Ingress    bool              `json:"Ingress"`
	Options    map[string]string `json:"Options"`
	Labels     map[string]string `json:"Labels"`
	Containers map[string]struct {
		Name string `json:"Name"`
	} `json:"Containers"`
}

func (docker *Docker) inspectContainer(ctx context.Context, name string) (*containerInspect, error) {
	var inspected containerInspect
	err := docker.request(ctx, http.MethodGet, "/containers/"+url.PathEscape(name)+"/json", nil, &inspected)
	var apiError *dockerError
	if errors.As(err, &apiError) && apiError.status == http.StatusNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &inspected, nil
}

func (docker *Docker) inspectNetwork(ctx context.Context, identifier string) (*networkInspect, error) {
	var inspected networkInspect
	err := docker.request(ctx, http.MethodGet, "/networks/"+url.PathEscape(identifier), nil, &inspected)
	var apiError *dockerError
	if errors.As(err, &apiError) && apiError.status == http.StatusNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &inspected, nil
}

func runtimeContainerLabels(releaseID, digest string, fencingToken int64) map[string]string {
	return map[string]string{
		"com.deploytide.plane":           "runtime",
		"com.deploytide.release":         releaseID,
		"com.deploytide.image-digest":    digest,
		"com.deploytide.fencing-token":   strconv.FormatInt(fencingToken, 10),
		"com.deploytide.controller-mode": "typed",
	}
}

func runtimeNetworkLabels(releaseID string, fencingToken int64) map[string]string {
	return map[string]string{
		"com.deploytide.plane":           "runtime",
		"com.deploytide.release":         releaseID,
		"com.deploytide.fencing-token":   strconv.FormatInt(fencingToken, 10),
		"com.deploytide.controller-mode": "typed",
	}
}

func labelsEqual(actual, expected map[string]string) bool {
	if len(actual) != len(expected) {
		return false
	}
	for key, value := range expected {
		if actual[key] != value {
			return false
		}
	}
	return true
}

func validReleaseNetwork(network *networkInspect, releaseID string, fencingToken int64) bool {
	return network != nil && containerIDPattern.MatchString(network.ID) &&
		network.Name == releaseNetworkName(releaseID) &&
		network.Driver == "bridge" && network.Scope == "local" && !network.Internal &&
		!network.Attachable && !network.Ingress && len(network.Options) == 2 &&
		network.Options["com.docker.network.bridge.enable_icc"] == "false" &&
		network.Options["com.docker.network.bridge.host_binding_ipv4"] == "127.0.0.1" &&
		labelsEqual(network.Labels, runtimeNetworkLabels(releaseID, fencingToken))
}

func prepareEnvironment(environment map[string]string) ([]string, error) {
	if len(environment) > 256 {
		return nil, errors.New("runtime environment contains too many entries")
	}
	keys := make([]string, 0, len(environment))
	for key := range environment {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	entries := make([]string, 0, len(keys))
	totalBytes := 0
	for _, key := range keys {
		value := environment[key]
		entry := key + "=" + value
		totalBytes += len(entry)
		if !envKeyPattern.MatchString(key) || len(value) > 32768 || totalBytes > 512*1024 {
			return nil, errors.New("runtime environment entry is invalid")
		}
		entries = append(entries, entry)
	}
	return entries, nil
}

func (docker *Docker) createReleaseNetwork(ctx context.Context, releaseID string, fencingToken int64) (*networkInspect, error) {
	name := releaseNetworkName(releaseID)
	createRequest := map[string]any{
		"Name":           name,
		"CheckDuplicate": true,
		"Driver":         "bridge",
		"Internal":       false,
		"Attachable":     false,
		"Ingress":        false,
		"Options": map[string]string{
			"com.docker.network.bridge.enable_icc":        "false",
			"com.docker.network.bridge.host_binding_ipv4": "127.0.0.1",
		},
		"Labels": runtimeNetworkLabels(releaseID, fencingToken),
	}
	var created struct {
		ID string `json:"Id"`
	}
	if err := docker.request(ctx, http.MethodPost, "/networks/create", createRequest, &created); err != nil {
		return nil, err
	}
	if !containerIDPattern.MatchString(created.ID) {
		return nil, errors.New("docker returned an invalid runtime network identity")
	}
	network, err := docker.inspectNetwork(ctx, created.ID)
	if err != nil {
		return nil, err
	}
	if !validReleaseNetwork(network, releaseID, fencingToken) {
		return nil, errors.New("runtime network inspection did not match the protected release")
	}
	return network, nil
}

func (docker *Docker) startContainer(ctx context.Context, identifier string) error {
	err := docker.request(ctx, http.MethodPost, "/containers/"+identifier+"/start", nil, nil)
	var apiError *dockerError
	if errors.As(err, &apiError) && apiError.status == http.StatusNotModified {
		return nil
	}
	return err
}

func releaseResult(request controller.ReleaseCreateRequest, fencingToken int64, container *containerInspect, network *networkInspect) (map[string]any, error) {
	if container == nil || !containerIDPattern.MatchString(container.ID) || !container.State.Running ||
		container.Image != request.ImageDigest || container.Config.Image != request.ImageDigest ||
		container.Config.User != "65534:65534" ||
		container.HostConfig.Memory != request.MemoryMB*1024*1024 ||
		container.HostConfig.NanoCPUs != request.CPUMillis*1_000_000 ||
		!labelsEqual(container.Config.Labels, runtimeContainerLabels(request.ReleaseID, request.ImageDigest, fencingToken)) ||
		!validReleaseNetwork(network, request.ReleaseID, fencingToken) {
		return nil, errors.New("runtime placement inspection was not safe")
	}
	name := releaseContainerName(request.ReleaseID)
	portKey := strconv.Itoa(request.ContainerPort) + "/tcp"
	exposed, exposedPortExists := container.Config.ExposedPorts[portKey]
	if container.HostConfig.NetworkMode != name || len(container.Config.ExposedPorts) != 1 ||
		!exposedPortExists || len(exposed) != 0 || len(container.NetworkSettings.Networks) != 1 {
		return nil, errors.New("runtime placement network metadata was not safe")
	}
	attached, exists := container.NetworkSettings.Networks[name]
	networkContainer, attachedToNetwork := network.Containers[container.ID]
	if !exists || attached.NetworkID != network.ID || len(network.Containers) != 1 ||
		!attachedToNetwork || networkContainer.Name != name {
		return nil, errors.New("runtime placement was not attached to its protected network")
	}
	bindings := container.NetworkSettings.Ports[portKey]
	if len(container.NetworkSettings.Ports) != 1 || len(bindings) != 1 || bindings[0].HostIP != "127.0.0.1" {
		return nil, errors.New("runtime placement did not expose one loopback endpoint")
	}
	hostPort, err := strconv.Atoi(bindings[0].HostPort)
	if err != nil || hostPort < 1 || hostPort > 65535 || strconv.Itoa(hostPort) != bindings[0].HostPort {
		return nil, errors.New("runtime placement host port was invalid")
	}
	return map[string]any{
		"runtimePlacementReference": container.ID,
		"imageDigest":               container.Image,
		"endpoint":                  "http://127.0.0.1:" + bindings[0].HostPort,
	}, nil
}

func (docker *Docker) observeContainerAbsent(ctx context.Context, name string) error {
	container, err := docker.inspectContainer(ctx, name)
	if err != nil {
		return err
	}
	if container != nil {
		return errors.New("runtime placement still exists after deletion")
	}
	return nil
}

func (docker *Docker) deleteContainerAndObserve(ctx context.Context, name, identifier string) error {
	err := docker.request(ctx, http.MethodDelete, "/containers/"+identifier+"?force=true&v=true", nil, nil)
	var apiError *dockerError
	if err != nil && (!errors.As(err, &apiError) || apiError.status != http.StatusNotFound) {
		return err
	}
	return docker.observeContainerAbsent(ctx, name)
}

func (docker *Docker) removeNetworkAndObserve(ctx context.Context, name string, expectedFencingToken *int64) error {
	network, err := docker.inspectNetwork(ctx, name)
	if err != nil {
		return err
	}
	if network == nil {
		return nil
	}
	releaseID := strings.TrimPrefix(name, "deploytide-release-")
	fencingToken := int64(0)
	if expectedFencingToken != nil {
		fencingToken = *expectedFencingToken
	} else {
		parsed, parseErr := strconv.ParseInt(network.Labels["com.deploytide.fencing-token"], 10, 64)
		if parseErr == nil && parsed >= 1 && parsed <= maxSafeFencingToken &&
			strconv.FormatInt(parsed, 10) == network.Labels["com.deploytide.fencing-token"] {
			fencingToken = parsed
		}
	}
	if !identifierPattern.MatchString(releaseID) || fencingToken == 0 ||
		!validReleaseNetwork(network, releaseID, fencingToken) || len(network.Containers) != 0 {
		return errors.New("refusing to remove an unsafe or occupied runtime network")
	}
	err = docker.request(ctx, http.MethodDelete, "/networks/"+network.ID, nil, nil)
	var apiError *dockerError
	if err != nil && (!errors.As(err, &apiError) || apiError.status != http.StatusNotFound) {
		return err
	}
	network, err = docker.inspectNetwork(ctx, name)
	if err != nil {
		return err
	}
	if network != nil {
		return errors.New("runtime network still exists after deletion")
	}
	return nil
}

func (docker *Docker) cleanupReleasePlacement(containerID, name string, fencingToken int64) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var cleanupErrors []error
	if containerID != "" {
		if err := docker.deleteContainerAndObserve(ctx, name, containerID); err != nil {
			cleanupErrors = append(cleanupErrors, fmt.Errorf("delete failed runtime placement: %w", err))
		}
	}
	if err := docker.removeNetworkAndObserve(ctx, name, &fencingToken); err != nil {
		cleanupErrors = append(cleanupErrors, fmt.Errorf("delete failed runtime network: %w", err))
	}
	return errors.Join(cleanupErrors...)
}

func operationWithCleanupError(operationErr, cleanupErr error) error {
	if cleanupErr == nil {
		return operationErr
	}
	return errors.Join(operationErr, fmt.Errorf("release cleanup failed: %w", cleanupErr))
}

func (docker *Docker) CreateRelease(ctx context.Context, request controller.ReleaseCreateRequest, fencingToken int64) (map[string]any, error) {
	if !identifierPattern.MatchString(request.ReleaseID) || !imagePattern.MatchString(request.Image) {
		return nil, errors.New("release identity or image reference is invalid")
	}
	if !imageDigestPattern.MatchString(request.ImageDigest) || fencingToken < 1 || fencingToken > maxSafeFencingToken {
		return nil, errors.New("release image digest or fencing token is invalid")
	}
	if request.ContainerPort < 1 || request.ContainerPort > 65535 ||
		request.CPUMillis < 10 || request.CPUMillis > 1_024_000 ||
		request.MemoryMB < 6 || request.MemoryMB > 1024*1024 {
		return nil, errors.New("release resource specification is invalid")
	}
	environment, err := prepareEnvironment(request.Environment)
	if err != nil {
		return nil, err
	}
	var image imageInspect
	if err := docker.request(ctx, http.MethodGet, "/images/"+url.PathEscape(request.ImageDigest)+"/json", nil, &image); err != nil {
		return nil, err
	}
	if image.ID != request.ImageDigest {
		return nil, errors.New("release image digest does not match registry resolution")
	}
	name := releaseContainerName(request.ReleaseID)
	existing, err := docker.inspectContainer(ctx, name)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		if existing.Config.Labels["com.deploytide.fencing-token"] != strconv.FormatInt(fencingToken, 10) ||
			existing.Config.Labels["com.deploytide.image-digest"] != request.ImageDigest ||
			existing.Image != request.ImageDigest {
			return nil, errors.New("release placement exists under another fencing token")
		}
		network, err := docker.inspectNetwork(ctx, releaseNetworkName(request.ReleaseID))
		if err != nil {
			return nil, err
		}
		if !validReleaseNetwork(network, request.ReleaseID, fencingToken) {
			return nil, errors.New("release placement network belongs to another fencing token")
		}
		startedExisting := false
		if !existing.State.Running {
			if existing.State.Status != "created" {
				return nil, errors.New("same-fence runtime placement is not startable")
			}
			existingContainerID := existing.ID
			if err := docker.startContainer(ctx, existingContainerID); err != nil {
				cleanupErr := docker.cleanupReleasePlacement(existingContainerID, name, fencingToken)
				return nil, operationWithCleanupError(err, cleanupErr)
			}
			startedExisting = true
			existing, err = docker.inspectContainer(ctx, existingContainerID)
			if err != nil || existing == nil {
				if err == nil {
					err = errors.New("started runtime placement disappeared")
				}
				cleanupErr := docker.cleanupReleasePlacement(existingContainerID, name, fencingToken)
				return nil, operationWithCleanupError(err, cleanupErr)
			}
			network, err = docker.inspectNetwork(ctx, network.ID)
			if err != nil {
				cleanupErr := docker.cleanupReleasePlacement(existing.ID, name, fencingToken)
				return nil, operationWithCleanupError(err, cleanupErr)
			}
		}
		result, err := releaseResult(request, fencingToken, existing, network)
		if err != nil {
			if startedExisting {
				cleanupErr := docker.cleanupReleasePlacement(existing.ID, name, fencingToken)
				return nil, operationWithCleanupError(err, cleanupErr)
			}
			return nil, err
		}
		return result, nil
	}

	network, err := docker.inspectNetwork(ctx, releaseNetworkName(request.ReleaseID))
	if err != nil {
		return nil, err
	}
	if network != nil && !validReleaseNetwork(network, request.ReleaseID, fencingToken) {
		return nil, errors.New("release network exists under another fencing token")
	}
	if network == nil {
		network, err = docker.createReleaseNetwork(ctx, request.ReleaseID, fencingToken)
		if err != nil {
			cleanupErr := docker.cleanupReleasePlacement("", name, fencingToken)
			return nil, operationWithCleanupError(err, cleanupErr)
		}
	}
	portKey := strconv.Itoa(request.ContainerPort) + "/tcp"
	createRequest := map[string]any{
		"Image":        image.ID,
		"User":         "65534:65534",
		"Env":          environment,
		"Labels":       runtimeContainerLabels(request.ReleaseID, request.ImageDigest, fencingToken),
		"ExposedPorts": map[string]any{portKey: map[string]any{}},
		"HostConfig": map[string]any{
			"AutoRemove":      false,
			"CapDrop":         []string{"ALL"},
			"ReadonlyRootfs":  true,
			"PidsLimit":       128,
			"Memory":          request.MemoryMB * 1024 * 1024,
			"NanoCpus":        request.CPUMillis * 1_000_000,
			"NetworkMode":     name,
			"PortBindings":    map[string]any{portKey: []map[string]string{{"HostIp": "127.0.0.1", "HostPort": ""}}},
			"PublishAllPorts": false,
			"SecurityOpt":     []string{"no-new-privileges"},
			"Tmpfs": map[string]string{
				"/tmp": "rw,nosuid,nodev,noexec,size=32m,uid=65534,gid=65534",
			},
		},
	}
	var created struct {
		ID string `json:"Id"`
	}
	if err := docker.request(ctx, http.MethodPost, "/containers/create?name="+url.QueryEscape(name), createRequest, &created); err != nil {
		cleanupErr := docker.cleanupReleasePlacement("", name, fencingToken)
		return nil, operationWithCleanupError(err, cleanupErr)
	}
	if !containerIDPattern.MatchString(created.ID) {
		err := errors.New("docker returned an invalid runtime placement identity")
		cleanupErr := docker.cleanupReleasePlacement("", name, fencingToken)
		return nil, operationWithCleanupError(err, cleanupErr)
	}
	if err := docker.startContainer(ctx, created.ID); err != nil {
		cleanupErr := docker.cleanupReleasePlacement(created.ID, name, fencingToken)
		return nil, operationWithCleanupError(err, cleanupErr)
	}
	inspected, err := docker.inspectContainer(ctx, created.ID)
	if err != nil || inspected == nil {
		if err == nil {
			err = errors.New("created runtime placement disappeared")
		}
		cleanupErr := docker.cleanupReleasePlacement(created.ID, name, fencingToken)
		return nil, operationWithCleanupError(err, cleanupErr)
	}
	network, err = docker.inspectNetwork(ctx, network.ID)
	if err != nil {
		cleanupErr := docker.cleanupReleasePlacement(created.ID, name, fencingToken)
		return nil, operationWithCleanupError(err, cleanupErr)
	}
	result, err := releaseResult(request, fencingToken, inspected, network)
	if err != nil {
		cleanupErr := docker.cleanupReleasePlacement(created.ID, name, fencingToken)
		return nil, operationWithCleanupError(err, cleanupErr)
	}
	return result, nil
}

func (docker *Docker) ReleaseHealth(ctx context.Context, releaseID string) (map[string]any, error) {
	if !identifierPattern.MatchString(releaseID) {
		return nil, errors.New("release identifier is invalid")
	}
	container, err := docker.inspectContainer(ctx, releaseContainerName(releaseID))
	if err != nil {
		return nil, err
	}
	if container == nil {
		return map[string]any{"health": "unhealthy", "reason": "placement_missing"}, nil
	}
	health := "unhealthy"
	if container.State.Running {
		health = "healthy"
	} else if container.State.Status == "created" {
		health = "starting"
	}
	return map[string]any{"health": health, "status": container.State.Status, "restartCount": container.RestartCount}, nil
}

func (docker *Docker) DrainRelease(ctx context.Context, releaseID string, graceSeconds int) (map[string]any, error) {
	if !identifierPattern.MatchString(releaseID) || graceSeconds < 0 || graceSeconds > 300 {
		return nil, errors.New("release drain request is invalid")
	}
	name := releaseContainerName(releaseID)
	container, err := docker.inspectContainer(ctx, name)
	if err != nil {
		return nil, err
	}
	if container != nil {
		effectiveGrace := graceSeconds
		if effectiveGrace > maxEffectiveDrainWait {
			effectiveGrace = maxEffectiveDrainWait
		}
		stopEndpoint := "/containers/" + container.ID + "/stop?t=" + strconv.Itoa(effectiveGrace)
		if err := docker.request(ctx, http.MethodPost, stopEndpoint, nil, nil); err != nil {
			var apiError *dockerError
			if !errors.As(err, &apiError) || (apiError.status != http.StatusNotModified && apiError.status != http.StatusNotFound) {
				return nil, err
			}
			if apiError.status == http.StatusNotFound {
				if err := docker.observeContainerAbsent(ctx, name); err != nil {
					return nil, err
				}
			}
		}
		if err := docker.deleteContainerAndObserve(ctx, name, container.ID); err != nil {
			return nil, err
		}
	}
	if err := docker.removeNetworkAndObserve(ctx, releaseNetworkName(releaseID), nil); err != nil {
		return nil, err
	}
	return map[string]any{"drained": true}, nil
}

func decodeMultiplexedLogs(data []byte) []string {
	var output bytes.Buffer
	reader := bufio.NewReader(bytes.NewReader(data))
	for {
		header := make([]byte, 8)
		if _, err := io.ReadFull(reader, header); err != nil {
			break
		}
		size := binary.BigEndian.Uint32(header[4:])
		if size > 8*1024*1024 {
			break
		}
		chunk := make([]byte, size)
		if _, err := io.ReadFull(reader, chunk); err != nil {
			break
		}
		output.Write(chunk)
	}
	if output.Len() == 0 {
		output.Write(data)
	}
	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) == 1 && lines[0] == "" {
		return nil
	}
	return lines
}

func (docker *Docker) ReleaseLogs(ctx context.Context, releaseID string, tail int) (map[string]any, error) {
	if !identifierPattern.MatchString(releaseID) || tail < 1 || tail > 5000 {
		return nil, errors.New("release log request is invalid")
	}
	container, err := docker.inspectContainer(ctx, releaseContainerName(releaseID))
	if err != nil || container == nil {
		return nil, err
	}
	var logs bytes.Buffer
	endpoint := "/containers/" + container.ID + "/logs?stdout=true&stderr=true&timestamps=true&tail=" + strconv.Itoa(tail)
	if err := docker.request(ctx, http.MethodGet, endpoint, nil, &logs); err != nil {
		return nil, err
	}
	return map[string]any{"lines": decodeMultiplexedLogs(logs.Bytes())}, nil
}

func (docker *Docker) ClusterHealth(ctx context.Context) (map[string]any, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker/_ping", nil)
	if err != nil {
		return nil, err
	}
	response, err := docker.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("docker ping failed: %s", response.Status)
	}
	ping, err := io.ReadAll(io.LimitReader(response.Body, 16))
	if err != nil || strings.TrimSpace(string(ping)) != "OK" {
		return nil, errors.New("docker ping response is invalid")
	}
	var version map[string]any
	if err := docker.request(ctx, http.MethodGet, "/version", nil, &version); err != nil {
		return nil, err
	}
	return map[string]any{"health": "healthy", "version": version["Version"]}, nil
}

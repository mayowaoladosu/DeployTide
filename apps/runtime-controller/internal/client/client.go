package client

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/mayowaoladosu/DeployTide/apps/runtime-controller/internal/controller"
	"github.com/mayowaoladosu/DeployTide/apps/runtime-controller/internal/protocol"
)

var protectedIdentifierPattern = regexp.MustCompile(`^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,191}$`)

type TLSFiles struct {
	Certificate string
	PrivateKey  string
	CA          string
	ServerName  string
}

type Client struct {
	baseURL         *url.URL
	clusterID       string
	runtimeTargetID string
	tlsFiles        TLSFiles
	timeout         time.Duration
}

func New(baseURL, clusterID, runtimeTargetID string, files TLSFiles) (*Client, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
		return nil, errors.New("control plane URL must be credential-free HTTPS")
	}
	if !protectedIdentifierPattern.MatchString(clusterID) {
		return nil, errors.New("cluster ID is invalid")
	}
	if !protectedIdentifierPattern.MatchString(runtimeTargetID) {
		return nil, errors.New("runtime target ID is invalid")
	}
	if files.Certificate == "" || files.PrivateKey == "" || files.CA == "" {
		return nil, errors.New("outbound mTLS configuration is incomplete")
	}
	return &Client{
		baseURL: parsed, clusterID: clusterID, runtimeTargetID: runtimeTargetID,
		tlsFiles: files, timeout: 30 * time.Second,
	}, nil
}

func (client *Client) httpClient() (*http.Client, error) {
	certificate, err := tls.LoadX509KeyPair(client.tlsFiles.Certificate, client.tlsFiles.PrivateKey)
	if err != nil {
		return nil, fmt.Errorf("load controller certificate: %w", err)
	}
	caPEM, err := os.ReadFile(client.tlsFiles.CA)
	if err != nil {
		return nil, fmt.Errorf("load controller CA: %w", err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caPEM) {
		return nil, errors.New("controller CA bundle is invalid")
	}
	transport := &http.Transport{
		TLSClientConfig: &tls.Config{
			Certificates: []tls.Certificate{certificate},
			RootCAs:      roots,
			ServerName:   client.tlsFiles.ServerName,
			MinVersion:   tls.VersionTLS13,
		},
		ForceAttemptHTTP2: true,
	}
	return &http.Client{Transport: transport, Timeout: client.timeout}, nil
}

func (client *Client) request(ctx context.Context, method, endpoint string, body any, output any) error {
	httpClient, err := client.httpClient()
	if err != nil {
		return err
	}
	defer httpClient.CloseIdleConnections()
	var payload io.Reader
	if body != nil {
		encoded, marshalErr := json.Marshal(body)
		if marshalErr != nil {
			return marshalErr
		}
		payload = bytes.NewReader(encoded)
	}
	target := *client.baseURL
	endpointPath, rawQuery, _ := strings.Cut(endpoint, "?")
	target.Path = path.Join(strings.TrimSuffix(client.baseURL.Path, "/"), endpointPath)
	target.RawQuery = rawQuery
	request, err := http.NewRequestWithContext(ctx, method, target.String(), payload)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-DeployTide-Runtime-Target", client.runtimeTargetID)
	response, err := httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("control plane returned status %d", response.StatusCode)
	}
	if output == nil || response.StatusCode == http.StatusNoContent {
		_, _ = io.Copy(io.Discard, response.Body)
		return nil
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 2*1024*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("control plane response contains trailing JSON")
		}
		return err
	}
	return nil
}

func (client *Client) NextJob(ctx context.Context, afterSequence int64) (*protocol.Envelope, error) {
	var response struct {
		Job *protocol.Envelope `json:"job"`
	}
	endpoint := "/api/operator/controllers/" + url.PathEscape(client.clusterID) + "/jobs?afterSequence=" + strconv.FormatInt(afterSequence, 10)
	if err := client.request(ctx, http.MethodGet, endpoint, nil, &response); err != nil {
		return nil, err
	}
	return response.Job, nil
}

func (client *Client) Acknowledge(ctx context.Context, envelope protocol.Envelope) error {
	endpoint := "/api/operator/controllers/" + url.PathEscape(client.clusterID) + "/jobs/" + url.PathEscape(envelope.AttemptID) + "/ack"
	return client.request(ctx, http.MethodPost, endpoint, map[string]any{
		"fencingToken": envelope.FencingToken,
	}, nil)
}

func (client *Client) Complete(ctx context.Context, pending controller.PendingCompletion) error {
	endpoint := "/api/operator/controllers/" + url.PathEscape(client.clusterID) + "/jobs/" + url.PathEscape(pending.AttemptID) + "/result"
	return client.request(ctx, http.MethodPost, endpoint, map[string]any{
		"fencingToken": pending.FencingToken,
		"result":       pending.Result,
	}, nil)
}

func (client *Client) Heartbeat(ctx context.Context, version, health string) error {
	endpoint := "/api/operator/controllers/" + url.PathEscape(client.clusterID) + "/heartbeat"
	return client.request(ctx, http.MethodPost, endpoint, map[string]string{
		"runtimeTargetId": client.runtimeTargetID,
		"version":         version,
		"health":          health,
	}, nil)
}

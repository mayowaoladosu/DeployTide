package client_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mayowaoladosu/DeployTide/apps/runtime-controller/internal/client"
	"github.com/mayowaoladosu/DeployTide/apps/runtime-controller/internal/controller"
	"github.com/mayowaoladosu/DeployTide/apps/runtime-controller/internal/protocol"
)

type certificateAuthority struct {
	certificate *x509.Certificate
	privateKey  ed25519.PrivateKey
	pem         []byte
}

func newCA(t *testing.T) certificateAuthority {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "DeployTide test CA"},
		NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true,
		KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, publicKey, privateKey)
	if err != nil {
		t.Fatal(err)
	}
	certificate, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return certificateAuthority{
		certificate: certificate, privateKey: privateKey,
		pem: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
	}
}

func issueCertificate(t *testing.T, ca certificateAuthority, serial int64, commonName string, server bool) ([]byte, []byte) {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	usage := []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}
	dnsNames := []string(nil)
	if server {
		usage = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}
		dnsNames = []string{"localhost"}
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(serial), Subject: pkix.Name{CommonName: commonName},
		NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: usage, DNSNames: dnsNames,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, ca.certificate, publicKey, ca.privateKey)
	if err != nil {
		t.Fatal(err)
	}
	privateBytes, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateBytes})
}

func TestClientReloadsRotatedCertificateAndRevocationTakesEffect(t *testing.T) {
	ca := newCA(t)
	serverCertPEM, serverKeyPEM := issueCertificate(t, ca, 10, "localhost", true)
	serverCertificate, err := x509.ParseCertificate(func() []byte { block, _ := pem.Decode(serverCertPEM); return block.Bytes }())
	if err != nil {
		t.Fatal(err)
	}
	serverPrivateBlock, _ := pem.Decode(serverKeyPEM)
	serverPrivateAny, err := x509.ParsePKCS8PrivateKey(serverPrivateBlock.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	serverPrivate := serverPrivateAny.(ed25519.PrivateKey)
	serverTLS := struct {
		Certificate [][]byte
		PrivateKey  any
	}{Certificate: [][]byte{serverCertificate.Raw}, PrivateKey: serverPrivate}

	clientOneCert, clientOneKey := issueCertificate(t, ca, 101, "deploytide-controller:cluster-a", false)
	clientTwoCert, clientTwoKey := issueCertificate(t, ca, 102, "deploytide-controller:cluster-a", false)
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(ca.pem)
	var mu sync.RWMutex
	allowedSerial := "101"
	var requests []string
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if target := request.Header.Get("X-DeployTide-Runtime-Target"); target != "target-a" {
			t.Errorf("request used the wrong runtime target header: %q", target)
		}
		if request.URL.Path == "/api/operator/controllers/cluster-a/heartbeat" {
			var heartbeat struct {
				RuntimeTargetID string `json:"runtimeTargetId"`
			}
			if err := json.NewDecoder(request.Body).Decode(&heartbeat); err != nil {
				t.Errorf("decode heartbeat body: %v", err)
			} else if heartbeat.RuntimeTargetID != "target-a" {
				t.Errorf("heartbeat used the wrong runtime target body: %q", heartbeat.RuntimeTargetID)
			}
		}
		requests = append(requests, request.Method+" "+request.URL.Path+func() string {
			if request.URL.RawQuery == "" {
				return ""
			}
			return "?" + request.URL.RawQuery
		}())
		response.Header().Set("Content-Type", "application/json")
		if request.Method == http.MethodGet {
			_, _ = response.Write([]byte(`{"job":null}`))
			return
		}
		response.WriteHeader(http.StatusNoContent)
	}))
	server.TLS = &tls.Config{}
	server.TLS.Certificates = []tls.Certificate{{Certificate: serverTLS.Certificate, PrivateKey: serverTLS.PrivateKey}}
	server.TLS.ClientAuth = tls.RequireAndVerifyClientCert
	server.TLS.ClientCAs = pool
	server.TLS.MinVersion = tls.VersionTLS13
	server.TLS.VerifyConnection = func(state tls.ConnectionState) error {
		mu.RLock()
		defer mu.RUnlock()
		if len(state.PeerCertificates) == 0 {
			return x509.CertificateInvalidError{Cert: serverCertificate, Reason: x509.Expired}
		}
		if state.PeerCertificates[0].SerialNumber.String() != allowedSerial {
			return x509.CertificateInvalidError{Cert: state.PeerCertificates[0], Reason: x509.Expired}
		}
		return nil
	}
	server.StartTLS()
	defer server.Close()

	directory := t.TempDir()
	certPath := filepath.Join(directory, "client.pem")
	keyPath := filepath.Join(directory, "client-key.pem")
	caPath := filepath.Join(directory, "ca.pem")
	if err := os.WriteFile(certPath, clientOneCert, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, clientOneKey, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(caPath, ca.pem, 0o600); err != nil {
		t.Fatal(err)
	}
	controlClient, err := client.New(server.URL, "cluster-a", "target-a", client.TLSFiles{
		Certificate: certPath, PrivateKey: keyPath, CA: caPath, ServerName: "localhost",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := controlClient.NextJob(context.Background(), 0); err != nil {
		t.Fatalf("first certificate failed: %v", err)
	}
	identity := protocol.Envelope{AttemptID: "attempt-a", FencingToken: 7}
	if err := controlClient.Acknowledge(context.Background(), identity); err != nil {
		t.Fatal(err)
	}
	if err := controlClient.Complete(context.Background(), controller.PendingCompletion{
		AttemptID: "attempt-a", FencingToken: 7,
		Result: controller.Result{Succeeded: true},
	}); err != nil {
		t.Fatal(err)
	}
	if err := controlClient.Heartbeat(context.Background(), "1.0.0", "healthy"); err != nil {
		t.Fatal(err)
	}
	expectedRequests := []string{
		"GET /api/operator/controllers/cluster-a/jobs?afterSequence=0",
		"POST /api/operator/controllers/cluster-a/jobs/attempt-a/ack",
		"POST /api/operator/controllers/cluster-a/jobs/attempt-a/result",
		"POST /api/operator/controllers/cluster-a/heartbeat",
	}
	if len(requests) != len(expectedRequests) {
		t.Fatalf("controller used an unexpected number of API routes: %v", requests)
	}
	for index, expected := range expectedRequests {
		if requests[index] != expected {
			t.Fatalf("controller used the wrong API route: want=%q got=%q", expected, requests[index])
		}
	}
	mu.Lock()
	allowedSerial = "102"
	mu.Unlock()
	if _, err := controlClient.NextJob(context.Background(), 0); err == nil {
		t.Fatal("revoked client certificate was still accepted")
	}
	if err := os.WriteFile(certPath, clientTwoCert, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, clientTwoKey, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := controlClient.NextJob(context.Background(), 0); err != nil {
		t.Fatalf("rotated certificate was not reloaded: %v", err)
	}
}

func TestNewRejectsInvalidClusterAndRuntimeTargetIdentities(t *testing.T) {
	files := client.TLSFiles{Certificate: "client.pem", PrivateKey: "client-key.pem", CA: "ca.pem"}
	tests := []struct {
		name            string
		clusterID       string
		runtimeTargetID string
	}{
		{name: "empty cluster", clusterID: "", runtimeTargetID: "target-a"},
		{name: "cluster with separator", clusterID: "cluster/a", runtimeTargetID: "target-a"},
		{name: "oversized cluster", clusterID: strings.Repeat("a", 193), runtimeTargetID: "target-a"},
		{name: "empty runtime target", clusterID: "cluster-a", runtimeTargetID: ""},
		{name: "runtime target beginning with dot", clusterID: "cluster-a", runtimeTargetID: ".target-a"},
		{name: "non-ASCII runtime target", clusterID: "cluster-a", runtimeTargetID: "target-é"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := client.New("https://control.deploytide.test", test.clusterID, test.runtimeTargetID, files); err == nil {
				t.Fatal("New accepted an invalid protected identity")
			}
		})
	}
}

package main

import (
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/mayowaoladosu/DeployTide/apps/runtime-controller/internal/client"
	"github.com/mayowaoladosu/DeployTide/apps/runtime-controller/internal/controller"
	"github.com/mayowaoladosu/DeployTide/apps/runtime-controller/internal/engine"
)

const version = "0.1.0"

func required(name string) string {
	value := os.Getenv(name)
	if value == "" {
		slog.Error("required runtime controller setting is missing", "name", name)
		os.Exit(2)
	}
	return value
}

func loadPublicKey(path string) (ed25519.PublicKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(data)
	if block == nil {
		return nil, errors.New("job signing public key is not PEM")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	publicKey, ok := parsed.(ed25519.PublicKey)
	if !ok {
		return nil, errors.New("job signing key is not Ed25519")
	}
	return publicKey, nil
}

func run() error {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)
	publicKey, err := loadPublicKey(required("DEPLOYTIDE_JOB_PUBLIC_KEY_FILE"))
	if err != nil {
		return err
	}
	dockerEngine, err := engine.NewDocker(
		os.Getenv("DEPLOYTIDE_DOCKER_SOCKET"),
		os.Getenv("DEPLOYTIDE_DOCKER_API_VERSION"),
	)
	if err != nil {
		return err
	}
	clusterID := required("DEPLOYTIDE_CLUSTER_ID")
	runtimeTargetID := required("DEPLOYTIDE_RUNTIME_TARGET_ID")
	runtimeController, err := controller.New(
		clusterID,
		publicKey,
		required("DEPLOYTIDE_CONTROLLER_STATE_FILE"),
		dockerEngine,
	)
	if err != nil {
		return err
	}
	controlClient, err := client.New(
		required("DEPLOYTIDE_CONTROL_PLANE_URL"),
		clusterID,
		runtimeTargetID,
		client.TLSFiles{
			Certificate: required("DEPLOYTIDE_MTLS_CERT_FILE"),
			PrivateKey:  required("DEPLOYTIDE_MTLS_KEY_FILE"),
			CA:          required("DEPLOYTIDE_MTLS_CA_FILE"),
			ServerName:  os.Getenv("DEPLOYTIDE_MTLS_SERVER_NAME"),
		},
	)
	if err != nil {
		return err
	}
	interval := time.Second
	if raw := os.Getenv("DEPLOYTIDE_POLL_INTERVAL_MS"); raw != "" {
		milliseconds, parseErr := strconv.Atoi(raw)
		if parseErr != nil || milliseconds < 250 || milliseconds > 60_000 {
			return errors.New("DEPLOYTIDE_POLL_INTERVAL_MS is invalid")
		}
		interval = time.Duration(milliseconds) * time.Millisecond
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	logger.Info("runtime controller starting", "clusterId", clusterID, "runtimeTargetId", runtimeTargetID, "version", version)
	return client.NewPoller(controlClient, runtimeController, version, interval, logger).Run(ctx)
}

func main() {
	if err := run(); err != nil && !errors.Is(err, context.Canceled) {
		slog.Error("runtime controller stopped", "error", err)
		os.Exit(1)
	}
}

package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/mayowaoladosu/DeployTide/apps/runtime-controller/internal/dockerproxy"
)

func required(name string) string {
	value := os.Getenv(name)
	if value == "" {
		slog.Error("required Docker proxy setting is missing", "name", name)
		os.Exit(2)
	}
	return value
}

func run() error {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)
	proxy, err := dockerproxy.New(
		required("DEPLOYTIDE_RAW_DOCKER_SOCKET"),
		os.Getenv("DEPLOYTIDE_DOCKER_API_VERSION"),
	)
	if err != nil {
		return err
	}
	listenPath := required("DEPLOYTIDE_PROXY_LISTEN_SOCKET")
	listener, err := dockerproxy.ListenUnix(listenPath)
	if err != nil {
		return err
	}
	defer func() {
		_ = listener.Close()
		_ = os.Remove(listenPath)
	}()

	server := &http.Server{
		Handler:           proxy,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      40 * time.Second,
		IdleTimeout:       30 * time.Second,
		MaxHeaderBytes:    16 * 1024,
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	serveResult := make(chan error, 1)
	go func() {
		serveResult <- server.Serve(listener)
	}()
	logger.Info("constrained Docker proxy starting", "socket", listenPath)
	select {
	case <-ctx.Done():
		shutdownContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownContext); err != nil {
			return err
		}
		return nil
	case err := <-serveResult:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

func main() {
	if err := run(); err != nil {
		slog.Error("constrained Docker proxy stopped", "error", err)
		os.Exit(1)
	}
}

package client

import (
	"context"
	"log/slog"
	"time"

	"github.com/mayowaoladosu/DeployTide/apps/runtime-controller/internal/controller"
	"github.com/mayowaoladosu/DeployTide/apps/runtime-controller/internal/protocol"
)

type controlPlane interface {
	NextJob(context.Context, int64) (*protocol.Envelope, error)
	Acknowledge(context.Context, protocol.Envelope) error
	Complete(context.Context, controller.PendingCompletion) error
	Heartbeat(context.Context, string, string) error
}

type Poller struct {
	client     controlPlane
	controller *controller.Controller
	version    string
	interval   time.Duration
	heartbeat  time.Duration
	logger     *slog.Logger
}

func NewPoller(client controlPlane, runtimeController *controller.Controller, version string, interval time.Duration, logger *slog.Logger) *Poller {
	if interval < 250*time.Millisecond {
		interval = time.Second
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Poller{
		client: client, controller: runtimeController, version: version,
		interval: interval, heartbeat: 15 * time.Second, logger: logger,
	}
}

func (poller *Poller) PollOnce(ctx context.Context) error {
	pending, err := poller.controller.PendingCompletion()
	if err != nil {
		return err
	}
	if pending != nil {
		if err := poller.client.Complete(ctx, *pending); err != nil {
			return err
		}
		return poller.controller.ConfirmPending(pending.AttemptID, pending.Sequence)
	}
	sequence, err := poller.controller.LastSequence()
	if err != nil {
		return err
	}
	envelope, err := poller.client.NextJob(ctx, sequence)
	if err != nil || envelope == nil {
		return err
	}
	if err := poller.client.Acknowledge(ctx, *envelope); err != nil {
		return err
	}
	if _, err := poller.controller.Handle(ctx, *envelope); err != nil {
		return err
	}
	pending, err = poller.controller.PendingCompletion()
	if err != nil {
		return err
	}
	if pending == nil {
		return nil
	}
	if err := poller.client.Complete(ctx, *pending); err != nil {
		return err
	}
	return poller.controller.ConfirmPending(pending.AttemptID, pending.Sequence)
}

func (poller *Poller) HeartbeatOnce(ctx context.Context) error {
	health := poller.controller.EngineHealth(ctx)
	return poller.client.Heartbeat(ctx, poller.version, health)
}

func (poller *Poller) Run(ctx context.Context) error {
	pollTicker := time.NewTicker(poller.interval)
	heartbeatTicker := time.NewTicker(poller.heartbeat)
	defer pollTicker.Stop()
	defer heartbeatTicker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-heartbeatTicker.C:
			if err := poller.HeartbeatOnce(ctx); err != nil {
				poller.logger.Warn("controller heartbeat failed", "error", err)
			}
		case <-pollTicker.C:
			if err := poller.PollOnce(ctx); err != nil {
				poller.logger.Warn("controller poll failed", "error", err)
			}
		}
	}
}

package launch

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/vitorhugo-dotnet/go_discord_FrameRelay/internal/relaycontrol"
)

type Backend interface {
	ListPending(context.Context) ([]relaycontrol.PendingIntent, error)
	GetStatus(context.Context, string, int) (relaycontrol.IntentStatus, error)
	MarkPublished(context.Context, string, string) error
}

type Publisher interface {
	PublishReady(context.Context, relaycontrol.PendingIntent, relaycontrol.IntentStatus) (string, error)
}

type Watcher struct {
	backend   Backend
	publisher Publisher
	interval  time.Duration
	watchTTL  time.Duration
	now       func() time.Time
	logger    *slog.Logger
}

func NewWatcher(backend Backend, publisher Publisher, interval, watchTTL time.Duration, logger *slog.Logger) *Watcher {
	return &Watcher{backend: backend, publisher: publisher, interval: interval, watchTTL: watchTTL, now: time.Now, logger: logger}
}

func (w *Watcher) Run(ctx context.Context) error {
	if w.interval <= 0 {
		return fmt.Errorf("intent watcher interval must be positive")
	}
	if err := w.PollOnce(ctx); err != nil && ctx.Err() == nil {
		w.logRetry("intent_poll")
	}
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if err := w.PollOnce(ctx); err != nil && ctx.Err() == nil {
				w.logRetry("intent_poll")
			}
		}
	}
}

func (w *Watcher) logRetry(operation string) {
	if w.logger != nil {
		w.logger.Warn("launch recovery will retry", "operation", operation)
	}
}

func (w *Watcher) PollOnce(ctx context.Context) error {
	intents, err := w.backend.ListPending(ctx)
	if err != nil {
		return err
	}
	var firstError error
	for _, intent := range intents {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !intent.ExpiresAt.IsZero() && !intent.ExpiresAt.After(w.now()) && intent.Status != "session_ready" {
			continue
		}
		status, err := w.backend.GetStatus(ctx, intent.ID, int(w.watchTTL.Seconds()))
		if err != nil {
			if firstError == nil {
				firstError = err
			}
			continue
		}
		if status.Status != "session_ready" || status.WatchLaunchURL == "" {
			continue
		}
		messageID, err := w.publisher.PublishReady(ctx, intent, status)
		if err == nil {
			err = w.backend.MarkPublished(ctx, intent.ID, messageID)
		}
		if err != nil && firstError == nil {
			firstError = err
		}
	}
	return firstError
}

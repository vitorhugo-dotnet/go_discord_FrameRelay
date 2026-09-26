package launch

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/vitorhugo-dotnet/go_discord_FrameRelay/internal/relaycontrol"
)

func TestPollPublishesReadySessionAndAcknowledgesIt(t *testing.T) {
	backend := &fakeBackend{
		intents: []relaycontrol.PendingIntent{{ID: "intent-1", Status: "consumed", ChannelID: "channel-2"}},
		status:  relaycontrol.IntentStatus{ID: "intent-1", Status: "session_ready"},
	}
	publisher := &fakePublisher{}
	watcher := NewWatcher(backend, publisher, time.Second, 30*time.Minute, nil)

	if err := watcher.PollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if publisher.calls != 1 || backend.markedID != "intent-1" || backend.messageID != "message-1" {
		t.Fatalf("publish/ack mismatch: publisher=%d marked=%q message=%q", publisher.calls, backend.markedID, backend.messageID)
	}
	if backend.statusTTL != 0 {
		t.Fatal("readiness poll must not mint a watch capability")
	}
}

func TestPollCachesReadinessWithoutCapabilityWhileDiscordPublicationRetries(t *testing.T) {
	backend := &fakeBackend{
		intents: []relaycontrol.PendingIntent{{ID: "intent-1", Status: "session_ready", ChannelID: "channel-2"}},
		status: relaycontrol.IntentStatus{
			ID: "intent-1", Status: "session_ready",
			ExpiresAt: time.Now().Add(time.Hour),
		},
	}
	publisher := &fakePublisher{errors: []error{errors.New("discord unavailable"), nil}}
	watcher := NewWatcher(backend, publisher, time.Second, 30*time.Minute, nil)

	if err := watcher.PollOnce(context.Background()); err == nil {
		t.Fatal("expected first publish attempt to fail")
	}
	if err := watcher.PollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if backend.statusCalls != 1 {
		t.Fatalf("status calls = %d, want 1 while cached readiness remains valid", backend.statusCalls)
	}
	if len(publisher.urls) != 2 || publisher.urls[0] != "" || publisher.urls[1] != "" || backend.statusTTL != 0 {
		t.Fatalf("readiness retry unexpectedly needs a watch URL: %#v", publisher.urls)
	}
}

func TestPollRetriesPublicationWhenMarkPublishedFailsWithoutMintingCapability(t *testing.T) {
	backend := &fakeBackend{intents: []relaycontrol.PendingIntent{{ID: "intent-1", Status: "session_ready"}}, status: relaycontrol.IntentStatus{ID: "intent-1", Status: "session_ready", ExpiresAt: time.Now().Add(time.Hour)}, markErrors: []error{errors.New("ack unavailable"), nil}}
	publisher := &fakePublisher{}
	watcher := NewWatcher(backend, publisher, time.Second, time.Minute, nil)
	if err := watcher.PollOnce(context.Background()); err == nil {
		t.Fatal("expected first acknowledgement to fail")
	}
	if err := watcher.PollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if publisher.calls != 2 || backend.markCalls != 2 || backend.statusCalls != 1 || backend.statusTTL != 0 || backend.messageID != "message-1" {
		t.Fatal("retry/ack behavior changed")
	}
}

type fakeBackend struct {
	intents     []relaycontrol.PendingIntent
	status      relaycontrol.IntentStatus
	markedID    string
	messageID   string
	statusCalls int
	statusTTL   int
	markCalls   int
	markErrors  []error
}

func (f *fakeBackend) ListPending(context.Context) ([]relaycontrol.PendingIntent, error) {
	return f.intents, nil
}
func (f *fakeBackend) GetStatus(_ context.Context, _ string, ttl int) (relaycontrol.IntentStatus, error) {
	f.statusCalls++
	f.statusTTL = ttl
	return f.status, nil
}
func (f *fakeBackend) MarkPublished(_ context.Context, id, messageID string) error {
	f.markedID, f.messageID = id, messageID
	f.markCalls++
	if len(f.markErrors) > 0 {
		err := f.markErrors[0]
		f.markErrors = f.markErrors[1:]
		return err
	}
	return nil
}

type fakePublisher struct {
	calls  int
	errors []error
	urls   []string
}

func (f *fakePublisher) PublishReady(ctx context.Context, _ relaycontrol.PendingIntent, status relaycontrol.IntentStatus) (string, error) {
	return f.publish(ctx, status)
}

func (f *fakePublisher) publish(_ context.Context, status relaycontrol.IntentStatus) (string, error) {
	f.calls++
	f.urls = append(f.urls, status.WatchLaunchURL)
	if len(f.errors) > 0 {
		err := f.errors[0]
		f.errors = f.errors[1:]
		if err != nil {
			return "", err
		}
	}
	return "message-1", nil
}

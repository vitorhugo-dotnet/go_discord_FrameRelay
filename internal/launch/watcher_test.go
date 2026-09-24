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
		status:  relaycontrol.IntentStatus{ID: "intent-1", Status: "session_ready", WatchLaunchURL: "https://framerelay.example/open/watch/token"},
	}
	publisher := &fakePublisher{}
	watcher := NewWatcher(backend, publisher, time.Second, 30*time.Minute, nil)

	if err := watcher.PollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if publisher.calls != 1 || backend.markedID != "intent-1" || backend.messageID != "message-1" {
		t.Fatalf("publish/ack mismatch: publisher=%d marked=%q message=%q", publisher.calls, backend.markedID, backend.messageID)
	}
}

func TestPollReusesWatchCapabilityWhileDiscordPublicationRetries(t *testing.T) {
	backend := &fakeBackend{
		intents: []relaycontrol.PendingIntent{{ID: "intent-1", Status: "session_ready", ChannelID: "channel-2"}},
		status: relaycontrol.IntentStatus{
			ID: "intent-1", Status: "session_ready", WatchLaunchURL: "https://framerelay.example/open/watch/token",
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
		t.Fatalf("status calls = %d, want 1 while cached capability remains valid", backend.statusCalls)
	}
	if len(publisher.urls) != 2 || publisher.urls[0] != publisher.urls[1] {
		t.Fatalf("watch URL changed across retry: %#v", publisher.urls)
	}
}

type fakeBackend struct {
	intents     []relaycontrol.PendingIntent
	status      relaycontrol.IntentStatus
	markedID    string
	messageID   string
	statusCalls int
}

func (f *fakeBackend) ListPending(context.Context) ([]relaycontrol.PendingIntent, error) {
	return f.intents, nil
}
func (f *fakeBackend) GetStatus(context.Context, string, int) (relaycontrol.IntentStatus, error) {
	f.statusCalls++
	return f.status, nil
}
func (f *fakeBackend) MarkPublished(_ context.Context, id, messageID string) error {
	f.markedID, f.messageID = id, messageID
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

package launch

import (
	"context"
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

type fakeBackend struct {
	intents   []relaycontrol.PendingIntent
	status    relaycontrol.IntentStatus
	markedID  string
	messageID string
}

func (f *fakeBackend) ListPending(context.Context) ([]relaycontrol.PendingIntent, error) {
	return f.intents, nil
}
func (f *fakeBackend) GetStatus(context.Context, string, int) (relaycontrol.IntentStatus, error) {
	return f.status, nil
}
func (f *fakeBackend) MarkPublished(_ context.Context, id, messageID string) error {
	f.markedID, f.messageID = id, messageID
	return nil
}

type fakePublisher struct{ calls int }

func (f *fakePublisher) PublishReady(context.Context, relaycontrol.PendingIntent, relaycontrol.IntentStatus) (string, error) {
	f.calls++
	return "message-1", nil
}

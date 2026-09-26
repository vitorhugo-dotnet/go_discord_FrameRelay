package discordbot

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/disgoorg/disgo/discord"
	"github.com/disgoorg/disgo/rest"
	"github.com/vitorhugo-dotnet/go_discord_FrameRelay/internal/relaycontrol"
)

func TestShareCommandCreatesEphemeralLaunchButton(t *testing.T) {
	backend := &fakeBackend{share: relaycontrol.ShareIntent{
		ID: "intent-1", LaunchURL: "https://framerelay.example/open/share/opaque", ExpiresAt: time.Date(2026, 9, 24, 12, 10, 0, 0, time.UTC),
	}}
	handler := NewCommandHandler(backend, 10*time.Minute, 30*time.Minute)

	response := handler.Handle(context.Background(), Interaction{
		Subcommand: "share", GuildID: "guild-1", ChannelID: "channel-2", UserID: "user-3",
	})

	if !response.Ephemeral || response.Button == nil || response.Button.Label != "Open FrameRelay and share" {
		t.Fatalf("unexpected response: %#v", response)
	}
	if backend.shareRequest.Provider != "discord" || backend.shareRequest.GuildID != "guild-1" ||
		backend.shareRequest.ChannelID != "channel-2" || backend.shareRequest.RequestedByUserID != "user-3" ||
		backend.shareRequest.TTLSeconds != 600 {
		t.Fatalf("unexpected RelayControl request: %#v", backend.shareRequest)
	}
}

type activityBackend struct {
	fakeBackend
	request  relaycontrol.CreateActivityRequest
	activity relaycontrol.ActivityIntent
	err      error
	wait     bool
}

func (f *activityBackend) CreateActivity(ctx context.Context, request relaycontrol.CreateActivityRequest) (relaycontrol.ActivityIntent, error) {
	f.request = request
	if f.wait {
		<-ctx.Done()
		return relaycontrol.ActivityIntent{}, ctx.Err()
	}
	return f.activity, f.err
}

func TestActivityIntentPrecedesLaunchWithoutDefer(t *testing.T) {
	backend := &activityBackend{activity: relaycontrol.ActivityIntent{ID: "intent", ExpiresAt: time.Now().Add(time.Minute)}}
	handler := NewCommandHandler(backend, time.Minute, 5*time.Minute)
	calls := 0
	launched, err := handler.InitialResponse(context.Background(), Interaction{Subcommand: "watch", Code: "ABC123", GuildID: "guild", ChannelID: "channel", UserID: "user"}, func(_ context.Context, launch bool) error {
		calls++
		if backend.request.Code != "ABC123" || backend.request.RequestedByUserID != "user" || backend.request.GuildID != "guild" || backend.request.ChannelID != "channel" || backend.request.TTLSeconds != 300 || !launch {
			t.Fatal("launch must follow the bound intent, without deferring")
		}
		return nil
	})
	if err != nil || !launched || calls != 1 {
		t.Fatalf("launched=%v calls=%d err=%v", launched, calls, err)
	}
}

func TestUnavailableOrMissingIntentDefersForDesktopFallback(t *testing.T) {
	for _, backend := range []*activityBackend{
		{err: errors.New("unavailable")},
		{activity: relaycontrol.ActivityIntent{ExpiresAt: time.Now().Add(time.Minute)}},
		{activity: relaycontrol.ActivityIntent{ID: "expired", ExpiresAt: time.Now().Add(-time.Minute)}},
	} {
		handler := NewCommandHandler(backend, time.Minute, time.Minute)
		launched, err := handler.InitialResponse(context.Background(), Interaction{Subcommand: "watch", GuildID: "g", ChannelID: "c"}, func(_ context.Context, launch bool) error {
			if launch {
				t.Fatal("must not launch without a valid intent")
			}
			return nil
		})
		if launched || err != nil {
			t.Fatalf("unexpected launch %v %v", launched, err)
		}
	}
}

func TestSlowIntentLeavesTimeForInitialDesktopDefer(t *testing.T) {
	backend := &activityBackend{wait: true}
	handler := NewCommandHandler(backend, time.Minute, time.Minute)
	ctx, cancel := context.WithTimeout(context.Background(), 2800*time.Millisecond)
	defer cancel()
	begin := time.Now()
	launched, err := handler.InitialResponse(ctx, Interaction{Subcommand: "watch", GuildID: "g", ChannelID: "c"}, func(ctx context.Context, launch bool) error {
		if launch || ctx.Err() != nil {
			t.Fatal("must defer while initial response deadline remains")
		}
		return nil
	})
	if launched || err != nil || time.Since(begin) > 2400*time.Millisecond {
		t.Fatalf("deadline fallback failed: %v %v", launched, err)
	}
}

func TestDefiniteActivityRejectionFallsBackButAmbiguousFailureDoesNot(t *testing.T) {
	for _, test := range []struct {
		err      error
		calls    int
		launched bool
	}{
		{&rest.Error{Response: &http.Response{StatusCode: 400}, Code: 50035}, 2, false},
		{&rest.Error{Response: &http.Response{StatusCode: 400}, Code: 40060}, 1, true},
		{errors.New("transport timeout"), 1, true},
	} {
		backend := &activityBackend{activity: relaycontrol.ActivityIntent{ID: "intent", ExpiresAt: time.Now().Add(time.Minute)}}
		handler := NewCommandHandler(backend, time.Minute, time.Minute)
		calls := 0
		launched, _ := handler.InitialResponse(context.Background(), Interaction{Subcommand: "watch", GuildID: "g", ChannelID: "c"}, func(_ context.Context, launch bool) error {
			calls++
			if launch {
				return test.err
			}
			return nil
		})
		if calls != test.calls || launched != test.launched {
			t.Fatalf("calls=%d launched=%v", calls, launched)
		}
	}
}

func TestDelayedGatewayReservesCallbackTimeAfterSlowIntent(t *testing.T) {
	backend := &activityBackend{wait: true}
	handler := NewCommandHandler(backend, time.Minute, time.Minute)
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	called := false
	launched, err := handler.InitialResponse(ctx, Interaction{Subcommand: "watch", GuildID: "g", ChannelID: "c"}, func(ctx context.Context, launch bool) error {
		called = true
		deadline, _ := ctx.Deadline()
		if launch || ctx.Err() != nil || time.Until(deadline) < 400*time.Millisecond {
			t.Fatal("delayed gateway must leave live callback reserve")
		}
		return nil
	})
	if launched || err != nil || !called {
		t.Fatalf("launched=%v called=%v err=%v", launched, called, err)
	}
}

func TestShortRemainingDeadlineSkipsActivityAndDefersImmediately(t *testing.T) {
	backend := &activityBackend{wait: true}
	handler := NewCommandHandler(backend, time.Minute, time.Minute)
	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()
	_, err := handler.InitialResponse(ctx, Interaction{Subcommand: "watch", GuildID: "g", ChannelID: "c"}, func(ctx context.Context, launch bool) error {
		if launch || ctx.Err() != nil || backend.request.GuildID != "" {
			t.Fatal("must immediately defer without API attempt")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestWatchCommandNormalizesThroughClientAndReturnsSafeErrors(t *testing.T) {
	backend := &fakeBackend{watch: relaycontrol.WatchLaunch{
		LaunchURL: "https://framerelay.example/open/watch/opaque", ExpiresAt: time.Now().Add(30 * time.Minute),
	}}
	handler := NewCommandHandler(backend, 10*time.Minute, 30*time.Minute)
	response := handler.Handle(context.Background(), Interaction{
		Subcommand: "watch", GuildID: "guild-1", ChannelID: "channel-2", Code: " ab12cd ",
	})
	if !response.Ephemeral || response.Button == nil || response.Button.Label != "Watch in FrameRelay" {
		t.Fatalf("unexpected response: %#v", response)
	}
	if backend.watchCode != " ab12cd " || backend.watchTTLSeconds != 1800 {
		t.Fatalf("unexpected watch input: %q ttl=%d", backend.watchCode, backend.watchTTLSeconds)
	}

	backend.watchErr = &relaycontrol.RequestError{StatusCode: 400, Code: "session_full"}
	response = handler.Handle(context.Background(), Interaction{Subcommand: "watch", GuildID: "g", ChannelID: "c", Code: "AB12CD"})
	if !response.Ephemeral || response.Button != nil || response.Content != "That FrameRelay share is full." {
		t.Fatalf("unexpected safe error response: %#v", response)
	}
}

func TestCommandRegistrationUpsertsOneTopLevelCommandWithTwoSubcommands(t *testing.T) {
	commands := CommandDefinitions()
	if len(commands) != 1 {
		t.Fatalf("registered %d top-level commands", len(commands))
	}
	command, ok := commands[0].(discord.SlashCommandCreate)
	if !ok || command.Name != "framerelay" || len(command.Options) != 2 {
		t.Fatalf("unexpected command definition: %#v", commands[0])
	}
}

type fakeBackend struct {
	share           relaycontrol.ShareIntent
	shareRequest    relaycontrol.CreateShareRequest
	watch           relaycontrol.WatchLaunch
	watchCode       string
	watchTTLSeconds int
	watchErr        error
}

func (f *fakeBackend) CreateShare(_ context.Context, request relaycontrol.CreateShareRequest) (relaycontrol.ShareIntent, error) {
	f.shareRequest = request
	return f.share, nil
}

func (f *fakeBackend) CreateWatch(_ context.Context, code string, ttl int) (relaycontrol.WatchLaunch, error) {
	f.watchCode, f.watchTTLSeconds = code, ttl
	return f.watch, f.watchErr
}

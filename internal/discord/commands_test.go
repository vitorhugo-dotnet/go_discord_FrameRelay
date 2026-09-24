package discordbot

import (
	"context"
	"testing"
	"time"

	"github.com/disgoorg/disgo/discord"
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

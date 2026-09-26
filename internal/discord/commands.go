package discordbot

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/disgoorg/disgo/discord"
	"github.com/disgoorg/disgo/rest"
	"github.com/vitorhugo-dotnet/go_discord_FrameRelay/internal/relaycontrol"
)

type Backend interface {
	CreateShare(context.Context, relaycontrol.CreateShareRequest) (relaycontrol.ShareIntent, error)
	CreateWatch(context.Context, string, int) (relaycontrol.WatchLaunch, error)
}

type Interaction struct {
	Subcommand string
	GuildID    string
	ChannelID  string
	UserID     string
	Code       string
}

type LinkButton struct {
	Label string
	URL   string
}

type Response struct {
	Content   string
	Ephemeral bool
	Button    *LinkButton
}

type CommandHandler struct {
	backend  Backend
	shareTTL time.Duration
	watchTTL time.Duration
}

func NewCommandHandler(backend Backend, shareTTL, watchTTL time.Duration) *CommandHandler {
	return &CommandHandler{backend: backend, shareTTL: shareTTL, watchTTL: watchTTL}
}

// ActivityBackend is optional so older integrations retain desktop links.
type ActivityBackend interface {
	CreateActivity(context.Context, relaycontrol.CreateActivityRequest) (relaycontrol.ActivityIntent, error)
}

// InitialResponse creates the intent before callback 12. When setup is unavailable,
// it defers instead; the caller then runs Handle for the existing desktop link.
func (h *CommandHandler) InitialResponse(ctx context.Context, interaction Interaction, respond func(context.Context, bool) error) (bool, error) {
	if interaction.Subcommand == "watch" && interaction.GuildID != "" && interaction.ChannelID != "" {
		if backend, ok := h.backend.(ActivityBackend); ok {
			budget := 1500 * time.Millisecond
			const callbackReserve = 500 * time.Millisecond
			if deadline, ok := ctx.Deadline(); ok {
				remaining := time.Until(deadline) - callbackReserve
				if remaining < budget {
					budget = remaining
				}
			}
			if budget <= 0 {
				return false, respond(ctx, false)
			}
			attempt, cancel := context.WithTimeout(ctx, budget)
			intent, err := backend.CreateActivity(attempt, relaycontrol.CreateActivityRequest{
				Code: interaction.Code, GuildID: interaction.GuildID, ChannelID: interaction.ChannelID,
				RequestedByUserID: interaction.UserID, TTLSeconds: int(h.watchTTL.Seconds()),
			})
			cancel()
			if err == nil && intent.ID != "" && intent.ExpiresAt.After(time.Now()) && ctx.Err() == nil {
				// An unsuccessful callback may have reached Discord. Do not double acknowledge.
				err := respond(ctx, true)
				var rejected *rest.Error
				// A definite invalid callback (e.g. Activities not enabled) was not acknowledged.
				// Transport failures and Discord's already-acknowledged code are ambiguous.
				if errors.As(err, &rejected) && rejected.Response != nil && rejected.Response.StatusCode == http.StatusBadRequest && rejected.Code != 40060 && ctx.Err() == nil {
					return false, respond(ctx, false)
				}
				return true, err
			}
		}
	}
	return false, respond(ctx, false)
}

func (h *CommandHandler) Handle(ctx context.Context, interaction Interaction) Response {
	if interaction.GuildID == "" || interaction.ChannelID == "" {
		return Response{Content: "Use this command in a Discord server channel.", Ephemeral: true}
	}
	switch interaction.Subcommand {
	case "share":
		intent, err := h.backend.CreateShare(ctx, relaycontrol.CreateShareRequest{
			Provider: "discord", GuildID: interaction.GuildID, ChannelID: interaction.ChannelID,
			RequestedByUserID: interaction.UserID, TTLSeconds: int(h.shareTTL.Seconds()),
		})
		if err != nil {
			return Response{Content: userError(err), Ephemeral: true}
		}
		return Response{
			Content: fmt.Sprintf("Ready to start FrameRelay.\nThis launch link expires at %s.",
				intent.ExpiresAt.UTC().Format(time.RFC3339)),
			Ephemeral: true,
			Button:    &LinkButton{Label: "Open FrameRelay and share", URL: intent.LaunchURL},
		}
	case "watch":
		watch, err := h.backend.CreateWatch(ctx, interaction.Code, int(h.watchTTL.Seconds()))
		if err != nil {
			return Response{Content: userError(err), Ephemeral: true}
		}
		return Response{
			Content:   fmt.Sprintf("Open this FrameRelay share before %s.", watch.ExpiresAt.UTC().Format(time.RFC3339)),
			Ephemeral: true,
			Button:    &LinkButton{Label: "Watch in FrameRelay", URL: watch.LaunchURL},
		}
	default:
		return Response{Content: "Unknown FrameRelay command.", Ephemeral: true}
	}
}

func userError(err error) string {
	var requestError *relaycontrol.RequestError
	if errors.As(err, &requestError) {
		switch requestError.Code {
		case "invalid_code":
			return "That code is not valid, or the share has ended."
		case "session_full":
			return "That FrameRelay share is full."
		case "session_unavailable":
			return "That FrameRelay share has ended or is unavailable."
		case "invalid_ttl":
			return "The FrameRelay launch link could not be created. Try again."
		}
	}
	return "FrameRelay is temporarily unavailable. Try again shortly."
}

func CommandDefinitions() []discord.ApplicationCommandCreate {
	return []discord.ApplicationCommandCreate{
		discord.SlashCommandCreate{
			Name:        "framerelay",
			Description: "Start or watch a FrameRelay screen share",
			Options: []discord.ApplicationCommandOption{
				discord.ApplicationCommandOptionSubCommand{Name: "share", Description: "Start a screen share from FrameRelay"},
				discord.ApplicationCommandOptionSubCommand{
					Name: "watch", Description: "Watch a FrameRelay share inside Discord",
					Options: []discord.ApplicationCommandOption{
						discord.ApplicationCommandOptionString{Name: "code", Description: "The six-character FrameRelay share code", Required: true, MinLength: intPointer(6), MaxLength: intPointer(12)},
					},
				},
			},
		},
	}
}

func intPointer(value int) *int { return &value }

package discordbot

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/disgoorg/disgo/discord"
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
					Name: "watch", Description: "Create a one-click link for an active FrameRelay share",
					Options: []discord.ApplicationCommandOption{
						discord.ApplicationCommandOptionString{Name: "code", Description: "The six-character FrameRelay share code", Required: true, MinLength: intPointer(6), MaxLength: intPointer(12)},
					},
				},
			},
		},
	}
}

func intPointer(value int) *int { return &value }

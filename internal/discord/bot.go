package discordbot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/disgoorg/disgo/bot"
	"github.com/disgoorg/disgo/discord"
	"github.com/disgoorg/disgo/events"
	"github.com/disgoorg/disgo/rest"
	"github.com/disgoorg/snowflake/v2"
	"github.com/vitorhugo-dotnet/go_discord_FrameRelay/internal/relaycontrol"
)

type Adapter struct {
	client  *bot.Client
	handler *CommandHandler
	logger  *slog.Logger
}

func NewAdapter(client *bot.Client, handler *CommandHandler, logger *slog.Logger) *Adapter {
	return &Adapter{client: client, handler: handler, logger: logger}
}

func (a *Adapter) OnCommand(event *events.ApplicationCommandInteractionCreate) {
	data := event.SlashCommandInteractionData()
	if data.CommandName() != "framerelay" {
		return
	}
	if err := event.DeferCreateMessage(true); err != nil {
		a.logger.Warn("discord interaction defer failed", "operation", "defer_interaction")
		return
	}
	interaction := Interaction{UserID: event.User().ID.String()}
	if data.SubCommandName != nil {
		interaction.Subcommand = *data.SubCommandName
	}
	if guildID := event.GuildID(); guildID != nil {
		interaction.GuildID = guildID.String()
	}
	interaction.ChannelID = event.Channel().ID().String()
	if interaction.Subcommand == "watch" {
		interaction.Code = data.String("code")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	response := a.handler.Handle(ctx, interaction)
	message := discord.NewMessageUpdate().WithContent(response.Content)
	if response.Button != nil {
		message = message.AddActionRow(discord.NewLinkButton(response.Button.Label, response.Button.URL))
	}
	if _, err := a.client.Rest.UpdateInteractionResponse(event.ApplicationID(), event.Token(), message, rest.WithCtx(ctx)); err != nil {
		a.logger.Warn("discord interaction response failed", "operation", "update_interaction")
	}
}

func (a *Adapter) PublishReady(ctx context.Context, intent relaycontrol.PendingIntent, status relaycontrol.IntentStatus) (string, error) {
	channelNumber, err := strconv.ParseUint(intent.ChannelID, 10, 64)
	if err != nil {
		return "", fmt.Errorf("pending intent channel id is invalid")
	}
	digest := sha256.Sum256([]byte(intent.ID))
	nonce := hex.EncodeToString(digest[:12])
	message := discord.NewMessageCreate().
		WithContent("FrameRelay is ready to watch.").
		WithNonce(nonce).
		WithEnforceNonce(true).
		AddActionRow(discord.NewLinkButton("Watch in FrameRelay", status.WatchLaunchURL))
	posted, err := a.client.Rest.CreateMessage(snowflake.ID(channelNumber), message, rest.WithCtx(ctx))
	if err != nil {
		return "", fmt.Errorf("publish ready message")
	}
	return posted.ID.String(), nil
}

func RegisterCommands(ctx context.Context, client *bot.Client, applicationID, guildID string) error {
	appNumber, err := strconv.ParseUint(applicationID, 10, 64)
	if err != nil {
		return fmt.Errorf("application id must be numeric")
	}
	commands := CommandDefinitions()
	if guildID != "" {
		guildNumber, err := strconv.ParseUint(guildID, 10, 64)
		if err != nil {
			return fmt.Errorf("guild id must be numeric")
		}
		_, err = client.Rest.SetGuildCommands(snowflake.ID(appNumber), snowflake.ID(guildNumber), commands, rest.WithCtx(ctx))
		return err
	}
	_, err = client.Rest.SetGlobalCommands(snowflake.ID(appNumber), commands, rest.WithCtx(ctx))
	return err
}

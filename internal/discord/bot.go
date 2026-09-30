package discordbot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"regexp"
	"strconv"
	"strings"
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
	// Include gateway transit time in the initial callback deadline.
	initialCtx, initialCancel := context.WithDeadline(context.Background(), event.ID().Time().Add(2800*time.Millisecond))
	launched, initialErr := a.handler.InitialResponse(initialCtx, interaction, func(ctx context.Context, launch bool) error {
		if launch {
			return event.LaunchActivity(rest.WithCtx(ctx))
		}
		return event.DeferCreateMessage(true, rest.WithCtx(ctx))
	})
	initialCancel()
	if initialErr != nil {
		a.logger.Warn("discord initial response failed", "operation", "initial_interaction")
		return
	}
	if launched {
		return
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

var readyIntentPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func readyIntentFromCustomID(customID string) string {
	id, ok := strings.CutPrefix(customID, "framerelay:watch:")
	if !ok || !readyIntentPattern.MatchString(id) {
		return ""
	}
	return id
}

func (a *Adapter) OnComponent(event *events.ComponentInteractionCreate) {
	if event.Data.Type() != discord.ComponentTypeButton {
		return
	}
	readyID := readyIntentFromCustomID(event.ButtonInteractionData().CustomID())
	if readyID == "" {
		return
	}
	interaction := Interaction{ReadyIntentID: readyID, UserID: event.User().ID.String()}
	if guildID := event.GuildID(); guildID != nil {
		interaction.GuildID = guildID.String()
	}
	interaction.ChannelID = event.Channel().ID().String()
	initialCtx, cancel := context.WithDeadline(context.Background(), event.ID().Time().Add(2800*time.Millisecond))
	launched, err := a.handler.InitialResponse(initialCtx, interaction, func(ctx context.Context, launch bool) error {
		if launch {
			return event.LaunchActivity(rest.WithCtx(ctx))
		}
		return event.DeferCreateMessage(true, rest.WithCtx(ctx))
	})
	cancel()
	if err != nil {
		a.logger.Warn("discord ready button response failed", "operation", "ready_button")
		return
	}
	if launched {
		return
	}
	ctx, done := context.WithTimeout(context.Background(), 5*time.Second)
	defer done()
	fallback := a.handler.HandleReadyFallback(ctx, interaction)
	message := discord.NewMessageUpdate().WithContent(fallback.Content)
	if fallback.Button != nil {
		message = message.AddActionRow(discord.NewLinkButton(fallback.Button.Label, fallback.Button.URL))
	}
	if _, err := a.client.Rest.UpdateInteractionResponse(event.ApplicationID(), event.Token(), message, rest.WithCtx(ctx)); err != nil {
		a.logger.Warn("discord ready button fallback failed", "operation", "ready_button_fallback")
	}
}

func (a *Adapter) PublishReady(ctx context.Context, intent relaycontrol.PendingIntent, _ relaycontrol.IntentStatus) (string, error) {
	channelNumber, err := strconv.ParseUint(intent.ChannelID, 10, 64)
	if err != nil {
		return "", fmt.Errorf("pending intent channel id is invalid")
	}
	message := readyMessage(intent.ID)
	posted, err := a.client.Rest.CreateMessage(snowflake.ID(channelNumber), message, rest.WithCtx(ctx))
	if err != nil {
		return "", fmt.Errorf("publish ready message")
	}
	return posted.ID.String(), nil
}

func readyMessage(intentID string) discord.MessageCreate {
	digest := sha256.Sum256([]byte(intentID))
	nonce := hex.EncodeToString(digest[:12])
	return discord.NewMessageCreate().
		WithContent("FrameRelay is ready to watch. Select **Assistir no Discord** to open the Activity with your own authorization. You can also run `/framerelay watch code:<host-code>` in this voice channel with the host's share code. If Activity launch is unavailable, you will receive a personal desktop watch link.").
		WithNonce(nonce).
		WithEnforceNonce(true).
		AddActionRow(discord.NewPrimaryButton("Assistir no Discord", "framerelay:watch:"+intentID))
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
	// Upsert only our slash commands. A bulk overwrite would remove Discord's
	// Activity Entry Point command, which Discord rejects with error 50240.
	for _, command := range commands {
		if _, err = client.Rest.CreateGlobalCommand(snowflake.ID(appNumber), command, rest.WithCtx(ctx)); err != nil {
			return err
		}
	}
	return nil
}

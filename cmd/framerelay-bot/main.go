package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/disgoorg/disgo"
	"github.com/disgoorg/disgo/bot"
	"github.com/disgoorg/disgo/gateway"
	"github.com/vitorhugo-dotnet/go_discord_FrameRelay/internal/config"
	discordbot "github.com/vitorhugo-dotnet/go_discord_FrameRelay/internal/discord"
	"github.com/vitorhugo-dotnet/go_discord_FrameRelay/internal/health"
	"github.com/vitorhugo-dotnet/go_discord_FrameRelay/internal/launch"
	"github.com/vitorhugo-dotnet/go_discord_FrameRelay/internal/observability"
	"github.com/vitorhugo-dotnet/go_discord_FrameRelay/internal/relaycontrol"
)

func main() {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		_, _ = os.Stderr.WriteString("invalid configuration: " + err.Error() + "\n")
		os.Exit(2)
	}
	logger := observability.NewLogger(os.Stdout, cfg.LogLevel)
	if err := run(cfg, logger); err != nil && !errors.Is(err, context.Canceled) {
		logger.Error("FrameRelay bot stopped", "operation", "run")
		os.Exit(1)
	}
}

func run(cfg config.Config, logger *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	backend := relaycontrol.NewClient(cfg.RelayControlBaseURL, cfg.RelayControlToken, nil)
	readiness := &health.Readiness{}
	client, err := disgo.New(cfg.DiscordToken,
		bot.WithDefaultGateway(),
		bot.WithGatewayConfigOpts(gateway.WithIntents(gateway.IntentsNone)),
		bot.WithLogger(logger),
	)
	if err != nil {
		return errors.New("initialize Discord client")
	}
	defer client.Close(context.Background())
	handler := discordbot.NewCommandHandler(backend, cfg.ShareIntentTTL, cfg.WatchIntentTTL)
	adapter := discordbot.NewAdapter(client, handler, logger)
	client.AddEventListeners(bot.NewListenerFunc(adapter.OnCommand))

	registerCtx, cancelRegister := context.WithTimeout(ctx, 15*time.Second)
	err = discordbot.RegisterCommands(registerCtx, client, cfg.ApplicationID, cfg.GuildID)
	cancelRegister()
	if err != nil {
		return errors.New("register Discord slash command")
	}
	if err := client.OpenGateway(ctx); err != nil {
		return errors.New("open Discord Gateway")
	}

	server := &http.Server{Addr: cfg.HTTPAddress, Handler: health.Handler(readiness), ReadHeaderTimeout: 5 * time.Second}
	serverErrors := make(chan error, 1)
	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErrors <- err
		}
	}()

	watcher := launch.NewWatcher(backend, adapter, cfg.IntentPollInterval, cfg.WatchIntentTTL, logger)
	watcherErrors := make(chan error, 1)
	go func() { watcherErrors <- watcher.Run(ctx) }()
	go monitorReadiness(ctx, client, backend, readiness, cfg.IntentPollInterval)

	logger.Info("FrameRelay bot started", "operation", "startup")
	select {
	case <-ctx.Done():
	case err := <-serverErrors:
		logger.Error("health server failed", "operation", "health_server")
		return err
	case err := <-watcherErrors:
		if !errors.Is(err, context.Canceled) {
			logger.Error("launch recovery watcher failed", "operation", "intent_watcher")
			return err
		}
	}

	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelShutdown()
	if err := server.Shutdown(shutdownCtx); err != nil {
		return errors.New("shutdown health server")
	}
	return nil
}

func monitorReadiness(ctx context.Context, client *bot.Client, backend *relaycontrol.Client, readiness *health.Readiness, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	probe := func() {
		readiness.SetDiscord(client.Gateway != nil && client.Gateway.Status().IsConnected())
		probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		_, err := backend.ListPending(probeCtx)
		readiness.SetRelayControl(err == nil)
	}
	probe()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			probe()
		}
	}
}

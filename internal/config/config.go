package config

import (
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	DiscordToken        string
	ApplicationID       string
	GuildID             string
	RelayControlBaseURL string
	RelayControlToken   string
	HTTPAddress         string
	LogLevel            slog.Level
	ShareIntentTTL      time.Duration
	WatchIntentTTL      time.Duration
	IntentPollInterval  time.Duration
}

func Load(getenv func(string) string) (Config, error) {
	if getenv == nil {
		return Config{}, fmt.Errorf("configuration source is required")
	}
	cfg := Config{
		DiscordToken:        strings.TrimSpace(getenv("DISCORD_TOKEN")),
		ApplicationID:       strings.TrimSpace(getenv("DISCORD_APPLICATION_ID")),
		GuildID:             strings.TrimSpace(getenv("DISCORD_GUILD_ID")),
		RelayControlBaseURL: strings.TrimRight(strings.TrimSpace(getenv("RELAYCONTROL_BASE_URL")), "/"),
		RelayControlToken:   strings.TrimSpace(getenv("RELAYCONTROL_SERVICE_TOKEN")),
		HTTPAddress:         valueOr(getenv("HTTP_ADDR"), ":8080"),
		LogLevel:            slog.LevelInfo,
		ShareIntentTTL:      10 * time.Minute,
		WatchIntentTTL:      30 * time.Minute,
		IntentPollInterval:  2 * time.Second,
	}

	var missing []string
	if cfg.DiscordToken == "" {
		missing = append(missing, "DISCORD_TOKEN")
	}
	if cfg.ApplicationID == "" {
		missing = append(missing, "DISCORD_APPLICATION_ID")
	} else if _, err := strconv.ParseUint(cfg.ApplicationID, 10, 64); err != nil {
		return Config{}, fmt.Errorf("DISCORD_APPLICATION_ID must be a numeric Discord application id")
	}
	if cfg.RelayControlBaseURL == "" {
		missing = append(missing, "RELAYCONTROL_BASE_URL")
	}
	if cfg.RelayControlToken == "" {
		missing = append(missing, "RELAYCONTROL_SERVICE_TOKEN")
	}
	if len(missing) > 0 {
		return Config{}, fmt.Errorf("missing required configuration: %s", strings.Join(missing, ", "))
	}
	if err := validateBaseURL("RELAYCONTROL_BASE_URL", cfg.RelayControlBaseURL, true); err != nil {
		return Config{}, err
	}
	if value := strings.TrimSpace(getenv("SHARE_INTENT_TTL")); value != "" {
		duration, err := time.ParseDuration(value)
		if err != nil || duration < 30*time.Second || duration > time.Hour {
			return Config{}, fmt.Errorf("SHARE_INTENT_TTL must be between 30s and 1h")
		}
		cfg.ShareIntentTTL = duration
	}
	if value := strings.TrimSpace(getenv("WATCH_INTENT_TTL")); value != "" {
		duration, err := time.ParseDuration(value)
		if err != nil || duration < time.Minute || duration > 24*time.Hour {
			return Config{}, fmt.Errorf("WATCH_INTENT_TTL must be between 1m and 24h")
		}
		cfg.WatchIntentTTL = duration
	}
	if value := strings.TrimSpace(getenv("INTENT_POLL_INTERVAL")); value != "" {
		duration, err := time.ParseDuration(value)
		if err != nil || duration < 250*time.Millisecond || duration > time.Minute {
			return Config{}, fmt.Errorf("INTENT_POLL_INTERVAL must be between 250ms and 1m")
		}
		cfg.IntentPollInterval = duration
	}
	if value := strings.TrimSpace(getenv("LOG_LEVEL")); value != "" {
		level, err := parseLevel(value)
		if err != nil {
			return Config{}, err
		}
		cfg.LogLevel = level
	}
	return cfg, nil
}

func validateBaseURL(name, raw string, allowLoopbackHTTP bool) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return fmt.Errorf("%s must be an absolute base URL", name)
	}
	if parsed.Scheme == "https" {
		return nil
	}
	if allowLoopbackHTTP && parsed.Scheme == "http" {
		host := parsed.Hostname()
		if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() || strings.EqualFold(host, "localhost") {
			return nil
		}
	}
	return fmt.Errorf("%s must use HTTPS (HTTP is allowed only for a loopback RelayControl URL)", name)
}

func parseLevel(raw string) (slog.Level, error) {
	switch strings.ToLower(raw) {
	case "debug":
		return slog.LevelDebug, nil
	case "info":
		return slog.LevelInfo, nil
	case "warn", "warning":
		return slog.LevelWarn, nil
	case "error":
		return slog.LevelError, nil
	default:
		return 0, fmt.Errorf("LOG_LEVEL must be debug, info, warn, or error")
	}
}

func valueOr(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return strings.TrimSpace(value)
}

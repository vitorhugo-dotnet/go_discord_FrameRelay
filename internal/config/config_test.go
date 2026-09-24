package config

import "testing"

func TestLoadUsesDocumentedDefaults(t *testing.T) {
	values := map[string]string{
		"DISCORD_TOKEN":              "discord-secret",
		"DISCORD_APPLICATION_ID":     "123456789012345678",
		"RELAYCONTROL_BASE_URL":      "https://relay.example.com/",
		"RELAYCONTROL_SERVICE_TOKEN": "relay-secret",
	}

	cfg, err := Load(func(key string) string { return values[key] })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ShareIntentTTL.String() != "10m0s" || cfg.WatchIntentTTL.String() != "30m0s" {
		t.Fatalf("unexpected intent defaults: share=%s watch=%s", cfg.ShareIntentTTL, cfg.WatchIntentTTL)
	}
	if cfg.IntentPollInterval.String() != "2s" || cfg.HTTPAddress != ":8080" {
		t.Fatalf("unexpected defaults: %#v", cfg)
	}
	if cfg.RelayControlBaseURL != "https://relay.example.com" {
		t.Fatalf("base URL was not normalized: %q", cfg.RelayControlBaseURL)
	}
}

func TestLoadRejectsMissingConfigurationWithoutPrintingSecrets(t *testing.T) {
	secret := "do-not-include-this-value"
	_, err := Load(func(key string) string {
		if key == "DISCORD_TOKEN" || key == "RELAYCONTROL_SERVICE_TOKEN" {
			return secret
		}
		return ""
	})
	if err == nil {
		t.Fatal("expected missing application id and relay URL error")
	}
	if contains(err.Error(), secret) {
		t.Fatal("configuration error leaked a secret")
	}
}

func TestLoadRejectsInvalidURLsDurationsAndApplicationIDs(t *testing.T) {
	base := map[string]string{
		"DISCORD_TOKEN":              "discord-secret",
		"DISCORD_APPLICATION_ID":     "not-a-snowflake",
		"RELAYCONTROL_BASE_URL":      "file:///tmp/relay",
		"RELAYCONTROL_SERVICE_TOKEN": "relay-secret",
		"SHARE_INTENT_TTL":           "0s",
	}
	_, err := Load(func(key string) string { return base[key] })
	if err == nil {
		t.Fatal("expected invalid configuration to be rejected")
	}
}

func contains(text, part string) bool {
	for i := 0; i+len(part) <= len(text); i++ {
		if text[i:i+len(part)] == part {
			return true
		}
	}
	return false
}

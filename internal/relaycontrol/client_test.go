package relaycontrol

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestCreateShareUsesServiceBearerAndReturnsOpaqueHTTPSLink(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/launch-intents/share" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer service-secret" {
			t.Errorf("service credential was not attached")
		}
		var request CreateShareRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode body: %v", err)
		}
		if request.Provider != "discord" || request.GuildID != "guild" || request.TTLSeconds != 600 {
			t.Errorf("unexpected request body: %#v", request)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":"launch-1","launchUrl":"https://framerelay.example/open/share/opaque","expiresAt":"2026-09-24T12:10:00Z"}`))
	}))
	defer server.Close()
	client := NewClient(server.URL, "service-secret", server.Client())

	result, err := client.CreateShare(context.Background(), CreateShareRequest{
		Provider: "discord", GuildID: "guild", ChannelID: "channel", RequestedByUserID: "user", TTLSeconds: 600,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ID != "launch-1" || !strings.HasPrefix(result.LaunchURL, "https://") {
		t.Fatalf("unexpected response: %#v", result)
	}
}

func TestCreateActivityUsesExactContractAndNormalizesCode(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/launch-intents/activity" || r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer service" {
			t.Errorf("unexpected Activity request")
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if len(body) != 5 || body["code"] != "ABC123" || body["guildId"] != "guild" || body["channelId"] != "channel" || body["requestedByUserId"] != "user" || body["ttlSeconds"] != float64(300) {
			t.Errorf("incorrect body: %#v", body)
		}
		_ = json.NewEncoder(w).Encode(ActivityIntent{ID: "intent", ExpiresAt: time.Now().Add(time.Minute)})
	}))
	defer server.Close()
	client := NewClient(server.URL, "service", server.Client())
	intent, err := client.CreateActivity(context.Background(), CreateActivityRequest{Code: " abc123 ", GuildID: "guild", ChannelID: "channel", RequestedByUserID: "user", TTLSeconds: 300})
	if err != nil || intent.ID != "intent" {
		t.Fatalf("intent=%#v err=%v", intent, err)
	}
}

func TestCreateActivityRejectsMissingIntent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(`{}`)) }))
	defer server.Close()
	_, err := NewClient(server.URL, "service", server.Client()).CreateActivity(context.Background(), CreateActivityRequest{})
	if err == nil {
		t.Fatal("empty success response must not allow Activity launch")
	}
}

func TestErrorsExposeOnlySafeCodeAndStatus(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"code":"unauthorized","error":"service-secret"}`))
	}))
	defer server.Close()
	client := NewClient(server.URL, "service-secret", server.Client())

	_, err := client.ListPending(context.Background())
	if err == nil || strings.Contains(err.Error(), "service-secret") {
		t.Fatalf("expected redacted service error, got %v", err)
	}
	if !strings.Contains(err.Error(), "unauthorized") || !strings.Contains(err.Error(), "401") {
		t.Fatalf("safe code/status missing: %v", err)
	}
}

func TestOperationsHonorCancellationAndUseWatchEndpoint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/launch-intents/watch" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"launchUrl":"https://framerelay.example/open/watch/token","expiresAt":"2026-09-24T12:30:00Z"}`))
	}))
	defer server.Close()
	client := NewClient(server.URL, "service-secret", server.Client())
	watch, err := client.CreateWatch(context.Background(), " ab12cd ", 1800)
	if err != nil || watch.LaunchURL == "" {
		t.Fatalf("create watch: %#v %v", watch, err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = client.ListPending(ctx)
	if err == nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancellation, got %v", err)
	}
}

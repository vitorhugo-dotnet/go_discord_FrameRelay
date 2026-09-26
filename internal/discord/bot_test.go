package discordbot

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestPublicReadyMessageContainsNoSharedCapabilityAndRetriesSameNonce(t *testing.T) {
	first := readyMessage("intent-1")
	encoded, err := json.Marshal(first)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err = json.Unmarshal(encoded, &body); err != nil {
		t.Fatal(err)
	}
	if len(first.Components) != 0 || strings.Contains(string(encoded), "https://") || !strings.Contains(first.Content, "/framerelay watch") || !strings.Contains(first.Content, "personal desktop watch link") {
		t.Fatalf("unexpected public ready message: %s", encoded)
	}
	if body["enforce_nonce"] != true || body["nonce"] == "" || body["nonce"] == nil {
		t.Fatalf("missing idempotent nonce: %s", encoded)
	}
	retry, _ := json.Marshal(readyMessage("intent-1"))
	if string(retry) != string(encoded) {
		t.Fatal("publication retry must use same nonce and content")
	}
	other, _ := json.Marshal(readyMessage("intent-2"))
	if string(other) == string(encoded) {
		t.Fatal("different intents must use different nonce")
	}
}

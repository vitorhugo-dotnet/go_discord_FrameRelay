package discordbot

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/disgoorg/disgo/bot"
	"github.com/disgoorg/disgo/discord"
	"github.com/disgoorg/disgo/rest"
	"github.com/disgoorg/snowflake/v2"
)

type commandRegistrationRest struct {
	rest.Rest
	created   int
	bulk      bool
	createErr error
	commands  []discord.ApplicationCommand
	deleted   []snowflake.ID
	listErr   error
	deleteErr error
	listed    bool
}

type registeredCommand struct {
	discord.ApplicationCommand
	id          snowflake.ID
	name        string
	commandType discord.ApplicationCommandType
}

func (c registeredCommand) ID() snowflake.ID                     { return c.id }
func (c registeredCommand) Name() string                         { return c.name }
func (c registeredCommand) Type() discord.ApplicationCommandType { return c.commandType }

func (r *commandRegistrationRest) GetGlobalCommands(_ snowflake.ID, _ bool, _ ...rest.RequestOpt) ([]discord.ApplicationCommand, error) {
	r.listed = true
	return r.commands, r.listErr
}

func (r *commandRegistrationRest) DeleteGlobalCommand(_ snowflake.ID, id snowflake.ID, _ ...rest.RequestOpt) error {
	r.deleted = append(r.deleted, id)
	return r.deleteErr
}

func (r *commandRegistrationRest) SetGlobalCommands(_ snowflake.ID, _ []discord.ApplicationCommandCreate, _ ...rest.RequestOpt) ([]discord.ApplicationCommand, error) {
	r.bulk = true
	return nil, errors.New("50240: Entry Point command cannot be removed by bulk update")
}

func (r *commandRegistrationRest) CreateGlobalCommand(_ snowflake.ID, _ discord.ApplicationCommandCreate, _ ...rest.RequestOpt) (discord.ApplicationCommand, error) {
	r.created++
	return nil, r.createErr
}

func TestRegisterCommandsPreservesActivityEntryPoint(t *testing.T) {
	r := &commandRegistrationRest{}
	if err := RegisterCommands(context.Background(), &bot.Client{Rest: r}, "1552826675438288996", ""); err != nil {
		t.Fatal(err)
	}
	if r.bulk || r.created != len(CommandDefinitions()) {
		t.Fatalf("bulk=%v created=%d", r.bulk, r.created)
	}
}

func TestRegisterCommandsReturnsUpsertFailure(t *testing.T) {
	want := errors.New("registration unavailable")
	r := &commandRegistrationRest{createErr: want}
	if err := RegisterCommands(context.Background(), &bot.Client{Rest: r}, "1552826675438288996", ""); !errors.Is(err, want) {
		t.Fatalf("error=%v want=%v", err, want)
	}
	if r.listed || len(r.deleted) != 0 {
		t.Fatal("must not prune after failed upsert")
	}
}

func TestRegisterCommandsPrunesObsoleteCommandsAndPreservesEntryPoint(t *testing.T) {
	r := &commandRegistrationRest{commands: []discord.ApplicationCommand{
		registeredCommand{id: 1, name: "framerelay", commandType: discord.ApplicationCommandTypeSlash},
		registeredCommand{id: 2, name: "old-framerelay", commandType: discord.ApplicationCommandTypeSlash},
		registeredCommand{id: 3, name: "Launch", commandType: discord.ApplicationCommandTypePrimaryEntryPoint},
		registeredCommand{id: 4, name: "framerelay", commandType: discord.ApplicationCommandTypeUser},
	}}
	if err := RegisterCommands(context.Background(), &bot.Client{Rest: r}, "1552826675438288996", ""); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(r.deleted, []snowflake.ID{2, 4}) {
		t.Fatalf("deleted=%v want=[2 4]", r.deleted)
	}
}

func TestRegisterCommandsReturnsPruningFailure(t *testing.T) {
	want := errors.New("pruning unavailable")
	for _, phase := range []string{"list", "delete"} {
		t.Run(phase, func(t *testing.T) {
			r := &commandRegistrationRest{commands: []discord.ApplicationCommand{
				registeredCommand{id: 2, name: "old-framerelay", commandType: discord.ApplicationCommandTypeSlash},
			}}
			if phase == "list" {
				r.listErr = want
			} else {
				r.deleteErr = want
			}
			if err := RegisterCommands(context.Background(), &bot.Client{Rest: r}, "1552826675438288996", ""); !errors.Is(err, want) {
				t.Fatalf("error=%v want=%v", err, want)
			}
			if phase == "list" && len(r.deleted) != 0 {
				t.Fatal("deleted commands after failed listing")
			}
		})
	}
}

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
	if len(first.Components) != 1 || strings.Contains(string(encoded), "https://") || !strings.Contains(first.Content, "/framerelay watch") || !strings.Contains(string(encoded), "Assistir no Discord") || !strings.Contains(string(encoded), "framerelay:watch:intent-1") {
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

func TestReadyButtonAcceptsOnlyExpectedIntentIDs(t *testing.T) {
	const id = "123e4567-e89b-12d3-a456-426614174000"
	if got := readyIntentFromCustomID("framerelay:watch:" + id); got != id {
		t.Fatalf("intent=%q", got)
	}
	for _, value := range []string{"framerelay:watch:", "framerelay:watch:../../other", "framerelay:watch:" + id + ":other", "other:" + id} {
		if got := readyIntentFromCustomID(value); got != "" {
			t.Fatalf("accepted %q", value)
		}
	}
}

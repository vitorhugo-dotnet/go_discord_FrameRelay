# FrameRelay Discord bot

This standalone Go service connects Discord slash commands to RelayControl launch intents. The desktop client owns screen capture and streaming. The bot launches a Discord Activity viewer or creates personal desktop launch links and publishes a readiness announcement when a share is ready.

## Commands

- `/framerelay share` responds privately with a one-click button that opens the FrameRelay desktop app. The owner starts capture and streaming in that app.
- `/framerelay watch code:<code>` creates a session/context-bound intent and responds with Discord `LAUNCH_ACTIVITY` (callback 12) before any defer. Run it in the voice channel's chat where the Activity will launch. If the Activity API is unavailable or Discord definitively rejects the launch callback, it defers and returns the existing private desktop watch button.

The bot also recovers ready-but-unpublished shares after restart. It polls status with `watchTtlSeconds=0`, caches readiness without minting a watch capability, and uses a stable Discord message nonce so a retry after a successful post does not duplicate the announcement. The public announcement asks every participant to run `/framerelay watch` with the host's code; it contains no shared single-use link. Each command invocation can provide its own desktop fallback link.

## Configuration

Copy `.env.example` and provide:

- `DISCORD_TOKEN`: bot token; keep it in the deployment secret store.
- `DISCORD_APPLICATION_ID`: Discord application ID.
- `DISCORD_GUILD_ID`: optional development server ID. When omitted, the command is registered globally.
- `RELAYCONTROL_BASE_URL`: RelayControl API base URL. HTTPS is required except for loopback development URLs.
- `RELAYCONTROL_SERVICE_TOKEN`: credential configured for the restricted `launch-intents:bot` policy in RelayControl. Give it only to this service.

The optional `SHARE_INTENT_TTL`, `WATCH_INTENT_TTL`, `INTENT_POLL_INTERVAL`, `HTTP_ADDR`, and `LOG_LEVEL` settings have validated defaults in `.env.example`. The API's public landing URL is configured as `RelayLaunch:PublicBaseUrl`; that endpoint opens the desktop protocol handler and offers the app download page. Set `RelayLaunch:ServiceToken` to the bot's `RELAYCONTROL_SERVICE_TOKEN`.

The Activity intent API attempt is capped at 1.5 seconds and shortened to reserve 500 milliseconds for the initial callback when gateway delivery consumed time. If that reserve is all that remains, the bot immediately defers for the desktop fallback. Initial Discord responses use the interaction creation timestamp plus 2.8 seconds, leaving margin inside Discord's 3-second deadline. An ambiguous network failure after sending callback 12 cannot safely be acknowledged again; retry the command in that case. No Activity success is reported without a valid unexpired intent. See [Activity hosting and setup](activity/README.md).

The bot requests no privileged Discord Gateway intents. Invite it with the `bot` and `applications.commands` scopes and grant it permission to view and send messages in channels where `/framerelay share` is used.

## Run locally

```powershell
Copy-Item .env.example .env
# Fill .env, then load it into the process environment using your preferred secret loader.
$env:GOTOOLCHAIN = 'go1.27.1'
go run ./cmd/framerelay-bot
```

For a development server, set `DISCORD_GUILD_ID` so Discord updates the slash command immediately. Without it, the bot replaces its global `/framerelay` command.

## Docker

```sh
docker build -t framerelay-discord-bot .
docker run --rm --env-file .env -p 8080:8080 framerelay-discord-bot
```

The container runs as an unprivileged user. `/healthz` reports process health; `/readyz` becomes healthy only after the Discord Gateway is connected and RelayControl responds. Do not expose the health port publicly unless needed by the orchestrator.

## Checks

```sh
gofmt -w .
go vet ./...
go test -race ./...
go build ./cmd/framerelay-bot
```

No request body, bot token, service credential, deep link, or watch capability is included in application logs. Operational logs use JSON and report only operation names.

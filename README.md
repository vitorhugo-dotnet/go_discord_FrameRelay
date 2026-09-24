# FrameRelay Discord bot

This standalone Go service connects Discord slash commands to RelayControl launch intents. The desktop client still owns screen capture and streaming; the bot only creates short-lived launch links and publishes a watch button when a share is ready.

## Commands

- `/framerelay share` responds privately with a one-click button that opens the FrameRelay desktop app. The owner starts capture and streaming in that app.
- `/framerelay watch code:<code>` responds privately with a one-click watch button. Viewers join through the normal RelayControl session join path.

The bot also recovers ready-but-unpublished shares after restart. It uses a stable Discord message nonce so a retry after a successful post does not duplicate the announcement.

## Configuration

Copy `.env.example` and provide:

- `DISCORD_TOKEN`: bot token; keep it in the deployment secret store.
- `DISCORD_APPLICATION_ID`: Discord application ID.
- `DISCORD_GUILD_ID`: optional development server ID. When omitted, the command is registered globally.
- `RELAYCONTROL_BASE_URL`: RelayControl API base URL. HTTPS is required except for loopback development URLs.
- `RELAYCONTROL_SERVICE_TOKEN`: credential configured for the restricted `launch-intents:bot` policy in RelayControl. Give it only to this service.

The optional `SHARE_INTENT_TTL`, `WATCH_INTENT_TTL`, `INTENT_POLL_INTERVAL`, `HTTP_ADDR`, and `LOG_LEVEL` settings have validated defaults in `.env.example`. The API's public landing URL is configured in RelayControl as `LaunchIntents:PublicBaseUrl`; that endpoint redirects to the desktop protocol handler and offers the app download page.

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

## Deploy to a VPS

The `CI` workflow runs formatting, vet, race-enabled tests, and a Go build on pull requests. A push to `main` publishes `ghcr.io/vitorhugo-dotnet/framerelay-discord-bot` with a commit tag and `latest`, then deploys it to the VPS over SSH. Manual workflow runs default to `deploy: false`; selecting `true` publishes and deploys that commit.

Before the first deploy:

1. Install Docker Engine and the Docker Compose plugin on the VPS, and allow the SSH user to run Docker.
2. Create `/docker/frameRelayDiscordBot/.env` from the repository's `.env.example`. Set `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID`, `RELAYCONTROL_BASE_URL`, and `RELAYCONTROL_SERVICE_TOKEN`; keep this file only on the VPS.
3. Add these repository Actions secrets: `VPS_HOST`, `VPS_USER`, and `VPS_SSH_KEY`. `VPS_PORT` is optional and defaults to `22`. `VPS_APP_DIR` is optional and defaults to `/docker/frameRelayDiscordBot`; use this bot-specific directory rather than the RelayControl application directory.

The deploy job uses its short-lived `GITHUB_TOKEN` to pull the GHCR image and removes the temporary Docker credentials when it finishes. Discord and RelayControl credentials stay in the VPS `.env` and are not sent to GitHub Actions.

## Checks

```sh
gofmt -w .
go vet ./...
go test -race ./...
go build ./cmd/framerelay-bot
```

No request body, bot token, service credential, deep link, or watch capability is included in application logs. Operational logs use JSON and report only operation names.

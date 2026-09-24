#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/docker/frameRelayDiscordBot}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
IMAGE="${IMAGE:?IMAGE is required}"

cd "$APP_DIR"

if [[ ! -f .env ]]; then
  echo "Missing $APP_DIR/.env"
  echo "Create it from the repository .env.example and fill in the bot and RelayControl credentials."
  exit 1
fi

for key in DISCORD_TOKEN DISCORD_APPLICATION_ID RELAYCONTROL_BASE_URL RELAYCONTROL_SERVICE_TOKEN; do
  if ! grep -Eq "^[[:space:]]*${key}=" .env; then
    echo "Missing ${key} in $APP_DIR/.env"
    exit 1
  fi
done

command -v docker >/dev/null 2>&1 || {
  echo "Docker is not installed on the VPS."
  exit 1
}
docker compose version >/dev/null 2>&1 || {
  echo "Docker Compose plugin is not available on the VPS."
  exit 1
}

export IMAGE
echo "Pulling image: $IMAGE"
docker compose -f "$COMPOSE_FILE" pull bot
docker compose -f "$COMPOSE_FILE" up -d --remove-orphans

echo "Waiting for the bot container health check"
for attempt in $(seq 1 30); do
  status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' framerelay-discord-bot 2>/dev/null || true)"
  if [[ "$status" == healthy || "$status" == running ]]; then
    echo "Bot container is $status"
    docker compose -f "$COMPOSE_FILE" ps
    exit 0
  fi
  if [[ "$status" == unhealthy || "$status" == exited || "$status" == dead ]]; then
    echo "Bot container entered $status state"
    docker compose -f "$COMPOSE_FILE" logs --tail=80 bot || true
    exit 1
  fi
  sleep 2
done

echo "Bot container did not become healthy in time"
docker compose -f "$COMPOSE_FILE" logs --tail=80 bot || true
exit 1

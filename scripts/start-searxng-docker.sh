#!/usr/bin/env bash
# Spin up a self-hosted SearXNG instance with JSON output enabled.
# Required because DDG blocks consumer IPs and public SearXNG instances
# rate-limit / bot-challenge the same ranges. Self-hosting on a server
# (or even localhost behind a VPN) gives Zeus a working webSearch
# backend without paying for Brave/Tavily/SerpAPI.
#
# Prereqs: docker + docker compose. Tested with SearXNG 2026.07+.
#
# Usage:
#   bash scripts/start-searxng-docker.sh          # start on :8888
#   bash scripts/start-searxng-docker.sh stop     # stop + remove
#
# Then in Zeus:
#   ZEUS_SEARCH_PROVIDER=searxng
#   ZEUS_SEARXNG_URL=http://localhost:8888
set -euo pipefail

COMPOSE_FILE="$(mktemp -d)/docker-compose.yml"
PORT="${ZEUS_SEARXNG_PORT:-8888}"

if [[ "${1:-}" == "stop" ]]; then
  echo "Stopping searxng stack on :${PORT}..."
  cd "$(dirname "${COMPOSE_FILE}")" 2>/dev/null && docker compose down --remove-orphans || true
  exit 0
fi

mkdir -p "$(dirname "${COMPOSE_FILE}")"
cat > "${COMPOSE_FILE}" <<EOF
services:
  searxng:
    image: searxng/searxng:latest
    container_name: zeus-searxng
    ports:
      - "${PORT}:8080"
    volumes:
      - ./searxng-settings.yml:/etc/searxng/settings.yml:ro
    restart: unless-stopped
EOF

cat > "$(dirname "${COMPOSE_FILE}")/searxng-settings.yml" <<'YAML'
use_default_settings: true
server:
  bind_address: "0.0.0.0"
  port: 8080
  secret_key: "change-me-in-production-please-this-is-a-default-for-local-use-only"
  limiter: false
  image_proxy: false
search:
  formats:
    - html
    - json
YAML

cd "$(dirname "${COMPOSE_FILE}")"
docker compose up -d
echo ""
echo "SearXNG starting on http://localhost:${PORT}"
echo "Verify JSON output: curl 'http://localhost:${PORT}/search?q=test&format=json'"
echo "Then in Zeus .env:"
echo "  ZEUS_SEARCH_PROVIDER=searxng"
echo "  ZEUS_SEARXNG_URL=http://localhost:${PORT}"
#!/bin/sh
# Writes .env with fresh random secrets.   Usage: sh infra/gen-env.sh chat.example.com
set -eu
cd "$(dirname "$0")/.."
if [ -e .env ]; then echo ".env already exists — not touching it." >&2; exit 1; fi
DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then printf 'Domain (e.g. chat.example.com): '; read -r DOMAIN; fi
rand() { openssl rand -hex "$1"; }
sed \
  -e "s|^DOMAIN=.*|DOMAIN=${DOMAIN}|" \
  -e "s|^SECRET=.*|SECRET=$(rand 32)|" \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(rand 24)|" \
  -e "s|^LIVEKIT_API_KEY=.*|LIVEKIT_API_KEY=key$(rand 6)|" \
  -e "s|^LIVEKIT_API_SECRET=.*|LIVEKIT_API_SECRET=$(rand 32)|" \
  .env.example > .env
chmod 600 .env
echo "Wrote .env for ${DOMAIN}. Next: docker compose up -d"

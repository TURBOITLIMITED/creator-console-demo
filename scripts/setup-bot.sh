#!/bin/bash
# Setup a Telegram bot webhook for the creator-console-demo
# Usage: ./scripts/setup-bot.sh <persona> [webhook_secret]

set -e

PERSONA="${1:-michelle0161bot}"
WEBHOOK_SECRET="${2:-turboit-webhook-secret}"
API_DIR="$(cd "$(dirname "$0")/.." && pwd)/api"
SUPABASE_ENV="/home/ops/.config/turbo-it/creator-assistant-supabase.env"

echo "Setting up webhook for persona: $PERSONA"

# Get Supabase service key
export SUPABASE_SERVICE_KEY=$(grep SUPABASE_SERVICE_KEY "$SUPABASE_ENV" | cut -d= -f2)

# Get bot token from database
BOT_TOKEN=$(curl -s "https://xsgvdlgmhuxozjlbjzxy.supabase.co/rest/v1/bots?select=token&persona=eq.${PERSONA}" \
  -H "apikey: $SUPABASE_SERVICE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['token'])")

if [ -z "$BOT_TOKEN" ] || [ "$BOT_TOKEN" = "None" ]; then
  echo "Error: No bot found for persona '$PERSONA'"
  exit 1
fi

echo "Bot token: ${BOT_TOKEN:0:10}..."

# Set webhook secret on Worker
echo "Setting TELEGRAM_WEBHOOK_SECRET on Worker..."
cd "$API_DIR"
wrangler secret put TELEGRAM_WEBHOOK_SECRET --name creator-api <<< "$WEBHOOK_SECRET"

# Deploy Worker to pick up the secret
echo "Deploying Worker..."
wrangler deploy

# Delete old webhook and set new one
WEBHOOK_URL="https://api-telebotcreator.turboit.uk/tg/${PERSONA}"
echo "Deleting old webhook..."
curl -s "https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook" > /dev/null

echo "Setting new webhook..."
curl -s "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${WEBHOOK_URL}&secret_token=${WEBHOOK_SECRET}" | python3 -m json.tool

# Verify
echo ""
echo "Webhook info:"
curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo" | python3 -m json.tool

echo ""
echo "Done! Webhook is live at: $WEBHOOK_URL"

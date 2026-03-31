#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "" ]]; then
  echo "usage: $0 <chat_id> [--file|--image]"
  echo "example: $0 oc_xxx --file"
  exit 2
fi

CHAT_ID="$1"
MODE="${2:---file}"

if [[ "$MODE" != "--file" && "$MODE" != "--image" ]]; then
  echo "invalid mode: $MODE (use --file or --image)"
  exit 2
fi

ts="$(date +%Y%m%d-%H%M%S)"
out="inbox/screenshot-${ts}.png"

mkdir -p inbox
screencapture -x -t png "$out"

# Note: lark-cli requires local paths relative to current directory.
lark-cli im +messages-send --as bot --chat-id "$CHAT_ID" "$MODE" "$out"

echo "sent: $out"

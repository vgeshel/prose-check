#!/bin/sh
# Runs adapters/$1.ts, the Codex or Muse Code hook command, from the installed
# plugin copy with Bun. Looks for Bun on PATH, then at ~/.bun/bin/bun, where
# Bun's installer puts it. Without Bun, every turn finishes unchecked: a Stop
# event gets an empty result, and a SessionStart event gets a message that
# says so.
harness="$1"
root="$(cd "$(dirname "$0")/.." && pwd)" || { printf '{}\n'; exit 0; }
bun="$(command -v bun 2>/dev/null)"
if [ -z "$bun" ] && [ -x "$HOME/.bun/bin/bun" ]; then bun="$HOME/.bun/bin/bun"; fi
if [ -z "$bun" ]; then
  # Read the whole event before matching, so the harness never writes to a closed pipe.
  event="$(cat)"
  if printf '%s' "$event" | grep -Eq '"hook_event_name"[[:space:]]*:[[:space:]]*"SessionStart"'; then
    printf '%s\n' '{"systemMessage":"prose-check: Bun was not found on PATH or at ~/.bun/bin/bun, so every reply finishes unchecked. Install Bun from https://bun.com, then start a new session."}'
  else
    printf '{}\n'
  fi
  exit 0
fi
cd "$root" && exec "$bun" --no-env-file "adapters/$harness.ts"

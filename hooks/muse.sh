#!/bin/sh
# Muse Code hook launcher. Runs the adapter from the installed plugin copy;
# prints an empty result, which lets the turn finish unchecked, when Bun is
# missing.
root="$(cd "$(dirname "$0")/.." && pwd)" || { printf '{}\n'; exit 0; }
command -v bun >/dev/null 2>&1 || { printf '{}\n'; exit 0; }
cd "$root" && exec bun --no-env-file adapters/muse.ts

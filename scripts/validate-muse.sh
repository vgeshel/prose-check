#!/bin/sh
# Validates the Muse Code package as an install sees it: the tracked files
# only. A working copy's node_modules holds symbolic links, which Muse Code
# refuses in a package.
set -eu
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
git ls-files -z | xargs -0 tar -cf - | tar -xf - -C "$dir"
muse plugins validate "$dir" --json

#!/bin/sh
# Makes a Muse Code login for the integration suite, separate from your own.
#
# Muse Code saves an account login only in a macOS keychain, and the suite's
# sandboxes must not share yours: a sandbox that refreshes a shared token can
# sign you out. This script creates ~/.config/prose-check/muse-home with a
# keychain of its own, runs `muse login` there (you approve a code in your
# browser), and checks that the login answers. The suite then gives each Muse
# Code sandbox this login. Every `security` command runs with HOME set to the
# test home, so your own keychain and its settings stay unchanged.
#
#   sh integration/muse-login.sh
set -eu

home="$HOME/.config/prose-check/muse-home"
keychain="$home/Library/Keychains/login.keychain-db"
# Must match MUSE_TEST_KEYCHAIN_PASSWORD in integration/lib.ts.
password="prose-check-integration"

in_test_home() {
  env -i HOME="$home" PATH="$PATH" USER="$USER" LANG=C.UTF-8 TERM="${TERM:-xterm-256color}" "$@"
}

mkdir -p "$home/.config/muse" "$home/Library/Keychains" "$home/check"
chmod 700 "$home"
[ -f "$HOME/.config/muse/settings.json" ] && cp "$HOME/.config/muse/settings.json" "$home/.config/muse/"

if [ ! -f "$keychain" ]; then
  in_test_home security create-keychain -p "$password" "$keychain"
  in_test_home security set-keychain-settings "$keychain"
  in_test_home security default-keychain -d user -s "$keychain"
fi
in_test_home security unlock-keychain -p "$password" "$keychain"

echo "Approve the code that muse login shows, in your browser."
(cd "$home" && in_test_home muse login)

reply="$(cd "$home/check" && in_test_home muse exec "Reply with the single word: ready" < /dev/null 2>&1 | tail -n 1)" || true
echo "Muse Code answered: $reply"
case "$reply" in
  *ready*) echo "The test login works. The integration suite uses it from now on." ;;
  *) echo "The test login does not answer. Run this script again." >&2; exit 1 ;;
esac

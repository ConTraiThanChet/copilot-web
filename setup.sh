#!/usr/bin/env bash
# Copilot Web one-command setup.
#
#   curl -fsSL https://raw.githubusercontent.com/ConTraiThanChet/copilot-web/main/setup.sh | bash
#
# Downloads the latest official GitHub Copilot desktop app, builds the web UI,
# enables autostart (Copilot Web starts whenever the codespace opens) and starts
# it. Re-running the command updates Copilot Web and the app.
#
# Options (environment variables):
#   COPILOT_WEB_REPO      git URL to install from (default: public GitHub mirror)
#   COPILOT_WEB_DIR       checkout location (default: ~/copilot-web)
#   COPILOT_WEB_PORT      web port (default: 8787)
#   COPILOT_WEB_PASSWORD  optional password for the web UI
# Flags: --no-start (install + autostart only), --no-autostart
set -euo pipefail

REPO_URL="${COPILOT_WEB_REPO:-https://github.com/ConTraiThanChet/copilot-web.git}"
DIR="${COPILOT_WEB_DIR:-$HOME/copilot-web}"
START=1
AUTOSTART=1
for arg in "$@"; do
  case "$arg" in
    --no-start) START=0 ;;
    --no-autostart) AUTOSTART=0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1;34m[copilot-web]\033[0m %s\n' "$*" >&2; }

# Running from a checkout (e.g. devcontainer or `./setup.sh`): use it in place.
SELF_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
if [ -n "$SELF_DIR" ] && [ -x "$SELF_DIR/bin/copilot-web" ]; then
  DIR="$SELF_DIR"
else
  command -v git >/dev/null 2>&1 || { sudo apt-get update -qq && sudo apt-get install -y -qq git >/dev/null; }
  if [ -d "$DIR/.git" ]; then
    say "Updating $DIR"
    git -C "$DIR" pull --ff-only --quiet
  else
    if [ -e "$DIR" ]; then
      say "Moving existing $DIR to $DIR.bak.$$"
      mv "$DIR" "$DIR.bak.$$"
    fi
    say "Cloning $REPO_URL into $DIR"
    git clone --quiet --depth 1 "$REPO_URL" "$DIR"
  fi
fi

CLI="$DIR/bin/copilot-web"
chmod +x "$CLI"
mkdir -p "$HOME/.local/bin"
ln -sf "$CLI" "$HOME/.local/bin/copilot-web"

STATE_DIR="${COPILOT_WEB_STATE:-$HOME/.local/share/copilot-web}"
if [ -x "$STATE_DIR/app/usr/bin/github" ]; then
  "$CLI" install --latest
else
  "$CLI" install
fi

[ "$AUTOSTART" -eq 1 ] && "$CLI" autostart enable

if [ "$START" -eq 1 ]; then
  if [ -f "$STATE_DIR/run/backend.pid" ] && kill -0 "$(cat "$STATE_DIR/run/backend.pid")" 2>/dev/null; then
    "$CLI" restart
  else
    "$CLI" start
  fi
  say "Open: $("$CLI" url)"
  say "Sign in with your GitHub account in the web UI if asked."
fi
say "Command available as: copilot-web (status | logs | update | stop)"

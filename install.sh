#!/usr/bin/env bash
# ==============================================================================
# tokenline installer
#
# Verifies dependencies and prints the Claude Code settings.json snippet that
# enables the statusline. It does NOT edit your settings file — it prints the
# block so you can paste it where you want (global or per-project).
#
# Usage:
#   ./install.sh                  # from a clone: uses the tokenline.sh next to it
#   curl -fsSL https://github.com/inbrace-tech/tokenline/releases/latest/download/install.sh | bash
#                                 # no clone: downloads the latest release's
#                                 # tokenline.sh to ~/.claude (TOKENLINE_DIR to
#                                 # change it). Re-running it updates in place.
# ==============================================================================
set -euo pipefail

# Everything runs inside main(), called on the last line. Piped through
# `curl | bash`, bash executes a script as it arrives; a function only runs once
# its whole body has been read, so a download cut off mid-way runs nothing.
# The body is deliberately not indented: the snippet below is a heredoc, and
# indenting it would change what gets printed.
main() {

c_green=$'\033[0;32m'; c_red=$'\033[0;31m'; c_yellow=$'\033[0;33m'; c_reset=$'\033[0m'
ok()   { printf '%s✓%s %s\n' "$c_green"  "$c_reset" "$1"; }
warn() { printf '%s!%s %s\n'      "$c_yellow" "$c_reset" "$1"; }
err()  { printf '%s✗%s %s\n' "$c_red"    "$c_reset" "$1"; }

# From a clone, BASH_SOURCE points at this file and tokenline.sh sits next to it.
# Piped through `curl | bash` there is no file, so download the release asset,
# which the Release workflow stamps with its version and this update command.
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/tokenline.sh" ]; then
  TOKENLINE="$SCRIPT_DIR/tokenline.sh"
else
  dest_dir="${TOKENLINE_DIR:-$HOME/.claude}"
  asset_url="${TOKENLINE_ASSET_URL:-https://github.com/inbrace-tech/tokenline/releases/latest/download/tokenline.sh}"
  printf '\ntokenline — downloading the latest release\n'
  printf '%s\n' "--------------------------------"
  if ! command -v curl >/dev/null 2>&1; then
    err "curl not found — install curl, or clone the repo and run ./install.sh"
    exit 1
  fi
  mkdir -p "$dest_dir"
  tmp="$(mktemp "$dest_dir/.tokenline.sh.XXXXXX")"
  trap 'rm -f "$tmp"' EXIT
  if ! curl -fsSL "$asset_url" -o "$tmp"; then
    err "download failed: $asset_url"
    exit 1
  fi
  # Refuse anything that isn't a stamped tokenline.sh (an error page, a proxy
  # login page, a truncated file) before it replaces a working statusline.
  version="$(sed -n 's/^TOKENLINE_VERSION="\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)"$/\1/p' "$tmp")"
  if [ "$(head -n 1 "$tmp")" != "#!/usr/bin/env bash" ] || [ -z "$version" ]; then
    err "downloaded file is not a tokenline.sh release asset — nothing changed"
    exit 1
  fi
  chmod 755 "$tmp"
  mv -f "$tmp" "$dest_dir/tokenline.sh"
  trap - EXIT
  TOKENLINE="$dest_dir/tokenline.sh"
  ok "tokenline.sh v$version → $TOKENLINE"
fi

printf '\ntokenline — dependency check\n'
printf '%s\n' "--------------------------------"

missing=0

# bash 4+ (mapfile). macOS ships 3.2 — `brew install bash` provides 5.x.
if [ "${BASH_VERSINFO[0]:-0}" -ge 4 ]; then
  ok "bash ${BASH_VERSION%%(*}"
else
  err "bash 4+ required (found ${BASH_VERSION%%(*}). On macOS: brew install bash"
  missing=1
fi

# jq — the JSON parser the statusline depends on
if command -v jq >/dev/null 2>&1; then
  ok "jq $(jq --version 2>/dev/null)"
else
  err "jq not found — install it (apt install jq / brew install jq)"
  missing=1
fi

# date: GNU (-d) or BSD (-j) — tokenline handles both.
if date -d "@0" >/dev/null 2>&1; then
  ok "date (GNU -d)"
elif date -j -f "%s" 0 >/dev/null 2>&1; then
  ok "date (BSD -j)"
else
  err "no usable date (need GNU -d or BSD -j)"
  missing=1
fi

# stat: GNU (-c) or BSD (-f) — tokenline handles both.
if stat -c %Y . >/dev/null 2>&1; then
  ok "stat (GNU -c)"
elif stat -f %m . >/dev/null 2>&1; then
  ok "stat (BSD -f)"
else
  err "no usable stat (need GNU -c or BSD -f)"
  missing=1
fi

# the script itself
if [ -f "$TOKENLINE" ]; then
  chmod +x "$TOKENLINE" 2>/dev/null || true
  ok "tokenline.sh found"
else
  err "tokenline.sh not found next to install.sh"
  missing=1
fi

printf '\n'
if [ "$missing" -ne 0 ]; then
  warn "Missing dependencies above. On macOS: brew install bash jq."
  warn "Windows support is on the roadmap (see README)."
  printf '\n'
fi

# Already wired (a re-run to update): the block is in place, nothing to paste.
for settings in "$HOME/.claude/settings.json" "$HOME/.gemini/antigravity-cli/settings.json"; do
  if [ -f "$settings" ] && grep -qF "\"bash $TOKENLINE\"" "$settings"; then
    ok "already wired in $settings — the statusline picks up this version on its next refresh"
    printf '\n'
    exit 0
  fi
done

printf 'Add this to %s/.claude/settings.json (or project .claude/settings.json)\n' "$HOME"
printf 'or %s/.gemini/antigravity-cli/settings.json (for Antigravity CLI),\n' "$HOME"
printf 'inside the top-level object:\n\n'
cat <<EOF
  "statusLine": {
    "type": "command",
    "command": "bash $TOKENLINE",
    "refreshInterval": 1
  }
EOF
printf '\nThen restart Claude Code or Antigravity CLI. Enjoy your cache-aware statusline.\n\n'
}

main "$@"

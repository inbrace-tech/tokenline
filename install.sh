#!/usr/bin/env bash
# ==============================================================================
# tokenline installer
#
# Copies tokenline.sh into one or more Claude profile directories and safely
# patches each settings.json (backup, merge-only statusLine, idempotent, never
# clobbers invalid JSON). Mirrors the npm CLI in pure bash + jq, so non-Node
# users get the same guarantees.
#
# Runs on stock macOS bash 3.2 (no bash-4 features here). Animations show only
# on a TTY; piped/non-interactive runs stay plain and never prompt.
#
# Usage:
#   ./install.sh                 # interactive — pick one or more profiles
#   ./install.sh --yes           # non-interactive — install to ~/.claude
#   ./install.sh --dir <path>    # install to a specific directory
#   ./install.sh --dry-run       # show what would happen, write nothing
#   ./install.sh --print         # only print the settings snippet
#   ./install.sh --force         # replace a different existing statusLine
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOKENLINE_SRC="$SCRIPT_DIR/tokenline.sh"

# --- Options -----------------------------------------------------------------
OPT_DIR=""
OPT_YES=0
OPT_DRYRUN=0
OPT_PRINT=0
OPT_FORCE=0

usage() {
  sed -n '3,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) OPT_DIR="${2:-}"; shift 2 ;;
    -y|--yes) OPT_YES=1; shift ;;
    --dry-run) OPT_DRYRUN=1; shift ;;
    --print) OPT_PRINT=1; shift ;;
    --force) OPT_FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown option: %s (try --help)\n' "$1" >&2; exit 2 ;;
  esac
done

# --- Presentation ------------------------------------------------------------
# Colors and animation only when stdout is a TTY and NO_COLOR is unset.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_ACCENT=$'\033[38;5;51m'; C_DIM=$'\033[38;5;244m'; C_OK=$'\033[38;5;46m'
  C_ERR=$'\033[38;5;196m'; C_WARN=$'\033[38;5;226m'; C_BOLD=$'\033[1m'
  C_RESET=$'\033[0m'; TTY=1
else
  C_ACCENT=""; C_DIM=""; C_OK=""; C_ERR=""; C_WARN=""; C_BOLD=""
  C_RESET=""; TTY=0
fi
ANIM=$TTY
[ "$OPT_DRYRUN" -eq 1 ] && ANIM=0

# Restore the cursor if the arrow-key menu is interrupted mid-draw.
[ "$TTY" -eq 1 ] && trap 'printf "\033[?25h"' EXIT INT TERM

nap() { [ "$ANIM" -eq 1 ] && sleep 0.04; return 0; }

hero() {
  printf '\n %s%stokenline%s\n' "$C_BOLD" "$C_ACCENT" "$C_RESET"
  printf ' %scache-aware statusline installer%s\n\n' "$C_DIM" "$C_RESET"
}

ok_line()   { printf ' %s✓%s %s\n' "$C_OK" "$C_RESET" "$1"; nap; }
warn_line() { printf ' %s!%s %s\n' "$C_WARN" "$C_RESET" "$1"; nap; }
err_line()  { printf ' %s✗%s %s\n' "$C_ERR" "$C_RESET" "$1" >&2; nap; }
note_line() { printf ' %s→ %s%s\n' "$C_DIM" "$1" "$C_RESET"; nap; }

# Decorative braille spinner held for ~$1 seconds while $2 is the label. The work
# runs synchronously right after, so this only paces the reveal — never fakes a
# result. No-ops off a TTY.
spin_for() {
  local secs="$1" label="$2"
  [ "$ANIM" -eq 1 ] || return 0
  local frames=( ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏ )
  local n i=0
  n=$(awk -v s="$secs" 'BEGIN { printf "%d", s / 0.08 }')
  while [ "$i" -lt "$n" ]; do
    printf '\r %s%s%s %s' "$C_ACCENT" "${frames[$((i % 10))]}" "$C_RESET" "$label"
    i=$((i + 1)); sleep 0.08
  done
  printf '\r\033[K'
}

# --- Path helpers ------------------------------------------------------------
expand_path() {
  # Expand a leading ~ in user-typed paths. The quoted "~/" is matched
  # literally on purpose (we want the tilde character, not shell expansion).
  # shellcheck disable=SC2088
  case "$1" in
    "~") printf '%s' "$HOME" ;;
    "~/"*) printf '%s/%s' "$HOME" "${1#"~/"}" ;;
    *) printf '%s' "$1" ;;
  esac
}

statusline_command() {
  # Quote only when the path has a space, to match the npm CLI byte-for-byte.
  case "$1" in
    *" "*) printf 'bash "%s"' "$1" ;;
    *) printf 'bash %s' "$1" ;;
  esac
}

# --- Dependency check --------------------------------------------------------
HAVE_JQ=0
check_deps() {
  local missing=0
  spin_for 0.5 "checking dependencies"

  # Check the `bash` on PATH — that's what runs `bash tokenline.sh`, not the
  # interpreter running this installer (stock macOS launches it as 3.2). Ask
  # that bash for its own version so a localized `--version` can't break it.
  local bash_ver bash_major
  bash_ver=$(bash -c 'printf "%s.%s" "${BASH_VERSINFO[0]}" "${BASH_VERSINFO[1]}"' 2>/dev/null)
  bash_major=${bash_ver%%.*}
  if [ -n "$bash_major" ] && [ "$bash_major" -ge 4 ] 2>/dev/null; then
    ok_line "bash $bash_ver"
  else
    err_line "bash 4+ required for the statusline (PATH bash is ${bash_ver:-unknown}). On macOS: brew install bash"
    missing=1
  fi

  if command -v jq >/dev/null 2>&1; then
    HAVE_JQ=1
    ok_line "jq $(jq --version 2>/dev/null)"
  else
    err_line "jq not found — install it (apt install jq / brew install jq)"
    missing=1
  fi

  if date -d "@0" >/dev/null 2>&1 || date -j -f "%s" 0 >/dev/null 2>&1; then
    ok_line "date (GNU or BSD)"
  else
    err_line "no usable date (need GNU -d or BSD -j)"
    missing=1
  fi

  if stat -c %Y . >/dev/null 2>&1 || stat -f %m . >/dev/null 2>&1; then
    ok_line "stat (GNU or BSD)"
  else
    err_line "no usable stat (need GNU -c or BSD -f)"
    missing=1
  fi

  if [ -f "$TOKENLINE_SRC" ]; then
    ok_line "tokenline.sh found"
  else
    err_line "tokenline.sh not found next to install.sh"
    missing=1
  fi

  return "$missing"
}

# --- Profile selection -------------------------------------------------------
CAND_PATHS=()
CAND_LABELS=()
add_candidate() {
  local p="$1" label="$2" existing
  if [ "${#CAND_PATHS[@]}" -gt 0 ]; then
    for existing in "${CAND_PATHS[@]}"; do
      [ "$existing" = "$p" ] && return 0
    done
  fi
  CAND_PATHS+=("$p")
  CAND_LABELS+=("$label")
}

discover_candidates() {
  add_candidate "$HOME/.claude" "default"
  local d
  shopt -s nullglob
  for d in "$HOME"/.claude-* "$HOME"/.claude_*; do
    [ -d "$d" ] && add_candidate "$d" "profile"
  done
  shopt -u nullglob
  [ -d "$PWD/.claude" ] && add_candidate "$PWD/.claude" "this project"
}

# Clip a string to $2 columns, adding an ellipsis, so a long path can't wrap and
# desync the redraw line count.
fit() {
  local s="$1" max="$2"
  if [ "$max" -lt 1 ]; then printf '%s' "$s"; return 0; fi
  if [ "${#s}" -gt "$max" ]; then printf '%s…' "${s:0:$((max - 1))}"; else printf '%s' "$s"; fi
}

# Menu state shared between select_arrows() and draw_menu().
CURSOR=0
CUSTOM_IDX=0
COLS=80
SEL=()

draw_menu() {
  local i box cur label
  for i in "${!CAND_PATHS[@]}"; do
    cur="  "; [ "$i" -eq "$CURSOR" ] && cur="${C_ACCENT}❯${C_RESET} "
    box="${C_DIM}◯${C_RESET}"; [ "${SEL[$i]:-0}" = "1" ] && box="${C_OK}◉${C_RESET}"
    label="${CAND_PATHS[$i]}"
    [ -n "${CAND_LABELS[$i]}" ] && label="$label  (${CAND_LABELS[$i]})"
    printf '   %s%s %s\033[K\n' "$cur" "$box" "$(fit "$label" "$((COLS - 8))")"
  done
  cur="  "; [ "$CURSOR" -eq "$CUSTOM_IDX" ] && cur="${C_ACCENT}❯${C_RESET} "
  printf '   %s  %scustom path…%s\033[K\n' "$cur" "$C_DIM" "$C_RESET"
}

# Arrow-key multi-select. ↑/↓ move, space toggles, digits 1-9 jump+toggle,
# Enter confirms, q/Esc cancels. Pure bash + ANSI; no stty, so it works the same
# on macOS bash 3.2 and Linux. Fills TARGETS.
select_arrows() {
  local total key k2 i
  CURSOR=0; SEL=()
  for i in "${!CAND_PATHS[@]}"; do SEL[i]=0; done
  CUSTOM_IDX=${#CAND_PATHS[@]}
  total=$((CUSTOM_IDX + 1))
  COLS=$(tput cols 2>/dev/null || printf 80)

  printf ' %sInstall to which profile?%s %s(↑/↓ move · space toggle · 1-9 quick · enter confirm)%s\n\n' \
    "$C_BOLD" "$C_RESET" "$C_DIM" "$C_RESET"
  printf '\033[?25l'
  draw_menu

  while :; do
    IFS= read -rsn1 key || key=""
    if [ "$key" = $'\033' ]; then
      IFS= read -rsn2 -t 1 k2 2>/dev/null || k2=""
      key="$key$k2"
    fi
    case "$key" in
      $'\033[A'|$'\033OA') CURSOR=$(((CURSOR - 1 + total) % total)) ;;
      $'\033[B'|$'\033OB') CURSOR=$(((CURSOR + 1) % total)) ;;
      ' ') [ "$CURSOR" -ne "$CUSTOM_IDX" ] && SEL[CURSOR]=$((1 - ${SEL[CURSOR]:-0})) ;;
      [1-9])
        i=$((key - 1))
        if [ "$i" -lt "$CUSTOM_IDX" ]; then CURSOR=$i; SEL[i]=$((1 - ${SEL[i]:-0})); fi
        ;;
      ""|$'\n'|$'\r') break ;;
      q|Q|$'\033') CURSOR=-1; break ;;
      *) : ;;
    esac
    printf '\033[%dA' "$total"
    draw_menu
  done
  printf '\033[?25h\n'

  if [ "$CURSOR" -eq -1 ]; then err_line "cancelled"; exit 1; fi

  if [ "$CURSOR" -eq "$CUSTOM_IDX" ]; then
    local custom
    printf ' %sCustom path%s: ' "$C_BOLD" "$C_RESET"
    IFS= read -r custom || custom=""
    printf '\n'
    [ -n "$custom" ] || { err_line "no path given"; exit 1; }
    TARGETS=( "$(expand_path "$custom")" )
    return 0
  fi

  TARGETS=()
  for i in "${!CAND_PATHS[@]}"; do
    [ "${SEL[$i]:-0}" = "1" ] && TARGETS+=( "${CAND_PATHS[$i]}" )
  done
  [ "${#TARGETS[@]}" -gt 0 ] || TARGETS=( "${CAND_PATHS[$CURSOR]}" )
}

# Typed fallback for terminals without cursor control (TERM=dumb). Reads a line
# of space-separated numbers, or 'c' for a custom path. Fills TARGETS.
select_typed() {
  printf ' %sInstall to which profile?%s\n' "$C_BOLD" "$C_RESET"
  local i
  for i in "${!CAND_PATHS[@]}"; do
    local suffix=""
    [ -n "${CAND_LABELS[$i]}" ] && suffix=" ${C_DIM}(${CAND_LABELS[$i]})${C_RESET}"
    printf '   %s%d)%s %s%s\n' "$C_DIM" "$((i + 1))" "$C_RESET" "${CAND_PATHS[$i]}" "$suffix"
  done
  printf '   %sc)%s custom path…\n' "$C_DIM" "$C_RESET"
  printf '\n %sSelect%s %s[Enter=default, e.g. 1 3, or c]%s: ' "$C_BOLD" "$C_RESET" "$C_DIM" "$C_RESET"

  local reply
  read -r reply || reply=""
  printf '\n'
  case "$reply" in
    "") TARGETS=( "${CAND_PATHS[0]}" ) ;;
    c|C)
      local custom
      printf ' %sCustom path%s: ' "$C_BOLD" "$C_RESET"
      read -r custom || custom=""
      printf '\n'
      [ -n "$custom" ] || { err_line "no path given"; exit 1; }
      TARGETS=( "$(expand_path "$custom")" )
      ;;
    *)
      local tok
      for tok in $reply; do
        case "$tok" in
          *[!0-9]*) warn_line "ignoring '$tok' (not a number)" ;;
          *)
            if [ "$tok" -ge 1 ] && [ "$tok" -le "${#CAND_PATHS[@]}" ]; then
              TARGETS+=( "${CAND_PATHS[$((tok - 1))]}" )
            else
              warn_line "ignoring '$tok' (out of range)"
            fi
            ;;
        esac
      done
      [ "${#TARGETS[@]}" -gt 0 ] || TARGETS=( "${CAND_PATHS[0]}" )
      ;;
  esac
}

# Fills the global TARGETS array with the directories to install into.
TARGETS=()
choose_targets() {
  if [ -n "$OPT_DIR" ]; then
    TARGETS=( "$(expand_path "$OPT_DIR")" )
    return 0
  fi
  if [ "$OPT_YES" -eq 1 ]; then
    TARGETS=( "$HOME/.claude" )
    return 0
  fi

  discover_candidates

  # Interactive needs a TTY on both ends. Arrow menu when the terminal supports
  # cursor moves; typed fallback for TERM=dumb; default when not interactive.
  if [ -t 0 ] && [ -t 1 ]; then
    if [ "${TERM:-dumb}" = "dumb" ]; then select_typed; else select_arrows; fi
  else
    TARGETS=( "${CAND_PATHS[0]}" )
  fi
}

# --- Settings patching (mirrors the npm CLI's safety contract) ---------------
print_manual() {
  local cmd="$1"
  printf '\n Add this to your settings.json, inside the top-level object:\n\n'
  printf '  "statusLine": {\n'
  printf '    "type": "command",\n'
  printf '    "command": "%s",\n' "$cmd"
  printf '    "refreshInterval": 1\n'
  printf '  }\n\n'
}

patch_settings() {
  local settings="$1" cmd="$2"

  if [ "$HAVE_JQ" -ne 1 ]; then
    warn_line "jq missing — can't patch $settings safely"
    print_manual "$cmd"
    return 0
  fi

  if [ ! -f "$settings" ]; then
    jq -n --arg c "$cmd" \
      '{statusLine:{type:"command",command:$c,refreshInterval:1}}' > "$settings"
    ok_line "settings → $settings (created)"
    return 0
  fi

  if ! jq empty "$settings" >/dev/null 2>&1; then
    err_line "invalid JSON in $settings — left untouched"
    print_manual "$cmd"
    return 0
  fi

  local existing
  existing=$(jq -r '.statusLine.command // empty' "$settings")
  if [ "$existing" = "$cmd" ]; then
    ok_line "settings → $settings (already configured)"
    return 0
  fi
  if [ -n "$existing" ] && [ "$OPT_FORCE" -ne 1 ]; then
    warn_line "a different statusLine exists in $settings — re-run with --force to replace"
    return 0
  fi

  cp "$settings" "$settings.bak"
  jq --arg c "$cmd" \
    '.statusLine={type:"command",command:$c,refreshInterval:1}' \
    "$settings" > "$settings.tmp" && mv "$settings.tmp" "$settings"
  local verb="added"; [ -n "$existing" ] && verb="replaced"
  ok_line "settings → $settings ($verb, backup → settings.json.bak)"
}

install_one() {
  local dir="$1"
  local script_path="$dir/tokenline.sh"
  local settings="$dir/settings.json"
  local cmd; cmd=$(statusline_command "$script_path")

  if [ "$OPT_DRYRUN" -eq 1 ]; then
    note_line "would copy  → $script_path"
    note_line "would patch → $settings"
    return 0
  fi

  spin_for 0.4 "installing into $dir"
  mkdir -p "$dir"
  cp "$TOKENLINE_SRC" "$script_path"
  chmod 755 "$script_path"
  ok_line "script → $script_path"
  patch_settings "$settings" "$cmd"
}

# --- Main --------------------------------------------------------------------
hero

# --print: keep the original copy-paste workflow, no writes.
if [ "$OPT_PRINT" -eq 1 ]; then
  cmd=$(statusline_command "$TOKENLINE_SRC")
  print_manual "$cmd"
  exit 0
fi

if ! check_deps; then
  printf '\n'
  warn_line "Missing dependencies above. On macOS: brew install bash jq."
  warn_line "Fix them, then re-run ./install.sh."
  exit 1
fi
printf '\n'

choose_targets

for t in "${TARGETS[@]}"; do
  install_one "$t"
done

if [ "$OPT_DRYRUN" -eq 1 ]; then
  printf '\n %s[dry-run] nothing was written.%s\n\n' "$C_DIM" "$C_RESET"
else
  printf '\n %s%sDone.%s Restart Claude Code to see the statusline.\n\n' "$C_BOLD" "$C_OK" "$C_RESET"
fi

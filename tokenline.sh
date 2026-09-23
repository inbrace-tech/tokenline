#!/usr/bin/env bash

# ==============================================================================
# tokenline — a cache-aware statusline for AI coding CLIs
#
# Cross-CLI (Claude Code, Antigravity) and cross-provider (Anthropic, Gemini).
# Renders: model · context · cache TTL (HOT/COLD) · per-turn token economics
# (read / write / new / output / eq / saving %) · 5h + 7d rate-limit pacing.
# Wired as Claude Code's subagentStatusLine, renders one row per subagent in
# the agent panel instead, each with its own cache countdown (section 9).
#
# Repo:     https://github.com/inbrace-tech/tokenline
# License:  MIT
# Requires: bash 4+, jq. Linux/WSL2 or macOS (brew install bash jq).
# ==============================================================================

# Pin C locale: a comma-decimal locale (e.g. pt_BR) makes awk/printf emit
# "46,2k" and reject dotted input. LC_ALL beats LC_NUMERIC, so set LC_ALL to
# stay deterministic even when the user exports LC_ALL. Output is ASCII/bytes.
export LC_ALL=C

# --- Install stamp ---
# The installer (npm `init`/`update`, or the release asset) rewrites these two
# lines in the copy it installs: the version it shipped and the exact command
# that updates this copy. Left empty here, so the repo copy never checks.
TOKENLINE_VERSION=""
TOKENLINE_UPDATE_CMD=""

# --- Colors & Formatting Constants ---
COLOR_GRAY=$'\033[38;5;244m'
COLOR_DARK_GRAY=$'\033[38;5;240m'
COLOR_CYAN=$'\033[38;5;51m'
COLOR_YELLOW=$'\033[38;5;226m'
COLOR_MAGENTA=$'\033[38;5;201m'
COLOR_ORANGE=$'\033[38;5;208m'
COLOR_RED=$'\033[38;5;196m'
COLOR_GREEN=$'\033[38;5;46m'
COLOR_RESET=$'\033[00m'
STYLE_BLINK=$'\033[1;5m'

# --- Dependency guard ---
# A statusline must never crash the host CLI's prompt. Without jq we cannot
# parse the input JSON, so emit a minimal, explicit hint instead of a blank
# line, and exit 0 (never signal an error code to the host).
if ! command -v jq >/dev/null 2>&1; then
  printf '%s[tokenline] jq not found — install jq to enable the statusline%s\n' \
    "$COLOR_GRAY" "$COLOR_RESET"
  exit 0
fi

# --- GNU vs BSD coreutils (Linux vs macOS) ---
# Probe behavior, not `uname`, so Homebrew coreutils is picked up automatically.
if date -d "@0" >/dev/null 2>&1; then _date_gnu=1; else _date_gnu=0; fi
if stat -c %Y . >/dev/null 2>&1; then _stat_gnu=1; else _stat_gnu=0; fi

epoch_from_iso() {
  # ISO-8601 -> epoch seconds; empty on failure (callers fall back to mtime).
  local iso="$1"
  if [ "$_date_gnu" -eq 1 ]; then
    date -d "$iso" +%s 2>/dev/null
  else
    # BSD date needs an explicit format and rejects fractional secs / 'Z'.
    # First 19 chars are always 'YYYY-MM-DDTHH:MM:SS'; transcripts are UTC.
    date -u -j -f "%Y-%m-%dT%H:%M:%S" "${iso:0:19}" +%s 2>/dev/null
  fi
}

epoch_from_reset() {
  # rate_limits.*.resets_at -> epoch seconds; empty on failure.
  # Claude Code sends Unix epoch seconds, which `date` cannot parse as a date
  # (GNU needs '@<n>', BSD needs '-r <n>'), so an integer is taken as-is and
  # never reaches `date`. Anything else is tried as ISO-8601.
  local value="$1"
  if [[ "$value" =~ ^[0-9]+$ ]]; then
    printf '%s' "$value"
  elif [ -n "$value" ]; then
    epoch_from_iso "$value"
  fi
}

file_mtime() {
  local f="$1"
  if [ "$_stat_gnu" -eq 1 ]; then
    stat -c %Y "$f" 2>/dev/null
  else
    stat -f %m "$f" 2>/dev/null
  fi
}

# --- Runtime state directory ---
# Per-turn timestamp / TTL are cached between the 1s refreshes. Prefer a
# per-user dir (0700) under XDG_RUNTIME_DIR: it avoids predictable, world-
# readable paths in shared /tmp (and the symlink/collision risks they carry),
# and is tmpfs cleared on logout — so no orphan-file cleanup is needed. Falls
# back to /tmp when XDG_RUNTIME_DIR is unset.
_runtime_dir="${XDG_RUNTIME_DIR:-/tmp}/tokenline-${UID:-$(id -u)}"
mkdir -p "$_runtime_dir" 2>/dev/null && chmod 700 "$_runtime_dir" 2>/dev/null
[ -d "$_runtime_dir" ] || _runtime_dir="/tmp"

# --- 1. Parse JSON Standard Input and Prepare State Variables ---
parse_and_prepare_paths() {
  # Single jq execution to parse all required fields into an array at once (reduces forks)
  mapfile -t _f < <(printf '%s' "$_input" | jq -r '
    (.model.display_name // ""),
    (.context_window.used_percentage // ""),
    (.context_window.context_window_size // ""),
    (.transcript_path // ""),
    (.session_id // ""),
    (.rate_limits.five_hour.used_percentage // ""),
    (.rate_limits.five_hour.resets_at // ""),
    (.rate_limits.seven_day.used_percentage // ""),
    (.rate_limits.seven_day.resets_at // ""),
    (.context_window.current_usage.input_tokens // 0),
    (.context_window.current_usage.output_tokens // 0),
    (.context_window.current_usage.cache_creation_input_tokens // 0),
    (.context_window.current_usage.cache_read_input_tokens // 0),
    (.model.id // "")' 2>/dev/null)

  # Malformed or empty stdin: jq emits nothing, so the array is empty. Degrade to
  # a silent no-op render rather than leaking parse errors or rendering garbage —
  # the host CLI always sends valid JSON, so this path only guards against abuse.
  [ "${#_f[@]}" -eq 0 ] && exit 0

  model="${_f[0]}"
  used_pct="${_f[1]}"
  tokens_limit="${_f[2]}"
  transcript_path="${_f[3]}"
  session_id="${_f[4]}"
  rl_5h_pct="${_f[5]}"
  rl_5h_reset=$(epoch_from_reset "${_f[6]}")
  rl_7d_pct="${_f[7]}"
  rl_7d_reset=$(epoch_from_reset "${_f[8]}")
  cur_input="${_f[9]}"
  cur_output="${_f[10]}"
  cur_cwrite="${_f[11]}"
  cur_cread="${_f[12]}"
  model_id="${_f[13]}"

  # Computed: total input-only tokens used in the current context window
  tokens_used=$((cur_input + cur_cwrite + cur_cread))

  # If Claude Code sends a subagent transcript, resolve it to the parent session instead
  if [[ "$transcript_path" == */subagents/* ]]; then
    transcript_path="$(dirname "$(dirname "$transcript_path")").jsonl"
  fi

  # Detect active CLI Client
  cli_client="claude-code"
  if [[ "$transcript_path" == *"/antigravity"* ]] || [[ "$transcript_path" == *"/antigravity-cli"* ]]; then
    cli_client="antigravity"
  fi

  # Dynamic Path Correction: Translate /antigravity/ to /antigravity-cli/ if client is Antigravity CLI
  if [ "$cli_client" = "antigravity" ] && [[ "$transcript_path" == *"/antigravity/"* ]]; then
    transcript_path="${transcript_path/\/antigravity\//\/antigravity-cli\/}"
  fi

  # Detect if Gemini model is active
  is_gemini=false
  if [[ "$model" =~ [Gg]emini ]]; then
    is_gemini=true
  fi

  # Cache hits bill at 0.1x base input, except Claude Fable 5.1 / Mythos 5.1 (0.025x)
  # and Claude Opus 5.5 (0.05x). Match the API id (claude-fable-5-1[1m]) or the
  # display name (Fable 5.1) so either field alone is enough. Pin the full version:
  # claude-opus-5 must stay 0.1x, and a later version's price is confirmed, not guessed.
  claude_read_mult="0.1"
  local fable_re='(fable|mythos)[- ]5[-.]1([^0-9]|$)'
  local opus_re='opus[- ]5[-.]5([^0-9]|$)'
  if [[ "${model_id,,}" =~ $fable_re ]] || [[ "${model,,}" =~ $fable_re ]]; then
    claude_read_mult="0.025"
  elif [[ "${model_id,,}" =~ $opus_re ]] || [[ "${model,,}" =~ $opus_re ]]; then
    claude_read_mult="0.05"
  fi

  # Get the current epoch timestamp once to be reused across all calculations
  now=$(date +%s)
}

# --- 2. Formatting Helpers ---
fmt_k() {
  # Formats token counts nicely (e.g. 1500000 -> 1.5M, 25600 -> 25.6k).
  # Value is passed via -v (defaulted to 0) so a missing or non-numeric arg
  # can never break awk's program syntax.
  awk -v v="${1:-0}" 'BEGIN {
    if (v >= 1000000) printf "%.1fM", v/1000000
    else if (v >= 1000) printf "%.1fk", v/1000
    else printf "%d", v }'
}

fmt_eta() {
  # Formats raw seconds remaining into a human readable string (e.g., 3600 -> 1h, 90 -> 1m30s)
  local secs=$1
  if [ "$secs" -le 0 ]; then
    printf 'now'
  elif [ "$secs" -lt 3600 ]; then
    printf '%dm' $((secs / 60))
  elif [ "$secs" -lt 86400 ]; then
    local h=$((secs / 3600)) m=$(((secs % 3600) / 60))
    if [ "$m" -gt 0 ]; then printf '%dh%dm' "$h" "$m"; else printf '%dh' "$h"; fi
  else
    local d=$((secs / 86400)) h=$(((secs % 86400) / 3600))
    if [ "$h" -gt 0 ]; then printf '%dd%dh' "$d" "$h"; else printf '%dd' "$d"; fi
  fi
}

# --- 3. Cache Timer Logic ---
compute_cache_timer() {
  cache_info=""
  local ts_cache_file="$_runtime_dir/lastts-${session_id:-default}"
  local ttl_cache_file="$_runtime_dir/ttl-${session_id:-default}"
  local tokens_cache_file="$_runtime_dir/lasttokens-${session_id:-default}"

  # Update the cached turn timestamp if token usage changed (signaling a new turn)
  local last_tokens
  last_tokens=$(cat "$tokens_cache_file" 2>/dev/null)
  if [ "$tokens_used" -ne "${last_tokens:-0}" ] 2>/dev/null; then
    printf '%s\n' "$now" > "$ts_cache_file" 2>/dev/null
    printf '%s\n' "$tokens_used" > "$tokens_cache_file" 2>/dev/null
  fi

  local last_ts=""
  local e5m=0
  local e1h=0

  # Read the last turn's timestamp directly from the transcript file (if readable)
  if [ -n "$transcript_path" ] && [ -f "$transcript_path" ] && [ -r "$transcript_path" ]; then
    # General Query: Matches .type=="assistant" (Claude Code) or .type=="PLANNER_RESPONSE" (Antigravity CLI)
    # Extracts the dynamic timestamp using (.timestamp // .created_at) and caching flags
    IFS=$'\t' read -r iso e5m e1h < <(
      tail -n 200 "$transcript_path" 2>/dev/null \
      | jq -r 'select(.type=="assistant" or .type=="PLANNER_RESPONSE")
               | [
                   (.timestamp // .created_at),
                   (.message.usage.cache_creation.ephemeral_5m_input_tokens // 0),
                   (.message.usage.cache_creation.ephemeral_1h_input_tokens // 0)
                 ]
               | @tsv' 2>/dev/null \
      | tail -n 1
    )
    if [ -n "$iso" ]; then
      last_ts=$(epoch_from_iso "$iso")
    fi
    # Mtime fallback if parsing is unsuccessful
    [ -z "$last_ts" ] && last_ts=$(file_mtime "$transcript_path")
  fi

  # Fallback to local session caching file if transcript read is unavailable or cached timestamp is newer
  local cached_ts
  cached_ts=$(cat "$ts_cache_file" 2>/dev/null)
  if [ -n "$cached_ts" ]; then
    if [ -z "$last_ts" ] || [ "$cached_ts" -gt "$last_ts" ] 2>/dev/null; then
      last_ts="$cached_ts"
    fi
  fi

  # Ensure there is always a valid timestamp to fall back to
  if [ -z "$last_ts" ]; then
    last_ts="$now"
    printf '%s\n' "$last_ts" > "$ts_cache_file" 2>/dev/null
  fi

  # Determine cache TTL window (Gemini has 5m default; Anthropic determines it via tokens fields)
  local ttl
  if [ "$is_gemini" = true ]; then
    ttl=300
    ttl_label="5m"
  else
    if [ "${e1h:-0}" -gt 0 ]; then
      ttl=3600
      ttl_label="1h"
    elif [ "${e5m:-0}" -gt 0 ]; then
      ttl=300
      ttl_label="5m"
    else
      # Retrieve previously determined session TTL if latest turn did not populate these fields (e.g. hit only)
      ttl=$(awk '{print $1}' "$ttl_cache_file" 2>/dev/null)
      ttl_label=$(awk '{print $2}' "$ttl_cache_file" 2>/dev/null)
      [ -z "$ttl" ] && { ttl=300; ttl_label="5m"; }
    fi
  fi
  printf '%s %s\n' "$ttl" "$ttl_label" > "$ttl_cache_file" 2>/dev/null

  # Calculate remaining time and format the cache information display
  local elapsed
  local remaining
  elapsed=$((now - last_ts))
  remaining=$((ttl - elapsed))
  if [ "$remaining" -gt 0 ]; then
    local mins=$((remaining / 60))
    local secs=$((remaining % 60))
    local pct10=$((remaining * 10 / ttl))
    local fg=""
    
    # Custom HSL-based gradient colors for remaining time
    if   [ "$pct10" -ge 8 ]; then fg="$COLOR_GREEN"
    elif [ "$pct10" -ge 6 ]; then fg=$'\033[38;5;154m'
    elif [ "$pct10" -ge 4 ]; then fg="$COLOR_YELLOW"
    elif [ "$pct10" -ge 2 ]; then fg="$COLOR_ORANGE"
    elif [ "$pct10" -ge 1 ]; then fg="$COLOR_RED"
    else                          fg="${COLOR_RED}${STYLE_BLINK}" # Blinking red if < 10%
    fi

    local suffix="HOT"
    [ "$pct10" -lt 1 ] && suffix="HOT !"
    cache_info=$(printf '%s[%s] cache: %s%d:%02d %s%s' "$COLOR_GRAY" "$ttl_label" "$fg" "$mins" "$secs" "$suffix" "$COLOR_RESET")
  else
    cache_info=$(printf '%s[%s] cache: \033[1;5m%sCOLD%s' "$COLOR_GRAY" "$ttl_label" "$COLOR_RED" "$COLOR_RESET")
  fi
}

# --- 4. Context Window Computation ---
compute_context_info() {
  ctx_info=""
  if [ -n "$used_pct" ]; then
    local pct
    local ctx_color
    pct=$(printf '%.0f' "$used_pct")
    if   [ "$pct" -ge 80 ]; then ctx_color=$'\033[01;31m' # Bold Red
    elif [ "$pct" -ge 50 ]; then ctx_color=$'\033[01;33m' # Bold Yellow
    else                         ctx_color=$'\033[01;32m' # Bold Green
    fi

    if [ "${tokens_used:-0}" -gt 0 ] && [ "${tokens_limit:-0}" -gt 0 ]; then
      ctx_info=$(printf '%sctx: %s%s%s/%s (%s%%)%s' \
        "$COLOR_GRAY" "$COLOR_RESET" "$ctx_color" "$(fmt_k "$tokens_used")" "$(fmt_k "$tokens_limit")" "$pct" "$COLOR_RESET")
    else
      ctx_info=$(printf '%sctx: %s%s%s%%%s' "$COLOR_GRAY" "$COLOR_RESET" "$ctx_color" "$pct" "$COLOR_RESET")
    fi
  fi
}

# --- 5. Rate Limit Windows Heuristics and Bars ---
rl_color_for_pct() {
  local pct=$1
  if   [ "$pct" -ge 90 ]; then echo "${COLOR_RED}${STYLE_BLINK}" # Blinking red
  elif [ "$pct" -ge 75 ]; then echo "$COLOR_RED"
  elif [ "$pct" -ge 50 ]; then echo "$COLOR_ORANGE"
  elif [ "$pct" -ge 25 ]; then echo "$COLOR_YELLOW"
  else                         echo "$COLOR_GREEN"
  fi
}

rl_bar() {
  local pct=$1
  local color=$2
  local width=10
  local filled=$((pct * width / 100))
  [ "$filled" -lt 0 ] && filled=0
  [ "$filled" -gt "$width" ] && filled=$width
  
  local empty=$((width - filled))
  local bar="$color"
  local i
  for ((i=0; i<filled; i++)); do bar+="█"; done
  bar+="$COLOR_DARK_GRAY"
  for ((i=0; i<empty; i++)); do bar+="░"; done
  bar+="$COLOR_RESET"
  printf '%s' "$bar"
}

rl_segment() {
  local label=$1
  local pct=$2
  local reset_at=$3
  local window_secs=$4
  local now_ts=$5
  [ -z "$pct" ] && return
  local pct_int; pct_int=$(printf '%.0f' "$pct")

  local eta_secs=0
  if [ -n "$reset_at" ] && [ "$reset_at" != "null" ]; then
    eta_secs=$((reset_at - now_ts))
    [ "$eta_secs" -lt 0 ] && eta_secs=0
  fi

  # Pace heuristic: check if we are burning the API limits faster than scheduling
  local pace_marker=""
  if [ "$pct_int" -ge 20 ] && [ "$eta_secs" -gt 0 ] && [ "$window_secs" -gt 0 ]; then
    local elapsed_secs=$((window_secs - eta_secs))
    [ "$elapsed_secs" -lt 0 ] && elapsed_secs=0
    local min_elapsed=$((window_secs / 10))
    if [ "$elapsed_secs" -ge "$min_elapsed" ]; then
      local fast
      fast=$(awk "BEGIN{
        pace = ($pct_int * $window_secs) / ($elapsed_secs * 100)
        if (pace >= 1.5) print 2
        else if (pace >= 1.25) print 1
        else print 0
      }")
      if   [ "$fast" = "2" ]; then pace_marker=$(printf '%s!!%s' "${COLOR_RED}${STYLE_BLINK}" "$COLOR_RESET")
      elif [ "$fast" = "1" ]; then pace_marker=$(printf '%s!%s' "$COLOR_ORANGE" "$COLOR_RESET")
      fi
    fi
  fi

  local color; color=$(rl_color_for_pct "$pct_int")
  local bar; bar=$(rl_bar "$pct_int" "$color")
  local reset_str=""
  [ "$eta_secs" -gt 0 ] && reset_str=$(printf ' (%s to reset)' "$(fmt_eta "$eta_secs")")

  printf '%s%s: %s%s %s%d%%%s%s%s' \
    "$COLOR_GRAY" "$label" "$COLOR_RESET" \
    "$bar" \
    "$color" "$pct_int" "$COLOR_RESET" \
    "$reset_str" \
    "${pace_marker:+ $pace_marker}"
}

compute_rate_limits() {
  rl_5h_info=""
  rl_7d_info=""
  # Gemini models do not have five_hour / seven_day rate limits; only compute for non-Gemini (Anthropic)
  if [ "$is_gemini" = false ]; then
    [ -n "$rl_5h_pct" ] && rl_5h_info=$(rl_segment "5h" "$rl_5h_pct" "$rl_5h_reset" 18000  "$now")
    [ -n "$rl_7d_pct" ] && rl_7d_info=$(rl_segment "7d" "$rl_7d_pct" "$rl_7d_reset" 604800 "$now")
  fi
}

# --- 6. Last-Turn Token Economics Breakdown & Equivalents ---
compute_turn_breakdown() {
  last_info=""
  if [ "$cur_cread" -gt 0 ] || [ "$cur_cwrite" -gt 0 ] || [ "$cur_input" -gt 0 ] || [ "$cur_output" -gt 0 ]; then
    local read_mult
    local write_mult
    local input_mult
    local output_mult
    
    # Multipliers based on active provider (Gemini equivalents vs Anthropic Claude)
    if [ "$is_gemini" = true ]; then
      read_mult="0.25"
      write_mult="1.0"
      input_mult="1"
      output_mult="4"
    else
      read_mult="$claude_read_mult"
      write_mult="1.25"
      [ "${ttl_label:-5m}" = "1h" ] && write_mult="2"
      input_mult="1"
      output_mult="5"
    fi

    # Equivalent tokens formula
    local eq_tokens
    local uncached_eq
    eq_tokens=$(awk "BEGIN { printf \"%d\", ($cur_cread * $read_mult) + ($cur_cwrite * $write_mult) + ($cur_input * $input_mult) + ($cur_output * $output_mult) }")
    uncached_eq=$(awk "BEGIN { printf \"%d\", ($cur_cread + $cur_cwrite + $cur_input) * $input_mult + ($cur_output * $output_mult) }")
    
    local saving_pct=0
    [ "$uncached_eq" -gt 0 ] && saving_pct=$(awk "BEGIN { printf \"%d\", 100 * ($uncached_eq - $eq_tokens) / $uncached_eq }")
    
    local read_lbl="${read_mult}x"
    local write_lbl="${write_mult}x"
    local input_lbl="${input_mult}x"
    local output_lbl="${output_mult}x"

    local save_color
    if   [ "$saving_pct" -ge 90 ]; then save_color="$COLOR_GREEN"
    elif [ "$saving_pct" -ge 70 ]; then save_color="$COLOR_YELLOW"
    elif [ "$saving_pct" -ge 50 ]; then save_color="$COLOR_ORANGE"
    else                                save_color="$COLOR_RED"
    fi

    # Format the complete per-turn breakdown line
    last_info=$(printf '%sread(%s): %s%s%s %swrite(%s): %s%s%s %snew(%s): %s%s%s %soutput(%s): %s%s%s %seq: %s%s%s %ssaving: %s%d%%%s' \
      "$COLOR_GRAY" "$read_lbl" "$COLOR_CYAN" "$(fmt_k "$cur_cread")" "$COLOR_RESET" \
      "$COLOR_GRAY" "$write_lbl" "$COLOR_YELLOW" "$(fmt_k "$cur_cwrite")" "$COLOR_RESET" \
      "$COLOR_GRAY" "$input_lbl" "$COLOR_MAGENTA" "$(fmt_k "$cur_input")" "$COLOR_RESET" \
      "$COLOR_GRAY" "$output_lbl" "$COLOR_GREEN" "$(fmt_k "$cur_output")" "$COLOR_RESET" \
      "$COLOR_GRAY" "$COLOR_ORANGE" "$(fmt_k "$eq_tokens")" "$COLOR_RESET" \
      "$COLOR_GRAY" "$save_color" "$saving_pct" "$COLOR_RESET")
  fi
}

# --- 7. Update Notice ---
version_gt() {
  # 0 when x.y.z $1 is newer than x.y.z $2 (both pre-validated). 10# keeps a
  # leading zero from being read as octal.
  local -a a b
  IFS=. read -ra a <<< "$1"
  IFS=. read -ra b <<< "$2"
  local i
  for i in 0 1 2; do
    (( 10#${a[i]} > 10#${b[i]} )) && return 0
    (( 10#${a[i]} < 10#${b[i]} )) && return 1
  done
  return 1
}

compute_update_notice() {
  # Installed (stamped) copies only; the repo copy has no version and never checks.
  # A detached curl stores the latest published version in the private runtime
  # dir, and the render path only reads that file. It runs when a session that
  # hasn't checked yet finds the last check 1h+ old (so a new release shows up
  # when you open a new session), and at least every 6h in a long session.
  # Nothing from the session is sent, and nothing downloaded is ever executed.
  # Opt out with TOKENLINE_NO_UPDATE_CHECK=1 (DO_NOT_TRACK=1 is honored too).
  update_info=""
  local semver='^[0-9]+\.[0-9]+\.[0-9]+$'
  [[ "$TOKENLINE_VERSION" =~ $semver ]] || return 0
  [ "${TOKENLINE_NO_UPDATE_CHECK:-}" = "1" ] && return 0
  [ "${DO_NOT_TRACK:-}" = "1" ] && return 0
  # Only a private dir we own: never create or follow files in shared /tmp.
  [ "$_runtime_dir" != "/tmp" ] && [ -O "$_runtime_dir" ] || return 0

  local latest_file="$_runtime_dir/latest-version"
  local session_file="$_runtime_dir/latest-version.session"
  local checked_at checked_by="" due=false age
  checked_at=$(file_mtime "$latest_file")
  read -r checked_by 2>/dev/null < "$session_file"
  if [ -z "$checked_at" ]; then
    due=true
  else
    age=$((now - checked_at))
    if [ "$age" -ge 21600 ]; then
      due=true
    elif [ "$age" -ge 3600 ] && [ -n "$session_id" ] && [ "$session_id" != "$checked_by" ]; then
      due=true
    fi
  fi
  if [ "$due" = true ] && command -v curl >/dev/null 2>&1; then
    # Mark the check first (time and session), so the refreshes during the fetch
    # don't start another one.
    touch "$latest_file" 2>/dev/null
    printf '%s\n' "$session_id" 2>/dev/null > "$session_file"
    (
      v=$(curl -fsS --max-time 5 https://registry.npmjs.org/@inbrace-tech/tokenline/latest \
        | jq -r '.version // empty')
      [[ "$v" =~ $semver ]] && printf '%s\n' "$v" > "$latest_file.tmp" \
        && mv -f "$latest_file.tmp" "$latest_file"
    ) < /dev/null > /dev/null 2>&1 &
    disown 2>/dev/null
  fi

  local latest=""
  read -r latest 2>/dev/null < "$latest_file"
  [[ "$latest" =~ $semver ]] || return 0
  version_gt "$latest" "$TOKENLINE_VERSION" || return 0
  # In Claude Code, a leading "!" runs the command from the prompt, so the
  # update never needs another terminal.
  local run_hint=""
  [ "$cli_client" = "claude-code" ] && run_hint="! "
  update_info=$(printf '%s↑ tokenline %s available · update: %s%s%s' \
    "$COLOR_DARK_GRAY" "$latest" "$run_hint" "$TOKENLINE_UPDATE_CMD" "$COLOR_RESET")
}

# --- 8. Compose and Render Output ---
render_statusline() {
  # Line 1: client/model | ctx | cache TTL
  local display_header=""
  if [ "$cli_client" = "antigravity" ]; then
    # Custom styled brand display for Antigravity CLI users
    display_header="${COLOR_CYAN}🌌 Antigravity${COLOR_RESET} (${model})"
  else
    # Default display for Claude Code
    display_header="${model}"
  fi

  local line1="$display_header"
  [ -n "$ctx_info" ]   && line1="$line1 | $ctx_info"
  [ -n "$cache_info" ] && line1="$line1 | $cache_info"
  printf "%s\n" "$line1"

  # Line 2: breakdown of cache / raw / saving (only shown when activity happens)
  [ -n "$last_info" ] && printf "%s\n" "$last_info"

  # Line 3: API rate limits and progress bars (Only shown for Claude models where limits exist)
  if [ "$is_gemini" = false ] && { [ -n "$rl_5h_info" ] || [ -n "$rl_7d_info" ]; }; then
    local sep_line="${COLOR_DARK_GRAY}──────────────────────────────${COLOR_RESET}"
    printf "%s\n" "$sep_line"
    local line_rl=""
    [ -n "$rl_5h_info" ] && line_rl="$rl_5h_info"
    [ -n "$rl_7d_info" ] && line_rl="${line_rl:+$line_rl  }$rl_7d_info"
    printf "%s\n" "$line_rl"
  fi

  # Last line: update notice (stamped installs with a newer version published)
  if [ -n "$update_info" ]; then
    printf "%s\n" "$update_info"
  fi
}

# --- 9. Subagent Rows (subagentStatusLine) ---
# Wired as `subagentStatusLine`, Claude Code runs this same script for its agent
# panel: stdin is then {session_id, transcript_path, columns, tasks: [...]} and
# stdout is one {"id","content"} JSON line per row. Each row carries that
# subagent's own prompt-cache countdown, read from its own transcript.
# Subagent requests write the 5-minute cache, so a subagent that waits on a long
# tool call (a test suite, a build) or on a human answer goes COLD quietly, and
# its next turn pays a full cache write instead of a cache read.

_sa_sep=$'\x1f'
# Bump when scan_subagent_transcript's output changes (see load_subagent_state).
_sa_scan_version=3

# LC_ALL=C (top of file) makes ${#s} count bytes, so 'é' or '…' would throw the
# columns off. Width math switches to a UTF-8 locale when one exists; without
# one it falls back to bytes, which only over-counts (rows get shorter, never
# wider than the panel).
_utf8_locale=""
probe_utf8_locale() {
  local loc
  for loc in C.UTF-8 C.utf8 en_US.UTF-8 en_US.utf8 UTF-8; do
    if { _utf8_len_probe "$loc"; } 2>/dev/null; then
      _utf8_locale="$loc"
      return
    fi
  done
}
_utf8_len_probe() {
  local LC_ALL="$1" s='é'
  [ "${#s}" -eq 1 ]
}

strip_ansi() {
  # SGR sequences only: the only escapes this script ever emits.
  local s="$1" re=$'\033''\[[0-9;]*m'
  while [[ "$s" =~ $re ]]; do s="${s/"${BASH_REMATCH[0]}"/}"; done
  printf '%s' "$s"
}

vis_len() {
  # Visible width of a (possibly colored) string, in characters.
  local plain; plain=$(strip_ansi "$1")
  { local LC_ALL="${_utf8_locale:-C}"; } 2>/dev/null
  printf '%s' "${#plain}"
}

fit() {
  # Plain text cut to $2 characters, with a trailing ellipsis when cut.
  local s="$1" n="$2"
  { local LC_ALL="${_utf8_locale:-C}"; } 2>/dev/null
  if [ "$n" -le 0 ]; then return; fi
  if [ "${#s}" -le "$n" ]; then printf '%s' "$s"; return; fi
  if [ -n "$_utf8_locale" ]; then
    printf '%s…' "${s:0:n-1}"
  else
    printf '%s' "${s:0:n}"
  fi
}

pad() {
  # Right-pads a colored string to $2 visible characters.
  local s="$1" w="$2" len
  len=$(vis_len "$s")
  printf '%s%*s' "$s" $((w > len ? w - len : 0)) ''
}

fmt_elapsed() {
  local s=${1:-0}
  if   [ "$s" -lt 60 ];   then printf '%ds' "$s"
  elif [ "$s" -lt 3600 ]; then printf '%dm%02ds' $((s / 60)) $((s % 60))
  else                         printf '%dh%02dm' $((s / 3600)) $(((s % 3600) / 60))
  fi
}

# Scans one subagent transcript for: the last assistant turn's timestamp (the
# moment its cache was last touched), the TTL its cache writes used, and its
# last tool call — "waiting" when that call has no result yet. Lines are parsed
# one by one with fromjson?, so the half-written line at the end of a live
# transcript is skipped instead of failing the whole scan.
scan_subagent_transcript() {
  tail -n 400 "$1" 2>/dev/null | jq -Rrn '
    [inputs | fromjson? | select(type == "object")] as $all
    | [$all[] | select(.type == "assistant")] as $a
    | ([$a[] | .message.usage.cache_creation // {}
        | if (.ephemeral_1h_input_tokens // 0) > 0 then "1h"
          elif (.ephemeral_5m_input_tokens // 0) > 0 then "5m"
          else empty end] | last // "") as $ttl
    | ([$a[] | .message.content[]? | select(.type == "tool_use")] | last) as $call
    | ($call.name // "") as $tool
    | ([$all[] | select(.type == "assistant" or .type == "user")]) as $turns
    | ($turns | last) as $tail
    | (if $tail.type == "assistant"
          and ([$tail.message.content[]? | select(.type == "tool_use")] | length) > 0
       then "waiting"
       # A background call answers at once ("running in background"); the
       # subagent may say a line, then idles until the job reports. Until a new
       # user entry that is not a tool result (the job notification) arrives,
       # it is still waiting — just not inside a call.
       elif ($call.input.run_in_background == true)
          and ([$turns | to_entries[]
                | select(.value.type == "assistant"
                    and ([.value.message.content[]? | select(.type == "tool_use")] | length) > 0)
                | .key] | last) as $at
          | ($turns[($at + 1):]
             | all(.type == "assistant"
                   or ([.message.content[]? | select(.type == "tool_result")] | length) > 0))
       then "waiting-bg"
       else "last" end) as $mode
    | [($a | last | .timestamp // ""), $ttl, $tool, $mode]
    | map(tostring | gsub("[[:cntrl:]]"; " "))
    | join("\u001f")' 2>/dev/null
}

# Sets sa_last_ts / sa_ttl_label / sa_tool / sa_mode for one subagent. The scan
# result is kept per subagent in the private runtime dir, keyed on the
# transcript's mtime, so an unchanged transcript costs one stat per refresh
# instead of a tail + jq.
load_subagent_state() {
  local aid="$1" dir="$2"
  sa_last_ts="" sa_ttl_label="" sa_tool="" sa_mode=""

  local transcript="" candidate
  if [ -f "$dir/agent-$aid.jsonl" ]; then
    transcript="$dir/agent-$aid.jsonl"
  else
    # Workflow-spawned agents live one level down: subagents/workflows/<run>/.
    for candidate in "$dir"/workflows/*/"agent-$aid.jsonl"; do
      [ -f "$candidate" ] && { transcript="$candidate"; break; }
    done
  fi
  [ -n "$transcript" ] && [ -r "$transcript" ] || return 0

  # mtime alone has 1s resolution, so a line appended within the second of the
  # last scan would be missed: key on mtime and size together (one stat call).
  local mtime
  if [ "$_stat_gnu" -eq 1 ]; then
    mtime=$(stat -c '%Y:%s' "$transcript" 2>/dev/null)
  else
    mtime=$(stat -f '%m:%z' "$transcript" 2>/dev/null)
  fi
  local state_file=""
  if [ "$_runtime_private" = true ] && [ -n "$sa_session_key" ]; then
    # The version tag retires every cached scan when the scan itself changes,
    # so an updated script never serves a result the old one computed.
    state_file="$_runtime_dir/sa$_sa_scan_version-$sa_session_key-$aid"
  fi

  local s_mtime="" s_ts="" s_ttl="" s_tool="" s_mode=""
  if [ -n "$state_file" ] && [ -f "$state_file" ]; then
    IFS="$_sa_sep" read -r s_mtime s_ts s_ttl s_tool s_mode < "$state_file"
  fi

  if [ -n "$mtime" ] && [ "$mtime" = "$s_mtime" ]; then
    sa_last_ts="$s_ts" sa_ttl_label="$s_ttl" sa_tool="$s_tool" sa_mode="$s_mode"
    return 0
  fi

  local iso ttl tool mode
  IFS="$_sa_sep" read -r iso ttl tool mode < <(scan_subagent_transcript "$transcript")
  [ -n "$iso" ] && sa_last_ts=$(epoch_from_iso "$iso")
  # A turn that only read the cache reports no write TTL: keep the last known one.
  sa_ttl_label="${ttl:-$s_ttl}"
  sa_tool="$tool"
  sa_mode="$mode"

  if [ -n "$state_file" ]; then
    printf '%s\n' "$mtime$_sa_sep$sa_last_ts$_sa_sep$sa_ttl_label$_sa_sep$sa_tool$_sa_sep$sa_mode" \
      > "$state_file" 2>/dev/null
  fi
}

subagent_cache_segment() {
  # Same wording and gradient as the main line's cache segment. A finished
  # subagent's countdown still matters (it can be resumed), but it never
  # blinks: the alarm is reserved for a running subagent going cold.
  local status="$1"
  if [ -z "$sa_last_ts" ]; then
    printf '%scache: --%s' "$COLOR_DARK_GRAY" "$COLOR_RESET"
    return
  fi
  local label="${sa_ttl_label:-5m}" ttl=300
  [ "$label" = "1h" ] && ttl=3600
  local remaining=$((ttl - (now - sa_last_ts)))
  local active=false
  [ "$status" = "running" ] && active=true

  if [ "$remaining" -gt 0 ]; then
    local pct10=$((remaining * 10 / ttl)) fg
    if   [ "$pct10" -ge 8 ]; then fg="$COLOR_GREEN"
    elif [ "$pct10" -ge 6 ]; then fg=$'\033[38;5;154m'
    elif [ "$pct10" -ge 4 ]; then fg="$COLOR_YELLOW"
    elif [ "$pct10" -ge 2 ]; then fg="$COLOR_ORANGE"
    elif [ "$pct10" -ge 1 ] || [ "$active" = false ]; then fg="$COLOR_RED"
    else fg="${COLOR_RED}${STYLE_BLINK}"
    fi
    printf '%s[%s] cache: %s%d:%02d HOT%s' "$COLOR_GRAY" "$label" "$fg" \
      $((remaining / 60)) $((remaining % 60)) "$COLOR_RESET"
  elif [ "$active" = true ]; then
    printf '%s[%s] cache: %s%sCOLD%s' "$COLOR_GRAY" "$label" "$STYLE_BLINK" "$COLOR_RED" "$COLOR_RESET"
  else
    printf '%s[%s] cache: cold%s' "$COLOR_DARK_GRAY" "$label" "$COLOR_RESET"
  fi
}

short_model() {
  # claude-haiku-4-5-20251001 -> haiku 4.5, claude-opus-5-5[1m] -> opus 5.5,
  # us.anthropic.claude-sonnet-5 -> sonnet 5. Anything else is shown as sent.
  local m="${1##*claude-}"
  m="${m%%\[*}"
  [[ "$m" =~ ^(.*)-[0-9]{8}$ ]] && m="${BASH_REMATCH[1]}"
  if   [[ "$m" =~ ^([a-z]+)-([0-9]+)-([0-9]+)$ ]]; then m="${BASH_REMATCH[1]} ${BASH_REMATCH[2]}.${BASH_REMATCH[3]}"
  elif [[ "$m" =~ ^([a-z]+)-([0-9]+)$ ]];          then m="${BASH_REMATCH[1]} ${BASH_REMATCH[2]}"
  fi
  printf '%s' "$m"
}

status_glyph() {
  case "$1" in
    running)          printf '%s●%s' $'\033[38;5;39m' "$COLOR_RESET" ;;
    completed)        printf '%s✓%s' "$COLOR_GREEN" "$COLOR_RESET" ;;
    failed|error)     printf '%s✗%s' "$COLOR_RED" "$COLOR_RESET" ;;
    stopped|killed)   printf '%s■%s' "$COLOR_GRAY" "$COLOR_RESET" ;;
    *)                printf '%s·%s' "$COLOR_GRAY" "$COLOR_RESET" ;;
  esac
}

render_subagent_rows() {
  # $1: the payload's jq extraction (header line, then one line per task).
  local header rows=()
  { IFS= read -r header; mapfile -t rows; } <<< "$1"

  local session_id_in parent_transcript columns
  IFS="$_sa_sep" read -r _ session_id_in parent_transcript columns <<< "$header"
  [[ "$columns" =~ ^[0-9]+$ ]] || columns="${COLUMNS:-100}"
  [[ "$columns" =~ ^[0-9]+$ ]] || columns=100

  # Ids end up in file names: accept only a conservative alphabet.
  local safe='^[A-Za-z0-9_-]+$'
  sa_session_key=""
  [[ "$session_id_in" =~ $safe ]] && sa_session_key="$session_id_in"
  local subagents_dir=""
  [ -n "$parent_transcript" ] && subagents_dir="${parent_transcript%.jsonl}/subagents"

  _runtime_private=false
  [ "$_runtime_dir" != "/tmp" ] && [ -O "$_runtime_dir" ] && _runtime_private=true

  now=$(date +%s)
  probe_utf8_locale

  # Pass 1: build every row's segments, tracking each column's widest cell so
  # the rows line up under each other.
  local -a ids types glyphs models efforts elapsed ctx cache activity descs
  local w_type=0 w_model=0 w_effort=0 w_elapsed=0 w_ctx=0 w_cache=0 w_act=0
  local line id name type status desc start_ms tokens window model effort aid
  for line in "${rows[@]}"; do
    IFS="$_sa_sep" read -r id name type status desc start_ms tokens window model effort <<< "$line"
    [ -z "$id" ] && continue

    aid="${id#agent-}"
    sa_last_ts="" sa_ttl_label="" sa_tool="" sa_mode=""
    if [[ "$aid" =~ $safe ]] && [ -n "$subagents_dir" ]; then
      load_subagent_state "$aid" "$subagents_dir"
    fi
    # Claude Code reports a subagent idling on its own background job as
    # "completed": its turn ended. It resumes when the job reports, so its
    # cache still matters — show it as running (activity, blinking COLD).
    [ "$sa_mode" = "waiting-bg" ] && status="running"

    local t="${type:-$name}"
    t=$(fit "${t:-agent}" 24)

    # A finished subagent's clock stops at its last turn, not at "now".
    local el="" until="$now"
    [ "$status" != "running" ] && [ -n "$sa_last_ts" ] && until="$sa_last_ts"
    if [[ "$start_ms" =~ ^[0-9]+$ ]] && [ "$start_ms" -gt 0 ]; then
      local secs=$((until - start_ms / 1000))
      [ "$secs" -lt 0 ] && secs=0
      el=$(printf '%s%s%s' "$COLOR_GRAY" "$(fmt_elapsed "$secs")" "$COLOR_RESET")
    fi

    local cx=""
    if [[ "$tokens" =~ ^[0-9]+$ ]] && [ "$tokens" -gt 0 ]; then
      if [[ "$window" =~ ^[0-9]+$ ]] && [ "$window" -gt 0 ]; then
        local pct=$((tokens * 100 / window)) cc=$'\033[01;32m'
        if   [ "$pct" -ge 80 ]; then cc=$'\033[01;31m'
        elif [ "$pct" -ge 50 ]; then cc=$'\033[01;33m'
        fi
        cx=$(printf '%sctx: %s%s (%d%%)%s' "$COLOR_GRAY" "$cc" "$(fmt_k "$tokens")" "$pct" "$COLOR_RESET")
      else
        cx=$(printf '%sctx: %s%s' "$COLOR_GRAY" "$(fmt_k "$tokens")" "$COLOR_RESET")
      fi
    fi

    local act=""
    if [ -n "$sa_tool" ] && [ "$status" = "running" ]; then
      if [ "$sa_mode" = "waiting" ]; then
        act=$(printf '%swaiting: %s%s' "$COLOR_YELLOW" "$(fit "$sa_tool" 16)" "$COLOR_RESET")
      elif [ "$sa_mode" = "waiting-bg" ]; then
        act=$(printf '%swaiting: %s (bg)%s' "$COLOR_YELLOW" "$(fit "$sa_tool" 16)" "$COLOR_RESET")
      else
        act=$(printf '%slast: %s%s' "$COLOR_DARK_GRAY" "$(fit "$sa_tool" 16)" "$COLOR_RESET")
      fi
    fi

    local cs; cs=$(subagent_cache_segment "$status")

    # Model is absent until Claude Code resolves it; effort is absent when the
    # subagent inherits the session's. Both stay blank rather than guessed.
    local md="" ef=""
    [ -n "$model" ] && md=$(printf '%s%s%s' "$COLOR_CYAN" "$(fit "$(short_model "$model")" 14)" "$COLOR_RESET")
    if [[ "$effort" =~ ^[0-9]+$ ]]; then
      # A numeric effort is a thinking-token budget; "tok" keeps it from
      # reading as a token count.
      local budget; budget=$(fmt_k "$effort")
      ef=$(printf '%s%s tok%s' "$COLOR_GRAY" "${budget/.0k/k}" "$COLOR_RESET")
    elif [ -n "$effort" ]; then
      ef=$(printf '%s%s%s' "$COLOR_GRAY" "$(fit "$effort" 8)" "$COLOR_RESET")
    fi

    ids+=("$id"); types+=("$t"); glyphs+=("$(status_glyph "$status")")
    models+=("$md"); efforts+=("$ef")
    elapsed+=("$el"); ctx+=("$cx"); cache+=("$cs"); activity+=("$act"); descs+=("$desc")

    local l
    l=$(vis_len "$t");   [ "$l" -gt "$w_type" ]    && w_type=$l
    l=$(vis_len "$md");  [ "$l" -gt "$w_model" ]   && w_model=$l
    l=$(vis_len "$ef");  [ "$l" -gt "$w_effort" ]  && w_effort=$l
    l=$(vis_len "$el");  [ "$l" -gt "$w_elapsed" ] && w_elapsed=$l
    l=$(vis_len "$cx");  [ "$l" -gt "$w_ctx" ]     && w_ctx=$l
    l=$(vis_len "$cs");  [ "$l" -gt "$w_cache" ]   && w_cache=$l
    l=$(vis_len "$act"); [ "$l" -gt "$w_act" ]     && w_act=$l
  done

  # Pass 2: fit to the panel width. Type, status and cache always stay (the
  # cache countdown is the point of the row); the type name shrinks when even
  # those three don't fit. Optional columns are admitted whole, most useful
  # first — activity (what a cold cache is waiting on), elapsed, context,
  # model, effort — so every row keeps the same layout, and the description
  # takes what is left. A column no row has a value for takes no space.
  local i
  local max_type=$((columns - 5 - w_cache))
  [ "$max_type" -lt 4 ] && max_type=4
  if [ "$w_type" -gt "$max_type" ]; then
    w_type=$max_type
    for i in "${!types[@]}"; do types[i]=$(fit "${types[i]}" "$w_type"); done
  fi
  local fixed=$((w_type + 2 + 1 + 2 + w_cache))
  local show_el=false show_ctx=false show_act=false show_model=false show_effort=false
  [ "$w_act" -gt 0 ] && [ $((fixed + 2 + w_act)) -le "$columns" ] && { show_act=true; fixed=$((fixed + 2 + w_act)); }
  [ "$w_elapsed" -gt 0 ] && [ $((fixed + 2 + w_elapsed)) -le "$columns" ] && { show_el=true; fixed=$((fixed + 2 + w_elapsed)); }
  [ "$w_ctx" -gt 0 ] && [ $((fixed + 2 + w_ctx)) -le "$columns" ] && { show_ctx=true; fixed=$((fixed + 2 + w_ctx)); }
  [ "$w_model" -gt 0 ] && [ $((fixed + 2 + w_model)) -le "$columns" ] && { show_model=true; fixed=$((fixed + 2 + w_model)); }
  [ "$w_effort" -gt 0 ] && [ $((fixed + 2 + w_effort)) -le "$columns" ] && { show_effort=true; fixed=$((fixed + 2 + w_effort)); }
  local desc_room=$((columns - fixed - 2))

  local out content
  out=""
  for i in "${!ids[@]}"; do
    content="$(printf '%s' $'\033[38;5;141m')$(pad "${types[i]}" "$w_type")${COLOR_RESET}  ${glyphs[i]}"
    [ "$show_model" = true ]  && content+="  $(pad "${models[i]}" "$w_model")"
    [ "$show_effort" = true ] && content+="  $(pad "${efforts[i]}" "$w_effort")"
    [ "$show_el" = true ]  && content+="  $(pad "${elapsed[i]}" "$w_elapsed")"
    [ "$show_ctx" = true ] && content+="  $(pad "${ctx[i]}" "$w_ctx")"
    content+="  $(pad "${cache[i]}" "$w_cache")"
    [ "$show_act" = true ] && content+="  $(pad "${activity[i]}" "$w_act")"
    if [ "$desc_room" -ge 8 ] && [ -n "${descs[i]}" ]; then
      content+="  ${COLOR_GRAY}$(fit "${descs[i]}" "$desc_room")${COLOR_RESET}"
    fi
    # Trailing padding is noise in a row the host renders as-is.
    while [[ "$content" == *' ' ]]; do content="${content% }"; done
    out+="${ids[i]}$_sa_sep$content"$'\n'
  done

  # One jq call encodes every row as JSON (escapes, ANSI and all).
  [ -n "$out" ] && printf '%s' "$out" \
    | jq -Rc 'split("\u001f") | {id: .[0], content: (.[1] // "")}' 2>/dev/null
}

# Runs the subagent renderer when the payload carries a `tasks` array. The cheap
# substring test keeps the main statusline at a single jq call per refresh; the
# jq below is the authoritative check, so a main payload that merely mentions
# "tasks" in some string still falls through to the main render.
maybe_render_subagents() {
  [[ "$_input" == *'"tasks"'* ]] || return 1
  local extracted
  extracted=$(printf '%s' "$_input" | jq -r '
    def clean: tostring | gsub("[[:cntrl:]]"; " ");
    if type == "object" and (.tasks | type) == "array" then
      ([ "subagents", (.session_id // ""), (.transcript_path // ""), (.columns // "") ]
        | map(clean) | join("\u001f")),
      (.tasks[] | select(type == "object")
        | [ (.id // ""), (.name // ""), (.type // ""), (.status // ""),
            (.description // .label // ""), (.startTime // 0),
            (.tokenCount // 0), (.contextWindowSize // 0),
            (.model // ""), (.effort // "") ]
        | map(clean) | join("\u001f"))
    else empty end' 2>/dev/null)
  [[ "$extracted" == subagents* ]] || return 1
  render_subagent_rows "$extracted"
  return 0
}

# --- Orchestrated Execution Flow ---
_input=$(cat)
maybe_render_subagents && exit 0
parse_and_prepare_paths
compute_cache_timer
compute_context_info
compute_rate_limits
compute_turn_breakdown
compute_update_notice
render_statusline

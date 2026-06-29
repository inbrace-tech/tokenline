#!/usr/bin/env bash

# ==============================================================================
# tokenline — a cache-aware statusline for AI coding CLIs
#
# Cross-CLI (Claude Code, Antigravity) and cross-provider (Anthropic, Gemini).
# Renders: model · context · cache TTL (HOT/COLD) · per-turn token economics
# (read / write / new / output / eq / saving %) · 5h + 7d rate-limit pacing.
#
# Repo:     https://github.com/inbrace-tech/tokenline
# License:  MIT
# Requires: bash 4+, jq. Linux/WSL2 or macOS (brew install bash jq).
# ==============================================================================

# Pin C locale: a comma-decimal locale (e.g. pt_BR) makes awk/printf emit
# "46,2k" and reject dotted input. LC_ALL beats LC_NUMERIC, so set LC_ALL to
# stay deterministic even when the user exports LC_ALL. Output is ASCII/bytes.
export LC_ALL=C

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

# --- Theme ---
# Layout preset from `--theme <name>` or $TOKENLINE_THEME. Unknown values fall
# back to "full" (the original three-line render) so a typo never blanks it.
THEME="${TOKENLINE_THEME:-full}"
while [ $# -gt 0 ]; do
  case "$1" in
    --theme) THEME="${2:-full}"; shift 2 ;;
    --theme=*) THEME="${1#--theme=}"; shift ;;
    *) shift ;;
  esac
done
case "$THEME" in
  full|minimal|compact|economics|limits) ;;
  *) THEME="full" ;;
esac

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
  # Read full stdin JSON representing active session state from the CLI client
  local input
  input=$(cat)

  # Single jq execution to parse all required fields into an array at once (reduces forks)
  mapfile -t _f < <(printf '%s' "$input" | jq -r '
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
    (.context_window.current_usage.cache_read_input_tokens // 0)' 2>/dev/null)

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
  rl_5h_reset="${_f[6]}"
  rl_7d_pct="${_f[7]}"
  rl_7d_reset="${_f[8]}"
  cur_input="${_f[9]}"
  cur_output="${_f[10]}"
  cur_cwrite="${_f[11]}"
  cur_cread="${_f[12]}"

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
  # Exposed for the short themes (minimal/compact): cache state, clock, color.
  cache_state=""; cache_clock=""; cache_color=""
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
    cache_state="$suffix"; cache_color="$fg"
    cache_clock=$(printf '%d:%02d' "$mins" "$secs")
    cache_info=$(printf '%s[%s] cache: %s%d:%02d %s%s' "$COLOR_GRAY" "$ttl_label" "$fg" "$mins" "$secs" "$suffix" "$COLOR_RESET")
  else
    cache_state="COLD"; cache_color="${COLOR_RED}"; cache_clock=""
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
  # Exposed for the compact theme: saving percentage and its color.
  saving_pct=""; save_color=""
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
      read_mult="0.1"
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
    
    saving_pct=0
    [ "$uncached_eq" -gt 0 ] && saving_pct=$(awk "BEGIN { printf \"%d\", 100 * ($uncached_eq - $eq_tokens) / $uncached_eq }")

    local read_lbl="${read_mult}x"
    local write_lbl="${write_mult}x"
    local input_lbl="${input_mult}x"
    local output_lbl="${output_mult}x"

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

# --- 7. Compose and Render Output ---
ctx_color_for() {
  # Bold green/yellow/red by context-used percentage.
  local p=$1
  if   [ "$p" -ge 80 ]; then printf '\033[01;31m'
  elif [ "$p" -ge 50 ]; then printf '\033[01;33m'
  else                       printf '\033[01;32m'
  fi
}

model_header() {
  if [ "$cli_client" = "antigravity" ]; then
    printf '%s🌌 Antigravity%s (%s)' "$COLOR_CYAN" "$COLOR_RESET" "$model"
  else
    printf '%s' "$model"
  fi
}

# Line 1, shared by the multi-line themes: model | ctx | cache TTL.
render_line1() {
  local line1; line1=$(model_header)
  [ -n "$ctx_info" ]   && line1="$line1 | $ctx_info"
  [ -n "$cache_info" ] && line1="$line1 | $cache_info"
  printf '%s\n' "$line1"
}

# Rate-limit line (Claude only, when limits exist).
render_rate_limits() {
  if [ "$is_gemini" = false ] && { [ -n "$rl_5h_info" ] || [ -n "$rl_7d_info" ]; }; then
    printf '%s\n' "${COLOR_DARK_GRAY}──────────────────────────────${COLOR_RESET}"
    local line_rl=""
    [ -n "$rl_5h_info" ] && line_rl="$rl_5h_info"
    [ -n "$rl_7d_info" ] && line_rl="${line_rl:+$line_rl  }$rl_7d_info"
    printf '%s\n' "$line_rl"
  fi
}

# Single-line themes: minimal (model · ctx% · cache state) and compact
# (model · ctx tokens+% · cache clock+state · saving%).
render_oneline() {
  local sep="${COLOR_GRAY} · ${COLOR_RESET}"
  local out; out=$(model_header)
  local p=""
  [ -n "$used_pct" ] && p=$(printf '%.0f' "$used_pct")

  if [ -n "$p" ]; then
    local cc; cc=$(ctx_color_for "$p")
    if [ "$THEME" = "compact" ] && [ "${tokens_used:-0}" -gt 0 ] && [ "${tokens_limit:-0}" -gt 0 ]; then
      out="$out${sep}${COLOR_GRAY}ctx ${COLOR_RESET}${cc}$(fmt_k "$tokens_used")/$(fmt_k "$tokens_limit") ${p}%${COLOR_RESET}"
    else
      out="$out${sep}${COLOR_GRAY}ctx ${COLOR_RESET}${cc}${p}%${COLOR_RESET}"
    fi
  fi

  if [ -n "$cache_state" ]; then
    local cstr="cache "
    [ "$THEME" = "compact" ] && [ -n "$cache_clock" ] && cstr="cache ${cache_clock} "
    out="$out${sep}${COLOR_GRAY}${cstr}${cache_color}${cache_state}${COLOR_RESET}"
  fi

  if [ "$THEME" = "compact" ] && [ -n "$saving_pct" ]; then
    out="$out${sep}${COLOR_GRAY}save ${save_color}${saving_pct}%${COLOR_RESET}"
  fi

  printf '%s\n' "$out"
}

render_statusline() {
  case "$THEME" in
    minimal|compact) render_oneline ;;
    economics)
      render_line1
      [ -n "$last_info" ] && printf '%s\n' "$last_info"
      ;;
    limits)
      render_line1
      render_rate_limits
      ;;
    full|*)
      render_line1
      [ -n "$last_info" ] && printf '%s\n' "$last_info"
      render_rate_limits
      ;;
  esac
}

# --- Orchestrated Execution Flow ---
parse_and_prepare_paths
compute_cache_timer
compute_context_info
compute_rate_limits
compute_turn_breakdown
render_statusline

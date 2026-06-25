# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository.

## What this is

`tokenline` is a single-file Bash statusline for AI coding CLIs (Claude Code,
Antigravity). The host CLI pipes a JSON snapshot of the session to the script on
stdin once per second; the script prints up to three lines (model/context/cache,
per-turn token economics, rate limits).

The whole product is `tokenline.sh`. `install.sh` is a dependency-checker that
prints the settings snippet. Keep it that simple.

## Hard constraints

- **Never crash the host CLI.** The script runs every second. On any missing
  dependency or malformed input, degrade gracefully (print a short hint, `exit 0`)
  — never a non-zero exit or an unhandled error.
- **Never write session input to disk.** The stdin payload contains live session
  state. Keep it in memory. Only the small per-turn timestamp/TTL cache is
  persisted, under a `0700` dir in `$XDG_RUNTIME_DIR`.
- **Keep it ShellCheck-clean.** CI runs `shellcheck -s bash` on every push.
- **No new hard dependencies** beyond `bash` 4+, `jq`, and GNU coreutils without
  discussion. The appeal is a zero-install drop-in file.
- **Single file.** Don't split the script into a library unless there's a strong
  reason; the value is "copy one file and go".

## Testing a change

Feed the script a sample payload and inspect the rendered lines:

```bash
echo '{"model":{"display_name":"Opus 4.8"}, ...}' | bash tokenline.sh
```

Strip ANSI to check structure: pipe the output through `sed 's/\x1b\[[0-9;]*m//g'`.

## Platform

v1 targets Linux / WSL2. macOS and Windows are tracked as roadmap issues — the
GNU-specific calls (`mapfile`, `date -d`, `stat -c`) are the things to abstract.

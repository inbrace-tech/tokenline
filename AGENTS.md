# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository.

## What this is

`tokenline` is a single-file Bash statusline for AI coding CLIs (Claude Code,
Antigravity). The host CLI pipes a JSON snapshot of the session to the script on
stdin once per second; the script prints up to three lines (model/context/cache,
per-turn token economics, rate limits).

The product is `tokenline.sh` — that's what renders every second. Two installers
wrap it: `install.sh` (bash, no Node) prints the settings snippet, and the npm
package `@inbrace-tech/tokenline` (a TypeScript CLI in `src/`, built to
`dist/cli.js`) copies the script and patches `settings.json`. Both are
**install-time only** — no Node ever runs in the per-second hot path. Keep the
bash script the single source of truth.

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
- **Single-file statusline.** Don't split `tokenline.sh` into a library unless
  there's a strong reason; the value is "copy one file and go". (The npm
  installer under `src/` is separate tooling — see below.)

## Testing a change

Feed the script a sample payload and inspect the rendered lines:

```bash
echo '{"model":{"display_name":"Opus 4.8"}, ...}' | bash tokenline.sh
```

Strip ANSI to check structure: pipe the output through `sed 's/\x1b\[[0-9;]*m//g'`.

## Platform

Runs on Linux / WSL2 and macOS. `date`/`stat` are abstracted over GNU vs BSD by
probing behavior once (`epoch_from_iso`, `file_mtime` in `tokenline.sh`); `mapfile`
still needs bash 4+, so macOS users `brew install bash`. Windows is a roadmap issue.

## The npm installer

`src/cli.ts` is the installer CLI, authored in TypeScript and built with `tsc`
to `dist/cli.js` (the published artifact; `dist/` is gitignored). It has **zero
runtime dependencies** — only Node built-ins. Develop with pnpm: `pnpm lint`,
`pnpm typecheck`, `pnpm build`. CI runs all three plus ShellCheck.

The installer is a convenience wrapper: it must never become *required* to use
the statusline — the bash + `install.sh` path stays first-class so non-Node
users (Python, Ruby, …) are never excluded. Its `settings.json` patching is
deliberately safe: merge-only, back up first, never clobber invalid JSON,
idempotent, `--force` to replace an existing `statusLine`.

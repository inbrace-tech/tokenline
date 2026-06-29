# tokenline

> See your AI coding costs in real time. Tokenline adds context usage, prompt-cache savings, TTL countdown and rate-limit pacing to Claude Code and Gemini CLI.

![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)
![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20WSL2%20%7C%20macOS-blue)
![Shell](https://img.shields.io/badge/shell-bash%204%2B-lightgrey)

## Quickstart

### 1. Install (via npm)
If you have **Node 18+**, run this inside your project repository to configure the statusline locally.

```bash
npx @inbrace-tech/tokenline init
```

*Want it globally for all your projects? Add `--global` to the command.*
```bash
npx @inbrace-tech/tokenline init --global
```

### 2. Restart your CLI

Simply restart Claude Code or Antigravity, and your new statusline will be live.

---

## Preview

![Tokenline Preview](https://raw.githubusercontent.com/inbrace-tech/tokenline/main/assets/tokenline.png)

- **Line 1** — model · context used (tokens + %) · cache TTL with a live HOT→COLD countdown.
- **Line 2** — per-turn token economics: `read / write / new / output`, the equivalent billed tokens (`eq`), and the **`saving %`** you get from prompt caching.
- **Line 3** — 5h and 7d rate-limit bars with reset ETA and a **pace marker** (`!!` = you're burning the window faster than it refills).

> Lines 2 and 3 appear only when there's something to show (a turn happened, limits exist), so the bar stays quiet when idle.

## About

`tokenline` turns the one-line status bar of your AI coding CLI into a live cockpit:
* Which model you're on.
* How much context you've burned.
* How long your prompt cache stays hot.
* How many tokens you're saving by reusing it.
* How close you are to your 5h / 7d rate limits.

It is **cross-CLI** (Claude Code, Antigravity) and **cross-provider** (Anthropic, Gemini) — detecting the active client and model provider at runtime and adjusting the cost equivalents accordingly.

## Why tokenline?

Most statuslines show the model and the context bar. `tokenline` adds the two things that actually drive cost and flow on long agent sessions:

- **Cache visibility.** Anthropic and Gemini bill cached input tokens at a fraction of the price — but the cache expires. `tokenline` shows the TTL countdown (5m or 1h, detected from the data) so you know whether your next turn lands warm or cold.
- **Savings, quantified.** The `saving %` makes the value of prompt caching concrete instead of invisible.
- **Rate-limit pacing.** The `!!` marker warns you when you're on track to hit the 5h or 7d ceiling before it resets.

## A 30-second guide to Prompt Caching

LLMs are stateless — by default, they must reread your entire codebase context (system prompt, tools, file history) on *every single turn* before generating a response. This phase (Prefill) is slow and expensive.

**Prompt Caching** solves this by saving that processed state in the provider's memory:
- **Cache Write (Cold):** The model reads everything and stores the state. This costs slightly more than base tokens.
- **Cache Hit (Warm):** If your prompt prefix matches the cached state exactly, the model skips the reading phase. This is **~90% cheaper** and starts responding almost instantly.
- **TTL (Time-To-Live):** The cache operates as a **sliding window**. Every cache hit resets the countdown to its full duration for free. The secret to minimizing rate-limit drain is adjusting your workflow pace to keep the cache continuously **HOT**.

### 💡 Pro-tip: Forcing a 5m TTL to save rate limits

Anthropic's rules for assigning cache TTLs are dynamic and can change without notice (e.g., historically granting a 1-hour TTL to Claude.ai Max users). This is exactly why `tokenline` is valuable: it doesn't guess your TTL based on your plan. It parses the actual CLI telemetry in real-time to detect whether your last turn was processed as a 5-minute or 1-hour write, and adapts the UI countdown and token economics accordingly.

If `tokenline` reveals you are getting 1-hour cache writes, keep in mind they burn **2x** the tokens from your 5h/7d rate limit (compared to 1.25x for a 5-minute write). If you find this is exhausting your quota too quickly—especially when running multiple subagents that cool down fast—you can force the CLI to fall back to the cheaper 5-minute writes by adding this to your `.claude/settings.json`:

```json
"env": {
  "FORCE_PROMPT_CACHING_5M": "1"
}
```

## Requirements

Runs on **Linux / WSL2** and **macOS**:

- `bash` 4 or newer — macOS ships 3.2, so `brew install bash`
- [`jq`](https://jqlang.github.io/jq/)
- `date` and `stat` — GNU (`-d` / `-c`) or BSD (`-j` / `-f`); both are handled

On macOS: `brew install bash jq`. BSD `date`/`stat` work as-is; no `coreutils` needed.

> Windows support is on the [roadmap](#roadmap). `install.sh` checks all of the
> above and tells you exactly what's missing.

## Advanced Installation

### Without Node (clone + install.sh)

No Node? Clone the repo and run the dependency checker, which prints a ready-to-paste snippet:

```bash
git clone https://github.com/inbrace-tech/tokenline.git
cd tokenline
./install.sh
```

Add the printed block to your project's `.claude/settings.json` (or `~/.claude/settings.json` for global), inside the top-level object:

```json
"statusLine": {
  "type": "command",
  "command": "bash /absolute/path/to/tokenline/tokenline.sh",
  "refreshInterval": 1
}
```

Then restart Claude Code.

### What the installer does

`npx @inbrace-tech/tokenline init` is deliberately transparent about touching your config:

- **Writes** `tokenline.sh` to `./.claude/` (or `~/.claude/` with `--global`).
- **Merges** only the `statusLine` key into `settings.json` — every other setting is preserved.
- **Backs up** `settings.json` to `settings.json.bak` before writing.
- **Never clobbers** invalid JSON: if it can't parse your `settings.json`, it stops and prints the block to paste manually.
- Is **idempotent**, and won't replace a different existing `statusLine` unless you pass `--force`.

Other commands: `doctor` (check dependencies and config, change nothing) and `uninstall` (remove the block; `--purge` also deletes the script).

### Antigravity CLI

`tokenline` detects the Antigravity CLI from the transcript path and switches to its provider equivalents automatically. Point Antigravity's statusline command at the same
`tokenline.sh` — no extra flags needed.

## How it works

On every refresh the host CLI pipes a JSON snapshot of the session to the script over stdin. `tokenline` parses it in a single `jq` pass (to keep the per-second refresh cheap), reads the last turn's timestamp from the transcript to drive the cache countdown, and renders up to three lines. Per-turn timestamps are cached in a per-user `0700` directory under `$XDG_RUNTIME_DIR` (tmpfs, cleared on logout).

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Blank statusline, or `[tokenline] jq not found` | Install `jq` (`apt install jq` / `brew install jq`), then re-run `./install.sh`. |
| Cache shows `COLD` immediately | Normal right after a long idle gap — the cache window has elapsed. It goes `HOT` again on your next turn. |
| Colors look wrong / show escape codes | Your terminal must support 256-color ANSI. Most modern terminals do; check your `$TERM`. |
| Nothing renders on macOS | Install `bash` 4+ and `jq`: `brew install bash jq`. Stock bash 3.2 lacks `mapfile`. |

## Roadmap

- [x] macOS support (BSD `date`/`stat`, Homebrew bash)
- [ ] Windows support (Git Bash / PowerShell)
- [ ] Configurable colors and thresholds via `TOKENLINE_*` env vars

(Issues for these are tracked in the repo — contributions welcome.)

## Contributing

Issues and PRs are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). The CI runs [ShellCheck](https://www.shellcheck.net/) on every push, so please keep the script lint-clean.

## About Inbrace

`tokenline` is built and maintained by **Inbrace** — a software house based in Campinas, Brazil, building software with technical and human responsibility. We work where security is non-negotiable and architecture is treated as a strategic asset: intentional engineering, grounded decisions, and systems built to last.

> Inbrace. The human side of software.

Learn more at [inbrace.com.br](https://inbrace.com.br) ·
[LinkedIn](https://www.linkedin.com/company/inbrace-tech/)

## Credits

Built by [@ropdias](https://github.com/ropdias) at [Inbrace](https://inbrace.com.br).

## License

[MIT](LICENSE) © 2026 Inbrace.

# tokenline

> A cache-aware statusline for AI coding CLIs — your context, prompt-cache, and token economics at a glance.

![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)
![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20WSL2-blue)
![Shell](https://img.shields.io/badge/shell-bash%204%2B-lightgrey)

`tokenline` turns the one-line status bar of your AI coding CLI into a live cockpit:
which model you're on, how much context you've burned, how long your prompt cache
stays hot, how many tokens you're **saving** by reusing it, and how close you are to
your 5h / 7d rate limits.

It is **cross-CLI** (Claude Code, Antigravity) and **cross-provider** (Anthropic,
Gemini) — detecting the active client and model provider at runtime and adjusting
the cost equivalents accordingly.

## Preview

```text
Opus 4.8 | ctx: 120.4k/1.0M (12%) | [5m] cache: 4:32 HOT
read(0.1x): 98.2k write(1.25x): 12.0k new(1x): 1.1k output(5x): 2.3k eq: 24.8k saving: 78%
──────────────────────────────
5h: ████░░░░░░ 42% (3h10m to reset)  7d: ██░░░░░░░░ 21% (5d04h to reset)
```

- **Line 1** — model · context used (tokens + %) · cache TTL with a live HOT→COLD countdown.
- **Line 2** — per-turn token economics: `read / write / new / output`, the equivalent
  billed tokens (`eq`), and the **`saving %`** you get from prompt caching.
- **Line 3** — 5h and 7d rate-limit bars with reset ETA and a **pace marker**
  (`!!` = you're burning the window faster than it refills).

> Lines 2 and 3 appear only when there's something to show (a turn happened, limits
> exist), so the bar stays quiet when idle.

## Why tokenline?

Most statuslines show the model and the context bar. `tokenline` adds the two things
that actually drive cost and flow on long agent sessions:

- **Cache visibility.** Anthropic and Gemini bill cached input tokens at a fraction of
  the price — but the cache expires. `tokenline` shows the TTL countdown (5m or 1h,
  detected from the data) so you know whether your next turn lands warm or cold.
- **Savings, quantified.** The `saving %` makes the value of prompt caching concrete
  instead of invisible.
- **Rate-limit pacing.** The `!!` marker warns you when you're on track to hit the 5h
  or 7d ceiling before it resets.

## Requirements

v1 targets **Linux / WSL2**:

- `bash` 4 or newer
- [`jq`](https://jqlang.github.io/jq/)
- GNU coreutils (`date -d`, `stat -c`)

> macOS and Windows support are on the [roadmap](#roadmap). `install.sh` checks all of
> the above and tells you exactly what's missing.

## Install

```bash
git clone https://github.com/inbrace-tech/tokenline.git
cd tokenline
./install.sh
```

`install.sh` verifies dependencies and prints a ready-to-paste snippet. Add it to
`~/.claude/settings.json` (global) or your project's `.claude/settings.json`, inside
the top-level object:

```json
"statusLine": {
  "type": "command",
  "command": "bash /absolute/path/to/tokenline/tokenline.sh",
  "refreshInterval": 1
}
```

Then restart Claude Code.

### Antigravity CLI

`tokenline` detects the Antigravity CLI from the transcript path and switches to its
provider equivalents automatically. Point Antigravity's statusline command at the same
`tokenline.sh` — no extra flags needed.

## How it works

On every refresh the host CLI pipes a JSON snapshot of the session to the script over
stdin. `tokenline` parses it in a single `jq` pass (to keep the per-second refresh
cheap), reads the last turn's timestamp from the transcript to drive the cache
countdown, and renders up to three lines. Per-turn timestamps are cached in a
per-user `0700` directory under `$XDG_RUNTIME_DIR` (tmpfs, cleared on logout).

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Blank statusline, or `[tokenline] jq not found` | Install `jq` (`apt install jq` / `brew install jq`), then re-run `./install.sh`. |
| Cache shows `COLD` immediately | Normal right after a long idle gap — the cache window has elapsed. It goes `HOT` again on your next turn. |
| Colors look wrong / show escape codes | Your terminal must support 256-color ANSI. Most modern terminals do; check your `$TERM`. |
| Nothing renders on macOS | Expected on v1 — macOS uses BSD `date`/`stat`. See the [roadmap](#roadmap). |

## Roadmap

- [ ] macOS support (BSD `date`/`stat`, bash 3.2 fallback)
- [ ] Windows support (Git Bash / PowerShell)
- [ ] Configurable colors and thresholds via `TOKENLINE_*` env vars

(Issues for these are tracked in the repo — contributions welcome.)

## Contributing

Issues and PRs are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). The CI runs
[ShellCheck](https://www.shellcheck.net/) on every push, so please keep the script
lint-clean.

## About Inbrace

`tokenline` is built and maintained by **Inbrace** — a software house based in
Campinas, Brazil, building software with technical and human responsibility. We work
where security is non-negotiable and architecture is treated as a strategic asset:
intentional engineering, grounded decisions, and systems built to last.

> Inbrace. The human side of software.

Learn more at [inbrace.com.br](https://inbrace.com.br) ·
[LinkedIn](https://www.linkedin.com/company/inbrace-tech/)

## Credits

Built by [@ropdias](https://github.com/ropdias) at [Inbrace](https://inbrace.com.br).

## License

[MIT](LICENSE) © 2026 Inbrace.

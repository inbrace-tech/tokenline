---
"@inbrace-tech/tokenline": minor
---

Rework `install.sh` into an interactive installer. It now copies `tokenline.sh`
into the Claude profile(s) you choose and patches each `settings.json` with the
same safety contract as the npm CLI (backup, merge-only `statusLine`, idempotent,
never clobbers invalid JSON). It discovers `~/.claude`, any `~/.claude-*`, and
`./.claude`, and lets you install into several profiles at once via an arrow-key
menu (↑/↓ move, space toggle, digits 1-9 quick-toggle, Enter confirm) with a
typed-number fallback for `TERM=dumb`. Adds `--dir`, `--yes`, `--dry-run`,
`--print`, and `--force`. A minimal stepped UI with a TTY-only spinner;
piped/non-interactive runs stay plain and default to `~/.claude`. Runs on stock
macOS bash 3.2 and checks the PATH `bash` (not the interpreter) for the 4+
requirement.

Adds themes to `tokenline.sh` via `--theme <name>` (or `TOKENLINE_THEME`):
`full` (default, unchanged), `minimal` (model · ctx% · cache), `compact`
(one line with tokens + saving%), `economics` (model/ctx/cache + per-turn
breakdown), and `limits` (model/ctx/cache + 5h/7d bars). The installer asks you
to pick a theme before the profile; an unknown value falls back to `full` so a
typo never blanks the statusline.

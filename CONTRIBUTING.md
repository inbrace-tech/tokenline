# Contributing to tokenline

Thanks for your interest in improving `tokenline`! This is a small, focused project,
so contributing is straightforward.

## Ground rules

- **Keep it lint-clean.** CI runs [ShellCheck](https://www.shellcheck.net/) on every
  push and PR. Run it locally before opening a PR:
  ```bash
  shellcheck -s bash tokenline.sh install.sh
  ```
- **No new hard dependencies** beyond `bash`, `jq`, and GNU coreutils without
  discussion first — the appeal of the script is that it's a single drop-in file.
- **The statusline must never crash the host CLI.** Degrade gracefully (print a hint,
  `exit 0`) instead of erroring out. It runs once per second, so failures are loud.
- **Don't log session input to disk.** The script receives session state on stdin;
  keep it in memory.

## Development

The script reads a JSON snapshot on stdin and prints up to three lines. To test a
change, feed it a sample payload:

```bash
echo '{"model":{"display_name":"Opus 4.8"}, ... }' | bash tokenline.sh
```

A quick way to capture a real payload is to temporarily pipe stdin to a file from a
local copy, exercise a session, then reuse that file as a fixture (never commit it —
it contains session data).

## Platform support

v1 targets Linux / WSL2. macOS and Windows are tracked as roadmap issues — if you're
adding BSD `date`/`stat` compatibility, please coordinate on the relevant issue so the
abstraction stays clean.

## Opening a PR

1. Fork and branch from `main`.
2. Make your change, keep it ShellCheck-clean.
3. Describe what changed and how you tested it.

PRs are reviewed and merged by the maintainers — thank you for contributing!

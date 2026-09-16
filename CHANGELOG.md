# @inbrace-tech/tokenline

## 1.2.3

### Patch Changes

- 2174bb7: fix: show the rate-limit reset ETA and pace markers again. Claude Code sends `rate_limits.*.resets_at` as Unix epoch seconds, but since 1.2.1 `tokenline.sh` passed the value to `date` as if it were ISO-8601. GNU and BSD `date` both reject a bare epoch, so the ETA and the `!` / `!!` markers disappeared. An integer `resets_at` is now used directly, and anything else still goes through the ISO-8601 parser.

## 1.2.2

### Patch Changes

- b3730ec: fix: bill cache reads at 0.025x on Claude Fable 5.1 / Mythos 5.1. The per-turn economics line used a flat 0.1x cache-read multiplier for every Claude model, overstating `eq` and understating `saving %` on the models with the discounted cache-hit price. `tokenline.sh` now reads `model.id` and picks 0.025x for Fable 5.1 / Mythos 5.1; every other model keeps 0.1x.

## 1.2.1

### Patch Changes

- 60ba6a6: Add `--antigravity` flag to installer CLI to target Antigravity CLI global settings (`~/.gemini/antigravity-cli/settings.json`).

## 1.2.0

### Minor Changes

- 5e7274b: Add macOS support. `tokenline.sh` now abstracts `date`/`stat` over GNU vs BSD by
  probing behavior once (`epoch_from_iso`, `file_mtime`), pins `LC_ALL=C` so a
  comma-decimal locale renders identically, and the installer accepts macOS
  (`brew install bash jq`). Closes #2.

## 1.1.2

### Patch Changes

- 6e77d23: docs: update README to clarify tokenline features and real-time cost tracking

## 1.1.1

### Patch Changes

- 9351972: fix(docs): update installer README text to reflect local-first default and --global flag

## 1.1.0

### Minor Changes

- ab63142: Changed default installation to local project (.claude), added --global flag, and revamped README with quick start onboarding and Prompt Caching guide.

## 1.0.1

### Patch Changes

- 0d349ac: Fix CLI parser to collect and report all unknown options instead of just the last one.

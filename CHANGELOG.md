# @inbrace-tech/tokenline

## 1.2.3

### Patch Changes

- fix: show the rate-limit reset ETA and pace markers again (`resets_at` is read as epoch seconds) ([#95](https://github.com/inbrace-tech/tokenline/pull/95) by [@ropdias](https://github.com/ropdias))

## 1.2.2

### Patch Changes

- fix: bill cache reads at 0.025x on Claude Fable 5.1 / Mythos 5.1; other models keep 0.1x ([#75](https://github.com/inbrace-tech/tokenline/pull/75) by [@ropdias](https://github.com/ropdias))

## 1.2.1

### Patch Changes

- feat: add `--antigravity` to install into the Antigravity CLI global settings ([#61](https://github.com/inbrace-tech/tokenline/pull/61) by [@ropdias](https://github.com/ropdias))

## 1.2.0

### Minor Changes

- feat: add macOS support (BSD `date`/`stat`, locale-safe rendering) ([#23](https://github.com/inbrace-tech/tokenline/pull/23) by [@xinnaider](https://github.com/xinnaider))

## 1.1.2

### Patch Changes

- docs: clarify the tokenline features and real-time cost tracking in the README ([#20](https://github.com/inbrace-tech/tokenline/pull/20) by [@ropdias](https://github.com/ropdias))

## 1.1.1

### Patch Changes

- docs: fix the installer paths and the `--global` flag in the README ([#18](https://github.com/inbrace-tech/tokenline/pull/18) by [@ropdias](https://github.com/ropdias))

## 1.1.0

### Minor Changes

- feat: install into the local project (`.claude`) by default; add `--global` ([#16](https://github.com/inbrace-tech/tokenline/pull/16) by [@ropdias](https://github.com/ropdias))

## 1.0.1

### Patch Changes

- fix: report every unknown CLI option, not just the last one ([#14](https://github.com/inbrace-tech/tokenline/pull/14) by [@ropdias](https://github.com/ropdias))

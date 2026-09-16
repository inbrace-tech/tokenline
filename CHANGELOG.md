# @inbrace-tech/tokenline

## 1.2.3

### Patch Changes

- [#95](https://github.com/inbrace-tech/tokenline/pull/95) [`2174bb7`](https://github.com/inbrace-tech/tokenline/commit/2174bb7c62c7a9ebfce80f7b98b648763507c36d) Thanks [@ropdias](https://github.com/ropdias)! - fix: show the rate-limit reset ETA and pace markers again (`resets_at` is read as epoch seconds)

## 1.2.2

### Patch Changes

- [#75](https://github.com/inbrace-tech/tokenline/pull/75) [`b3730ec`](https://github.com/inbrace-tech/tokenline/commit/b3730ec441889f680de6297892be28b9cfcf276d) Thanks [@ropdias](https://github.com/ropdias)! - fix: bill cache reads at 0.025x on Claude Fable 5.1 / Mythos 5.1; other models keep 0.1x

## 1.2.1

### Patch Changes

- [#61](https://github.com/inbrace-tech/tokenline/pull/61) [`60ba6a6`](https://github.com/inbrace-tech/tokenline/commit/60ba6a61788e269d2b1f32566db5e140498cfee0) Thanks [@ropdias](https://github.com/ropdias)! - feat: add `--antigravity` to install into the Antigravity CLI global settings

## 1.2.0

### Minor Changes

- [#23](https://github.com/inbrace-tech/tokenline/pull/23) [`5e7274b`](https://github.com/inbrace-tech/tokenline/commit/5e7274b49ddfe2f55ac0269a2cce16ffd3590990) Thanks [@xinnaider](https://github.com/xinnaider)! - feat: add macOS support (BSD `date`/`stat`, locale-safe rendering)

## 1.1.2

### Patch Changes

- [#20](https://github.com/inbrace-tech/tokenline/pull/20) [`6e77d23`](https://github.com/inbrace-tech/tokenline/commit/6e77d2381454bf466d1ab62225b3d00146f15bad) Thanks [@ropdias](https://github.com/ropdias)! - docs: clarify the tokenline features and real-time cost tracking in the README

## 1.1.1

### Patch Changes

- [#18](https://github.com/inbrace-tech/tokenline/pull/18) [`9351972`](https://github.com/inbrace-tech/tokenline/commit/9351972185f222736c77c29f7f15f39e254ee86b) Thanks [@ropdias](https://github.com/ropdias)! - docs: fix the installer paths and the `--global` flag in the README

## 1.1.0

### Minor Changes

- [#16](https://github.com/inbrace-tech/tokenline/pull/16) [`ab63142`](https://github.com/inbrace-tech/tokenline/commit/ab63142e8c6ee2730fbdd6dd32e9c45fba85ec4c) Thanks [@ropdias](https://github.com/ropdias)! - feat: install into the local project (`.claude`) by default; add `--global`

## 1.0.1

### Patch Changes

- [#14](https://github.com/inbrace-tech/tokenline/pull/14) [`0d349ac`](https://github.com/inbrace-tech/tokenline/commit/0d349ac36c795123c6c0b708dc6a041c0f00b906) Thanks [@ropdias](https://github.com/ropdias)! - fix: report every unknown CLI option, not just the last one

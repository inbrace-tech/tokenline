# tokenline — npm Binary Delivery (Plan 3) Design

**Date:** 2026-07-05
**Status:** Approved (design)
**Branch:** `feat/rust-statusline` (Plans 1 + 2 already landed here)
**Predecessors:** Plan 1 (Rust core binary), Plan 2 (cargo-dist distribution + CI). Plan 2 already builds the 5-target binaries and uploads them to a GitHub Release on a `tokenline-v*` tag.

## Goal

Make the npm package `@inbrace-tech/tokenline` deliver the **Rust binary** instead of the bash `tokenline.sh`, while keeping bash first-class as a fallback. `init` wires the native binary into Claude Code's `settings.json`; `doctor` drops the `jq` check on the binary path. The binary reaches the user's machine via per-platform npm packages listed as `optionalDependencies` — **no runtime download, no postinstall fetch**.

## Locked decisions (from the 2026-07-05 grill-me session + this brainstorm)

1. **Delivery = hand-rolled `optionalDependencies` per platform (esbuild/napi pattern), with a bash fallback.** cargo-dist's own `npm` installer is explicitly **not** used: it fetches the binary at runtime (rejected — offline/proxy failure, security surface) and produces a separate package that does no `settings.json` wiring. The existing installer CLI (whose real value is the settings wiring) stays and is extended.
2. **Version convergence = unify on the binary tag, major bump to `2.0.0`.** The main package + the 5 platform packages publish together from the `tokenline-v*` tag at the same version. changesets is retired for this package (it is the only package). The delivery mechanism changed (bash → binary), so it is a breaking major.
3. **Bash stays first-class throughout.** On a platform with no prebuilt binary, `init` falls back to wiring `bash tokenline.sh` (still bundled in the package). No user is excluded.

## Non-goals

- Homebrew delivery (later).
- Nerd-font glyph mode (later).
- Changing the bash `install.sh` path (untouched — remains a first-class non-Node install route).
- Publishing a `libc`-constrained linux package: the linux binaries are static musl and run on any linux, so no `libc` field is needed.

## Architecture

cargo-dist (Plan 2) remains the sole builder/uploader of binaries → GitHub Release. Plan 3 adds the npm delivery layer on top:

```
tokenline-v2.0.0 tag
  └─ tokenline-release.yml (cargo-dist, Plan 2): build 5 targets → GitHub Release assets
       └─ (Release published) ──▶ publish-npm.yml (NEW, on: release: [published]):
            download 5 release archives
            ├─ build @inbrace-tech/tokenline-linux-x64@2.0.0     (os:linux  cpu:x64)
            ├─ build @inbrace-tech/tokenline-linux-arm64@2.0.0   (os:linux  cpu:arm64)
            ├─ build @inbrace-tech/tokenline-darwin-arm64@2.0.0  (os:darwin cpu:arm64)
            ├─ build @inbrace-tech/tokenline-darwin-x64@2.0.0    (os:darwin cpu:x64)
            ├─ build @inbrace-tech/tokenline-win32-x64@2.0.0     (os:win32  cpu:x64)
            └─ build @inbrace-tech/tokenline@2.0.0 (main: dist/cli.js + tokenline.sh + optionalDependencies on the 5)
            → npm publish all 6 at version 2.0.0
```

At `npm install @inbrace-tech/tokenline`, npm installs only the platform package whose `os`/`cpu` match the host (others are skipped as unmet optionals). The CLI resolves the installed one via `require.resolve`.

### Component 1 — Per-platform packages (built at release, not committed source)

| cargo-dist target | npm package | `os` | `cpu` |
|---|---|---|---|
| `x86_64-unknown-linux-musl` | `@inbrace-tech/tokenline-linux-x64` | `linux` | `x64` |
| `aarch64-unknown-linux-musl` | `@inbrace-tech/tokenline-linux-arm64` | `linux` | `arm64` |
| `aarch64-apple-darwin` | `@inbrace-tech/tokenline-darwin-arm64` | `darwin` | `arm64` |
| `x86_64-apple-darwin` | `@inbrace-tech/tokenline-darwin-x64` | `darwin` | `x64` |
| `x86_64-pc-windows-msvc` | `@inbrace-tech/tokenline-win32-x64` | `win32` | `x64` |

Each platform package is minimal:
```json
{
  "name": "@inbrace-tech/tokenline-<plat>",
  "version": "2.0.0",
  "os": ["<os>"],
  "cpu": ["<cpu>"],
  "files": ["tokenline"]   // "tokenline.exe" on win32
}
```
plus the single binary. No `bin` field (we do not want it on `$PATH`; `init` copies it to a stable path). `publishConfig.access = public`.

### Component 2 — Main package `@inbrace-tech/tokenline`

- `version` → `2.0.0`.
- `optionalDependencies`: the 5 platform packages, each pinned to the exact same version (`2.0.0`). npm installs only the matching one.
- Keeps `files: ["dist", "tokenline.sh"]` and `bin: { tokenline: "dist/cli.js" }`.
- `engines.node: >=18` unchanged. Still effectively zero-runtime-dep: the optional platform packages carry only a binary + trivial `package.json`, and `require.resolve` is a Node built-in.
- Retire changesets: remove `release-npm.yml`, the `.changeset/` config, the `changeset`/`release` npm scripts, and `@changesets/cli` from devDependencies. Version now comes from the git tag at publish time.

### Component 3 — CLI changes (`src/`)

- **`core/paths.ts`** — add `resolveBinary(): string | null`. Maps `process.platform` + `process.arch` to a platform package name (the table above), then `require.resolve('<pkg>/package.json')` and returns `dirname + '/tokenline'` (`tokenline.exe` on win32), or `null` if the package is not installed (unsupported platform / not yet published). Add a binary variant of `statusLineCommand`: for the binary it is just the (quote-if-spaces) binary path — **no `bash` prefix**. The bash-script variant is unchanged.
- **`commands/init.ts`** — resolve the binary first:
  - **found:** copy the binary to a stable path (`<claudeDir>/tokenline`, `tokenline.exe` on win32), `chmod 0o755` (unix), and write `command: <that stable path>`. Copying to a stable path (mirroring today's `.sh` copy) avoids pinning `settings.json` to a volatile `node_modules` path.
  - **not found:** current behavior — copy `tokenline.sh`, write `command: bash <script>`. The existing `checkBash`/`checkJq`/`--force` platform gate applies only on this fallback path.
  - Dry-run, backup, conflict-detection, and settings-merge logic are reused unchanged (they already operate on the composed `block.command`).
- **`commands/doctor.ts`** — report which delivery is active: if `resolveBinary()` succeeds, print "binary: <path> (this platform)" and **skip the `jq` check** (the binary has no `jq` dependency); if it returns `null`, report the bash fallback and keep the existing `checkBash`/`checkJq` checks. `checkPlatform` stays informative.
- **`commands/uninstall.ts`** — `--purge` also deletes the copied binary (in addition to the copied `tokenline.sh`), whichever `init` wrote.
- **`infra/system.ts`** — `checkJq`/`checkBash` unchanged (still used on the fallback path). No new hard checks.

### Component 4 — Release/publish pipeline

- **New `.github/workflows/publish-npm.yml`**, trigger `on: release: { types: [published] }`. This fires *after* cargo-dist's `tokenline-release.yml` creates and publishes the GitHub Release, guaranteeing the binaries exist before npm packaging.
- Steps: derive the version from the release tag (`tokenline-v2.0.0` → `2.0.0`); download the 5 release archives; run a generator that, for each target, unpacks the binary into `npm/<plat>/` with the templated `package.json`; build the main package (`tsup`) and stamp its `version` + `optionalDependencies` to the derived version; `npm publish` all 6 (with `NPM_TOKEN`). SHA-pin all third-party actions (repo convention); reuse the existing `actions/checkout` pin.
- A small committed generator script (e.g. `scripts/build-npm-packages.mjs`, Node built-ins only) does the per-platform package assembly, so it is testable and the workflow stays thin.

### Component 5 — Tests

- vitest unit tests for: `resolveBinary` (mock `process.platform`+`arch` and a fake `require.resolve`), `init` on both branches (binary found → binary command + copied binary; not found → bash fallback), `doctor` output for both deliveries, `uninstall --purge` removing the binary.
- A test for the platform-package generator: given a target, it emits a `package.json` with the correct `name`/`os`/`cpu`/`version` and includes the binary file.
- The publish workflow is validated with `npm publish --dry-run` in CI (no real publish outside a tag).
- Existing settings-patcher tests (`core/settings.spec.ts`) stay green.

## Error handling & edge cases

- **Unsupported platform:** `resolveBinary()` returns `null` → bash fallback (existing `--force`/platform-gate behavior). No crash.
- **`require.resolve` throws** (package not installed): caught → treated as `null` (fallback).
- **Invalid `settings.json`:** unchanged — `init` refuses to write and prints the manual block (existing safe-merge behavior).
- **Windows:** the copied binary is `tokenline.exe`; `statusLineCommand` emits the bare path (Claude Code runs it directly). No `bash` on the binary path.
- **Version skew:** because the main package's `optionalDependencies` pin the platform packages to the exact same version and all 6 publish together from one tag, there is never a version mismatch between main and platform packages.

## Rollout / compatibility

- `2.0.0` is a breaking major: existing `1.2.x` users on the bash install keep working (their `settings.json` still points at `bash tokenline.sh`); upgrading and re-running `init` switches them to the binary where available.
- First real publish happens after the branch is merged and a `tokenline-v2.0.0` tag is pushed — out of scope for the plan (which wires + dry-run-proves the pipeline, as Plan 2 did).

## Open follow-ups (out of scope)

- Homebrew tap.
- Nerd-font opt-in mode.
- Deciding the `repository`/publish home (inbrace-tech vs the fork) — inherited from Plan 2's open branch-close decision.

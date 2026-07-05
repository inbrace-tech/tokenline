# tokenline Rust Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `tokenline` Rust binary with a cross-platform release pipeline (cargo-dist → GitHub Release assets + `curl|sh`/`irm|iex` installers) and a Rust CI matrix that builds, lints, tests, and runs the binary on Linux/macOS/Windows plus a pinned MSRV floor.

**Architecture:** This is Plan 2 of the Rust rewrite (Plan 1 = the core binary, complete on branch `feat/rust-statusline`). The crate lives in `rust/`; the git root is the repo root, so cargo-dist is driven from a `dist-workspace.toml` at the repo root pointing at the `rust/` member — that keeps `.github/workflows/` at the git root while letting dist find the crate in the subdirectory. Two CI concerns stay separate: the existing bash/npm `ci.yml` + `release.yml` (changesets) are untouched except a filename rename to free `release.yml` for cargo-dist; a new `rust.yml` gates the crate, and a new dist-generated `release.yml` builds/publishes binaries on `v*` tags.

**Tech Stack:** Rust 2024 edition (stable + pinned MSRV 1.85), `cargo fmt`/`clippy`, GitHub Actions, cargo-dist (`dist`), serde/serde_json (existing deps — unchanged).

## Global Constraints

- **Edition = 2024.** The crate is migrated from the 2021 edition to 2024 (current default for new crates). This is what *sets* the MSRV floor below.
- **MSRV floor = Rust 1.85** — Rust 2024 edition stabilized in 1.85, so the edition itself forces the floor (it subsumes the older `Option::is_none_or`/1.82 floor). Declared via Cargo's `rust-version` field and *proven* by a CI job that builds on exactly 1.85 (earned, not assumed — mirrors the npm CLI's Node-compat matrix philosophy in `AGENTS.md`). Note: this narrows the support floor vs. the "broad floor" instinct in `AGENTS.md`, but the edition bump is a deliberate, requested tradeoff.
- **Never crash the host.** `panic = "unwind"` (required for the top-level `catch_unwind`) must survive into cargo-dist's build profile. Any `[profile.dist]` must `inherits = "release"` and must NOT set `panic = "abort"`.
- **Bash + `install.sh` stays first-class.** Nothing in this plan forces any user onto the binary; the shell script remains the drop-in default. npm keeps shipping bash (Plan 3 wires npm→binary later).
- **Binary versioning is an independent `v*` semver track**, starting at `0.1.0`. Its git tags (`v0.1.0`, …) must never collide with changesets' npm tags (`@inbrace-tech/tokenline@x.y.z`). They don't overlap by construction; keep it that way.
- **Pin every third-party GitHub Action to a full commit SHA** with a trailing `# vX.Y.Z` comment — repo convention (see `.github/workflows/ci.yml`). `actions/checkout` is already pinned to `9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0` elsewhere; reuse that SHA.
- **Release targets (verbatim):** `x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl`, `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-pc-windows-msvc`.
- **Installers:** `shell` (curl|sh) + `powershell` (irm|iex) only. Homebrew/msi/npm are later follow-ups.
- All work lands on branch `feat/rust-statusline` (base `main`). Do NOT push any `v*` tag or merge in this plan — the release pipeline is *wired and locally proven*, not fired. Cutting the first real release happens after the branch is merged (a separate, user-driven decision).

---

### Task 1: Migrate to Rust 2024 edition + pin MSRV 1.85

Migrate the crate from the 2021 edition to 2024, then declare the MSRV floor the edition forces (Rust 1.85). `cargo fix --edition` auto-applies the 2024 breaking changes (e.g. wrapping the `extern` declaration of `libc_getuid` in `cache.rs` in an `unsafe extern` block). This runs **first** so the `cargo fmt` baseline (Task 2) captures the post-migration code.

**Files:**
- Modify: `rust/Cargo.toml` (`edition = "2024"` + add `rust-version`)
- Modify: `rust/src/*.rs` (whatever `cargo fix --edition` rewrites — expected minimal)

**Interfaces:**
- Consumes: nothing.
- Produces: `edition = "2024"` and `rust-version = "1.85"` in `[package]` (Task 3's `msrv` job pins to 1.85; Task 2's fmt baseline runs over the migrated code).

- [ ] **Step 1: Confirm the crate is on edition 2021 and green (baseline)**

Run: `grep '^edition' rust/Cargo.toml && cd rust && cargo test`
Expected: `edition = "2021"`; 35 tests pass. This is the pre-migration baseline.

- [ ] **Step 2: Apply the automated edition migration**

```bash
cd rust && cargo fix --edition --allow-dirty --allow-staged --lib --bins --tests
```
Expected: exit 0. This rewrites any 2021→2024 incompatibilities in place (does NOT bump the edition field yet).

- [ ] **Step 3: Bump the edition and add the MSRV field**

In `rust/Cargo.toml` `[package]`, change `edition = "2021"` to `edition = "2024"`, and add after `license = "MIT"`:

```toml
rust-version = "1.85"   # MSRV floor forced by edition 2024 (stabilized in 1.85); proven by CI msrv job
```

- [ ] **Step 4: Verify the migrated crate is fully green**

Run: `cd rust && cargo clippy --all-targets -- -D warnings && cargo test`
Expected: both exit 0 (clippy clean, 35 tests pass) on the 2024 edition.

- [ ] **Step 5: Verify the floor is real — builds on 1.85, not below**

```bash
rustup toolchain install 1.85.0 --profile minimal
rustup toolchain install 1.84.0 --profile minimal
cd rust && cargo +1.85.0 build            # expect: success
cd rust && cargo +1.84.0 build 2>&1 | grep -i "edition\|2024\|1\.85"   # expect: FAILS citing edition 2024 needs 1.85
```
Expected: 1.85.0 builds; 1.84.0 fails citing edition 2024 requires Rust 1.85. (If 1.84 unexpectedly builds, re-derive the true floor from the error before trusting the pin.)

- [ ] **Step 6: Commit**

```bash
git add rust/Cargo.toml rust/src
git commit -m "build(rust): migrate to Rust 2024 edition, pin MSRV 1.85

Edition 2024 (default for new crates); its 1.85 stabilization sets the
MSRV floor, subsuming the earlier is_none_or/1.82 floor."
```

---

### Task 2: Adopt canonical `cargo fmt` + enable the format gate baseline

The crate uses a compact brace style; canonical `cargo fmt` produces a large one-time reformat. Adopt the canonical style now (standard Rust convention, no nightly, no bespoke `rustfmt.toml` to maintain) so Task 3's `cargo fmt --check` gate is green from its first run. Runs **after** the edition migration (Task 1) so it formats the final code once.

**Files:**
- Modify: `rust/src/*.rs` (mechanical reformat only)
- Modify: `rust/tests/*.rs` (mechanical reformat only)

**Interfaces:**
- Consumes: the edition-2024 code from Task 1.
- Produces: a repository state where `cargo fmt --check` exits 0 (Task 3's `fmt` job depends on this).

- [ ] **Step 1: Confirm the gate currently fails**

Run: `cd rust && cargo fmt --check`
Expected: non-zero exit with a large diff (compact style vs canonical). This is the "failing test" for this task.

- [ ] **Step 2: Apply the canonical reformat**

Run: `cd rust && cargo fmt`
Expected: exit 0, working tree now has reformatted `.rs` files.

- [ ] **Step 3: Verify the gate now passes and nothing else broke**

Run: `cd rust && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`
Expected: all three exit 0 (fmt clean, clippy clean, 35 tests pass). Formatting is non-semantic, so tests must still pass unchanged.

- [ ] **Step 4: Commit**

```bash
git add rust/src rust/tests
git commit -m "style(rust): adopt canonical cargo fmt formatting

One-time reformat to the default rustfmt style so CI can gate on
\`cargo fmt --check\` without a nightly-only rustfmt.toml. No logic change."
```

---

### Task 3: Rust CI workflow — fmt + clippy + test matrix (Linux/macOS/Windows) + MSRV + fan-in gate

Add `.github/workflows/rust.yml`. Mirrors the conventions in `ci.yml` (SHA-pinned actions, `concurrency` group, least-privilege `permissions`, `timeout-minutes`, and a single fan-in gate job whose fixed name is what branch protection requires). The Windows leg of the test matrix runs `cargo test`, which executes `never_crash.rs` (spawns the real built binary via stdin, asserts exit-0 + render) and `golden.rs` (value-diff against the committed golden) — that IS the "run the binary on Windows" done-criteria; no separate windows-run job is needed.

**Files:**
- Create: `.github/workflows/rust.yml`

**Interfaces:**
- Consumes: `rust-version = "1.85"` + edition 2024 (Task 1); `cargo fmt --check` clean (Task 2).
- Produces: a required status check named `Rust` (fan-in gate). The user must add `Rust` to the branch-protection ruleset after merge (noted in the final report — cannot be done from the branch).

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/rust.yml`. Pin `dtolnay/rust-toolchain` to its current commit SHA before committing (Step 3); the `@master`/`@1.82.0` refs below are placeholders for the SHA-pin step, exactly as `ci.yml` pins its actions.

```yaml
# ─────────────────────────────────────────────────────────────────────────────
# Rust CI — gates the tokenline binary crate in rust/. Runs on every PR/push.
# fmt + clippy + test across Linux/macOS/Windows, plus an MSRV build on the
# declared floor (1.82). The Windows test leg runs the actual binary via stdin
# (tests/never_crash.rs) — that is the "runs on Windows" done-criteria.
# ─────────────────────────────────────────────────────────────────────────────
name: Rust

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

# Cancel stale PR runs; never cancel push-to-main runs.
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

permissions:
  contents: read

defaults:
  run:
    working-directory: rust

jobs:
  fmt:
    name: rustfmt
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
      - uses: dtolnay/rust-toolchain@stable # PIN TO SHA
        with:
          components: rustfmt
      - run: cargo fmt --check

  test:
    name: test (${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    timeout-minutes: 15
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
      - uses: dtolnay/rust-toolchain@stable # PIN TO SHA
        with:
          components: clippy
      - name: Clippy (deny warnings)
        run: cargo clippy --all-targets -- -D warnings
      - name: Test (runs the built binary via stdin on this OS)
        run: cargo test

  msrv:
    name: MSRV (1.85)
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
      - uses: dtolnay/rust-toolchain@1.85.0 # PIN TO SHA
      - name: Build on the declared MSRV floor
        run: cargo build --bins --lib

  # Thin fan-in gate. This exact string "Rust" is the required status check
  # in branch protection, so it must stay a single fixed name that fans in over
  # fmt + test + msrv. `if: always()` + explicit result checks make it a real
  # pass/fail instead of a "skipped" that branch protection treats as green.
  rust:
    name: Rust
    needs: [fmt, test, msrv]
    if: always()
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Gate on the Rust jobs
        working-directory: ${{ github.workspace }}
        run: |
          if [ "${{ needs.fmt.result }}" != "success" ] \
             || [ "${{ needs.test.result }}" != "success" ] \
             || [ "${{ needs.msrv.result }}" != "success" ]; then
            echo "::error::Rust fmt, test matrix, or MSRV build did not pass."
            exit 1
          fi
```

- [ ] **Step 2: Validate the workflow YAML locally**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/rust.yml')); print('yaml ok')"`
Expected: `yaml ok` (no parse error).

- [ ] **Step 3: Pin the Rust toolchain action to a commit SHA**

Resolve the current commit SHA for the `dtolnay/rust-toolchain` refs and replace each `@stable`/`@1.82.0` with `@<sha> # <ref>` (repo convention). Example:

```bash
gh api repos/dtolnay/rust-toolchain/commits/master --jq '.sha'   # -> use for @stable legs
gh api repos/dtolnay/rust-toolchain/commits/1.85.0 --jq '.sha'   # -> use for the msrv leg
```
Edit `rust.yml` so no third-party action is referenced by a mutable tag/branch. Re-run Step 2 to confirm the YAML still parses.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/rust.yml
git commit -m "ci(rust): add fmt + clippy + test matrix + MSRV gate"
```

---

### Task 4: cargo-dist config + release pipeline

Wire cargo-dist from a repo-root `dist-workspace.toml` pointing at the `rust/` crate. This generates `.github/workflows/release.yml` (binary builds + `curl|sh`/`irm|iex` installers + GitHub Release assets on `v*` tags). First free the `release.yml` filename by renaming the existing npm changesets workflow.

**Files:**
- Rename: `.github/workflows/release.yml` → `.github/workflows/release-npm.yml` (content unchanged except `name:`)
- Create: `dist-workspace.toml` (repo root)
- Create: `.github/workflows/release.yml` (generated by `dist init`)
- Modify: `rust/Cargo.toml` (dist adds `[profile.dist]`)

**Interfaces:**
- Consumes: `rust/Cargo.toml` with `rust-version` (Task 2) and `[profile.release] panic = "unwind"`.
- Produces: `dist-workspace.toml` with the locked targets/installers; a `release.yml` triggered on `v*` tags.

- [ ] **Step 1: Rename the npm release workflow to free `release.yml`**

```bash
git mv .github/workflows/release.yml .github/workflows/release-npm.yml
```
Then edit `.github/workflows/release-npm.yml` and change the workflow name line from `name: Release` to `name: Release (npm)` so the two release workflows are distinguishable in the Actions UI. Leave triggers (push to main) and all steps unchanged — changesets does not depend on the filename.

- [ ] **Step 2: Install cargo-dist (`dist`)**

```bash
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/axodotdev/cargo-dist/releases/latest/download/cargo-dist-installer.sh | sh
dist --version   # record this exact version — it is written into the config for reproducibility
```
Expected: `dist` on PATH, prints a version (e.g. `dist 0.x.y`).

- [ ] **Step 3: Ensure `rust/Cargo.toml` has a repository URL (dist requires it)**

dist blocks on knowing where the project is hosted. Confirm `rust/Cargo.toml`'s `[package]` has a `repository` key; if absent, add:

```toml
repository = "https://github.com/inbrace-tech/tokenline"
```
Run: `grep -q '^repository' rust/Cargo.toml && echo present || echo MISSING`
Expected: `present`.

- [ ] **Step 4: Run `dist init` and reconcile to the target config**

```bash
dist init --yes
```
`dist init` creates `dist-workspace.toml` (or writes `[workspace.metadata.dist]`), adds `[profile.dist]` to `rust/Cargo.toml`, and generates `.github/workflows/release.yml`. Then edit `dist-workspace.toml` so it matches this exact target (reconcile whatever `dist init` produced to this — replace `cargo-dist-version` with the version printed in Step 2):

```toml
[workspace]
members = ["cargo:rust"]

[dist]
# Recorded by `dist init`; use the version from Step 2 verbatim.
cargo-dist-version = "0.X.Y"
# curl|sh + irm|iex installers (Homebrew/npm/msi are later follow-ups).
installers = ["shell", "powershell"]
# Locked release targets.
targets = [
    "x86_64-unknown-linux-musl",
    "aarch64-unknown-linux-musl",
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "x86_64-pc-windows-msvc",
]
# CI backend that builds + publishes the above.
ci = "github"
```

- [ ] **Step 5: Verify `panic = "unwind"` survives into the dist profile**

`dist init` adds `[profile.dist]` to `rust/Cargo.toml`. Confirm it inherits `release` (which sets `panic = "unwind"`) and does NOT itself set `panic = "abort"` — abort would make a panic a non-zero exit and break the never-crash guarantee.

```bash
grep -A4 '\[profile.dist\]' rust/Cargo.toml
grep -q 'panic *= *"abort"' rust/Cargo.toml && echo "FAIL: abort present" || echo "ok: no abort"
```
Expected: `[profile.dist]` shows `inherits = "release"`; second command prints `ok: no abort`. If `dist init` added `panic = "abort"` anywhere, remove it.

- [ ] **Step 6: Validate the release plan (the pipeline "test" — no build, no publish)**

```bash
dist plan
```
Expected: exit 0; prints a plan listing all 5 targets and the shell + powershell installers, with no config errors. This proves the config is internally consistent without building or tagging anything.

- [ ] **Step 7: Confirm the generated release workflow triggers on tags, not push-to-main**

```bash
grep -A6 '^on:' .github/workflows/release.yml
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml')); print('yaml ok')"
```
Expected: the trigger is a tag pattern (e.g. `push: tags: ['**[0-9]+.[0-9]+.[0-9]+*']`), NOT `branches: [main]`; YAML parses. This guarantees it stays dormant until a `v*` tag is pushed (which this plan does not do) and never races the npm `release-npm.yml`.

- [ ] **Step 8: Pin third-party actions in the generated workflow (best-effort) and commit**

dist-generated workflows usually pin actions already; if any are on mutable tags, pin them to SHAs per repo convention (`ci.yml` style). Then commit:

```bash
git add dist-workspace.toml rust/Cargo.toml \
        .github/workflows/release.yml .github/workflows/release-npm.yml
git commit -m "build(rust): wire cargo-dist release pipeline

dist-workspace.toml drives cargo-dist from the repo root at the rust/
crate. Generates release.yml (binary build matrix + shell/powershell
installers + GitHub Release assets) on v* tags. Renames the npm
changesets workflow to release-npm.yml to free the release.yml name;
their tag/branch triggers do not overlap."
```

---

### Task 5: Prove the pipeline builds real artifacts locally + document the release process

`dist plan` (Task 4) validates config but builds nothing. Since this plan does not push a tag, prove the pipeline actually produces a binary + installer for the host platform with a local build, and document how a maintainer cuts the first release after merge.

**Files:**
- Create: `rust/RELEASING.md` (release runbook for the binary track)

**Interfaces:**
- Consumes: the `dist-workspace.toml` from Task 4.
- Produces: developer-facing docs; no code.

- [ ] **Step 1: Build host-platform artifacts locally (the end-to-end proof)**

```bash
dist build --artifacts=local
```
Expected: exit 0; produces an archive for the host target and the installer script(s) under `target/distrib/` (or the path dist prints). This exercises the real build + packaging path without needing all 5 cross-toolchains or a tag.

- [ ] **Step 2: Sanity-check the built binary still never-crashes**

Locate the built binary dist just produced and confirm the never-crash contract holds on a real release-profile build:

```bash
echo 'not json' | ./target/dist/tokenline; echo "exit=$?"
```
Expected: empty output, `exit=0`. (Adjust the path to wherever `dist build` reports the binary; the profile is `dist`, which inherits `release` → `panic = "unwind"`.)

- [ ] **Step 3: Write the release runbook**

Create `rust/RELEASING.md`:

```markdown
# Releasing the `tokenline` binary

The Rust binary ships on its own `v*` semver track via cargo-dist, independent
of the npm package (which versions via changesets and tags `@inbrace-tech/tokenline@x.y.z`).

## Cutting a release

1. Bump `version` in `rust/Cargo.toml` (starts at `0.1.0`; earns `1.0.0` at
   full parity + Windows-verified).
2. Commit on `main`.
3. Tag and push:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
4. `.github/workflows/release.yml` (cargo-dist) fans out the build matrix for all
   five targets, generates the `curl|sh` + `irm|iex` installers, and attaches the
   archives + installers to a GitHub Release.

## Targets

`x86_64`/`aarch64-unknown-linux-musl` (static), `aarch64`/`x86_64-apple-darwin`,
`x86_64-pc-windows-msvc`.

## Install (once a release exists)

- Unix: `curl --proto '=https' --tlsv1.2 -LsSf https://github.com/inbrace-tech/tokenline/releases/latest/download/tokenline-installer.sh | sh`
- Windows: `irm https://github.com/inbrace-tech/tokenline/releases/latest/download/tokenline-installer.ps1 | iex`

## Notes

- Never set `panic = "abort"` in `[profile.dist]` — the never-crash guarantee
  relies on `catch_unwind`, which needs `panic = "unwind"`.
- The bash `install.sh` path stays first-class; the binary is an additional
  channel, not a replacement.
```

- [ ] **Step 4: Commit**

```bash
git add rust/RELEASING.md
git commit -m "docs(rust): add binary release runbook"
```

---

## Post-plan manual follow-ups (cannot be done from the branch)

These are recorded for the final report / the user — they require repo-admin access or a merge, so they are explicitly out of the task scope:

1. **Add `Rust` to the branch-protection required status checks** (alongside the existing `CLI`) so the new gate is enforced on PRs.
2. **First real release** is deferred until after the branch is merged — tag `v0.1.0` then (Task 5 runbook). This plan wires and locally proves the pipeline but pushes no tag.
3. **Homebrew / npm-delivers-binary** are Plan 3 (`optionalDependencies` per platform; `doctor` drops the jq check).

## Self-review notes

- **Spec coverage:** Rust 2024 edition migration (Task 1) ✓; cargo-dist pipeline (Task 4) ✓; CI matrix running the binary on windows-latest + linux/macos (Task 3, via `cargo test` → `never_crash.rs`) ✓; MSRV decided + wired (Task 1 pin + Task 3 job) ✓; `cargo fmt` policy decided + wired (Task 2 + Task 3 `fmt` job) ✓; `curl|sh` + `.ps1` installers (Task 4 `installers = ["shell","powershell"]`) ✓.
- **Type/name consistency:** the fan-in gate job id `rust` / display name `Rust`; MSRV `1.85` consistent across Task 1 (`rust-version` + edition 2024) and Task 3 (`dtolnay/rust-toolchain@1.85.0`); the five targets are identical everywhere.
- **Deliberate simplifications (ponytail):** no build caching (`Swatinem/rust-cache`) — the crate is tiny and builds fast; add if CI wall-time becomes a problem. No `rustfmt.toml` — canonical style needs no config. No separate windows-run job — the windows test leg already runs the real binary via stdin.

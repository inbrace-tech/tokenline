# Releasing the `tokenline` binary

The Rust binary ships on its own `tokenline-v*` semver track via cargo-dist, independent
of the npm package (which versions via changesets and tags `@inbrace-tech/tokenline@x.y.z`).

The tag is namespaced (`tokenline-v0.1.0`, not bare `v0.1.0`) so the binary
release track is provably disjoint from the npm changesets tags — see
`tag-namespace = "tokenline"` in `dist-workspace.toml`. The release workflow
is `.github/workflows/tokenline-release.yml`.

## Cutting a release

1. Bump `version` in `rust/Cargo.toml` (starts at `0.1.0`; earns `1.0.0` at
   full parity + Windows-verified).
2. Commit on `main`.
3. Tag and push:
   ```bash
   git tag tokenline-v0.1.0
   git push origin tokenline-v0.1.0
   ```
4. `.github/workflows/tokenline-release.yml` (cargo-dist) fans out the build matrix for all
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

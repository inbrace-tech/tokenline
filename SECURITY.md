# Security Policy

## Supported versions

Security fixes land on the latest published `@inbrace-tech/tokenline` release.
Older versions are not backported — upgrade to the latest to receive fixes.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub's
[Report a vulnerability](https://github.com/inbrace-tech/tokenline/security/advisories/new)
form, which opens a private advisory visible only to the maintainers.

Please include what you can:

- the version of `tokenline` and how it was installed (npm package or the bash
  script directly);
- your operating system and `bash` version;
- what an attacker gains, and the steps or input that demonstrate it.

You can expect an acknowledgement within a few days and an assessment of the
report shortly after. If a fix is warranted, we will agree a disclosure timeline
with you and credit you in the release notes unless you would rather not be
named.

## What this project handles

Worth stating plainly, because it bounds what a vulnerability here can reach:

- **The statusline reads session data on stdin and never writes it to disk.**
  The host CLI pipes a JSON snapshot of the live session to `tokenline.sh` once
  per second. It is processed in memory. The only thing persisted is a small
  per-turn timestamp/TTL cache, under a `0700` directory in `$XDG_RUNTIME_DIR`.
- **The published CLI has zero runtime dependencies.** `dist/cli.js` uses only
  Node built-ins, so installing this package pulls no third-party code onto a
  consumer's machine.
- **The installer only touches `settings.json`, and conservatively.** It merges
  rather than overwrites, backs the file up first, refuses to clobber invalid
  JSON, and is idempotent.

## How releases are protected

- **Publishing uses npm Trusted Publishing (OIDC).** There is no long-lived npm
  token stored as a repository secret, so there is no publish credential for a
  compromised workflow or dependency to steal.
- **Every published tarball carries a signed provenance statement** linking it
  to the exact workflow run that built it, verifiable with `npm audit signatures`.
- **Every GitHub Action is pinned to a full commit SHA**, so a compromised or
  retagged action version cannot silently enter a workflow run.
- **Workflow checkouts drop their credentials** (`persist-credentials: false`), so
  the job token is not left in `.git/config` for a later step to read. That
  includes the release job: its versioning action authenticates its own pushes
  after dependencies are installed.
- **Dependency installs run with a frozen lockfile**, and install-time lifecycle
  scripts are blocked for every dependency except an explicit allow-list in
  `pnpm-workspace.yaml`.
- **New dependency versions are quarantined.** `minimumReleaseAge` and the
  Dependabot `cooldown` both hold a version for a few days after publication,
  and `.github/workflows/dependency-audit.yml` re-checks on every pull request
  that each newly resolved version is still published and past that floor.
- **The dependency tree is swept daily** by
  `.github/workflows/dependency-audit-daily.yml`, for published advisories and
  for any version that has been withdrawn from the registry since it merged.

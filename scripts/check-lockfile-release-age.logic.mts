// ==============================================================================
// Lockfile release-age gate — evaluation (pure half)
//
// Two questions about the `name@version` entries a pnpm lockfile resolves:
//
//   1. Is the version still published?  A malicious release is TAKEN DOWN, not
//      aged out, so a lockfile pinning a version that has disappeared from the
//      registry is reporting a takedown. No local setting can observe this —
//      which is what earns this gate its place.
//   2. Is it old enough?  `minimumReleaseAge` in `pnpm-workspace.yaml` already
//      keeps pnpm from RESOLVING a version younger than the floor, so this is a
//      backstop rather than the primary control: it catches a lockfile produced
//      by a pnpm older than 10.16 (which does not know the setting) or edited by
//      hand. The floor is read from that file so the two cannot drift.
//
// TWO MODES, because the two questions have different natural scopes
//
//   --base <ref>   The pull-request gate. Checks only what the change ADDS,
//                  both questions. Versions already on the base branch were
//                  checked when they landed, so re-asking spends a registry
//                  round-trip to re-derive a known answer.
//
//   --all          The scheduled sweep. Checks the WHOLE lockfile, takedown
//                  question only. This is the case the PR gate structurally
//                  cannot see: a version that entered the lockfile weeks ago
//                  and was pulled from the registry yesterday is added by no
//                  pull request, so only a periodic full pass finds it. Age is
//                  not re-asked here — every entry has by definition aged since
//                  it merged, and re-flagging one would be noise.
//
// This file is deliberately free of `node:*` imports, `fetch` and `process`: it
// takes argv, lockfile TEXT and already-fetched registry facts as arguments, so
// every branch is provable from the spec without a network, a repository or an
// exit. The I/O half is `check-lockfile-release-age.mts`.
// ==============================================================================

export const LOCKFILE = 'pnpm-lock.yaml'
export const WORKSPACE_MANIFEST = 'pnpm-workspace.yaml'
export const DEFAULT_BASE_REF = 'origin/main'

/** One resolved dependency, as the lockfile names it. */
export interface ResolvedPackage {
  readonly name: string
  readonly version: string
}

/** What the registry says about one resolved version. */
export interface RegistryFact {
  /** ISO-8601 publish timestamp, or `undefined` when the registry has none. */
  readonly publishedAt: string | undefined
  /** Whether the version is still listed in the packument's `versions` map. */
  readonly stillPublished: boolean
}

/** Which question failed. Each maps to one branch of `evaluatePackage`. */
export type ViolationCode =
  'version-absent-from-registry' | 'version-too-fresh' | 'publish-date-unknown'

export interface Violation {
  readonly code: ViolationCode
  readonly name: string
  readonly version: string
  readonly detail: string
}

// ── Command line ─────────────────────────────────────────────────────────────

/** What one invocation asks, once argv has been validated. */
export type GateOptions =
  | {
      readonly mode: 'delta'
      readonly baseRef: string
      readonly verbose: boolean
    }
  | { readonly mode: 'sweep'; readonly verbose: boolean }

export type ParsedArgs =
  | { readonly ok: true; readonly options: GateOptions }
  | { readonly ok: false; readonly error: string }

/**
 * Validates argv (without the `node` and script entries).
 *
 * Strict on purpose. A malformed invocation must never degrade into a run that
 * checks less than it was asked to: `--base` with an empty value would read
 * `git show :pnpm-lock.yaml` — the INDEX copy, i.e. the head itself — and report
 * "nothing added" on every PR. An unknown flag (a typo of `--all`) would silently
 * fall back to the delta mode. Both are the gate's "looks guarded" state, so
 * both are errors.
 */
export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  let verbose = false
  let sweepAll = false
  let baseRef: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (arg === '--verbose') {
      verbose = true
    } else if (arg === '--all') {
      sweepAll = true
    } else if (arg === '--base') {
      const value = argv[i + 1]

      if (value === undefined || value.trim() === '' || value.startsWith('-')) {
        return {
          ok: false,
          error:
            '`--base` needs a ref (a SHA or `origin/main`). An empty base would ' +
            'compare the lockfile against itself and pass every PR.',
        }
      }

      baseRef = value
      i++
    } else {
      return {
        ok: false,
        error: `Unknown argument \`${String(arg)}\`. Usage: [--base <ref> | --all] [--verbose]`,
      }
    }
  }

  if (sweepAll && baseRef !== undefined) {
    return {
      ok: false,
      error:
        '`--all` and `--base` are different scopes; pass one or the other.',
    }
  }

  return {
    ok: true,
    options: sweepAll
      ? { mode: 'sweep', verbose }
      : { mode: 'delta', baseRef: baseRef ?? DEFAULT_BASE_REF, verbose },
  }
}

// ── Lockfile ─────────────────────────────────────────────────────────────────

// A lockfile entry in the `packages:` / `snapshots:` blocks sits at exactly two
// spaces of indent, spelled `name@version:` or — when peers take part in the
// resolution — `'name@version(peer@version)':`. Requiring that indent is what
// keeps the `importers:` block, whose `version:` lines sit deeper, out of the
// result.
const LOCKFILE_ENTRY =
  /^ {2}'?((?:@[^@'\s/]+\/)?[^@'\s/][^@'\s]*)@([0-9][^'():\s]*)'?(?:\(|:)/

/**
 * Every `name@version` a pnpm lockfile resolves.
 *
 * A peer-suffixed snapshot key collapses onto the same identity as its
 * `packages:` entry, which is the intent: `foo@1.0.0(bar@2.0.0)` and `foo@1.0.0`
 * are one published tarball.
 */
export function parseResolvedVersions(lockfileText: string): Set<string> {
  const resolved = new Set<string>()

  for (const line of lockfileText.split('\n')) {
    const match = LOCKFILE_ENTRY.exec(line)
    if (match !== null) {
      resolved.add(`${match[1]}@${match[2]}`)
    }
  }

  return resolved
}

/**
 * Splits a `name@version` key back into its parts, on the LAST separator so a
 * scoped name survives intact.
 */
export function splitResolvedKey(key: string): ResolvedPackage {
  const separator = key.lastIndexOf('@')

  return { name: key.slice(0, separator), version: key.slice(separator + 1) }
}

/** Every entry a lockfile resolves, sorted for a stable report. */
export function allResolvedVersions(lockfileText: string): ResolvedPackage[] {
  return [...parseResolvedVersions(lockfileText)].sort().map(splitResolvedKey)
}

/**
 * The entries `headText` resolves that `baseText` did not. A removal is not a
 * finding: only an addition can introduce an artifact this repository did not
 * already trust.
 */
export function addedResolvedVersions(
  baseText: string,
  headText: string,
): ResolvedPackage[] {
  const base = parseResolvedVersions(baseText)

  return [...parseResolvedVersions(headText)]
    .filter((key) => !base.has(key))
    .sort()
    .map(splitResolvedKey)
}

// ── Evaluation ───────────────────────────────────────────────────────────────

export interface EvaluateInput {
  readonly pkg: ResolvedPackage
  readonly fact: RegistryFact
  /** Milliseconds since the epoch, injected so the spec can pin it. */
  readonly now: number
  /**
   * The age floor to enforce, or `null` to ask the takedown question only —
   * what the `--all` sweep passes, since every entry already on the branch has
   * aged since it merged.
   */
  readonly minimumReleaseAgeMinutes: number | null
}

/**
 * The single-package decision. Returns `null` when the package is clean.
 *
 * Absence is answered first: a taken-down version is the more serious state,
 * and its publish date would otherwise describe something nobody can install.
 */
export function evaluatePackage(input: EvaluateInput): Violation | null {
  const { pkg, fact, now, minimumReleaseAgeMinutes } = input

  if (!fact.stillPublished) {
    return {
      code: 'version-absent-from-registry',
      name: pkg.name,
      version: pkg.version,
      detail:
        'the registry no longer lists this version. A version that disappears ' +
        'after being resolved is the signature of a takedown — treat it as ' +
        'compromised until the registry or the maintainer says otherwise.',
    }
  }

  if (minimumReleaseAgeMinutes === null) {
    return null
  }

  if (fact.publishedAt === undefined) {
    return {
      code: 'publish-date-unknown',
      name: pkg.name,
      version: pkg.version,
      detail:
        'the registry reports no publish date, so the version’s age cannot be ' +
        'established. This gate does not pass what it could not check.',
    }
  }

  const publishedAtMs = Date.parse(fact.publishedAt)

  if (Number.isNaN(publishedAtMs)) {
    return {
      code: 'publish-date-unknown',
      name: pkg.name,
      version: pkg.version,
      detail: `the registry’s publish date (${fact.publishedAt}) is unparseable.`,
    }
  }

  const ageMinutes = (now - publishedAtMs) / 60_000

  if (ageMinutes < minimumReleaseAgeMinutes) {
    return {
      code: 'version-too-fresh',
      name: pkg.name,
      version: pkg.version,
      detail:
        `published ${formatMinutes(ageMinutes)} ago, under the ` +
        `${formatMinutes(minimumReleaseAgeMinutes)} floor this repository sets ` +
        `in ${WORKSPACE_MANIFEST}.`,
    }
  }

  return null
}

// ── Configuration & reporting ────────────────────────────────────────────────

/** Renders a minute count at the largest unit that stays readable. */
export function formatMinutes(minutes: number): string {
  const rounded = Math.max(0, Math.round(minutes))

  if (rounded < 60) return `${rounded}min`
  if (rounded < 1440) return `${(rounded / 60).toFixed(1)}h`

  return `${(rounded / 1440).toFixed(1)}d`
}

/**
 * The `minimumReleaseAge` this repository declares, read from the text of
 * `pnpm-workspace.yaml` so the gate and pnpm share one floor.
 *
 * Returns `null` when the key is absent; the caller decides what that means,
 * because a gate with no floor to enforce is a configuration failure rather
 * than a clean tree.
 */
export function parseMinimumReleaseAge(workspaceText: string): number | null {
  for (const line of workspaceText.split('\n')) {
    const match = /^minimumReleaseAge:\s*(\d+)\s*(?:#.*)?$/.exec(line)
    if (match !== null) {
      return Number(match[1])
    }
  }

  return null
}

/** One line per violation, in the shape the entry point prints. */
export function formatViolations(violations: readonly Violation[]): string {
  return violations
    .map((v) => `  [${v.code}] ${v.name}@${v.version} — ${v.detail}`)
    .join('\n')
}

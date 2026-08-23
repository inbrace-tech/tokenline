// ==============================================================================
// Lockfile release-age gate
//
//   node --experimental-strip-types scripts/check-lockfile-release-age.mts \
//     [--base <ref> | --all] [--verbose]
//
// Asks the npm registry two questions about the versions this repository
// resolves, and fails when either answer is wrong:
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
// TypeScript executed directly by Node's type stripping. The `.mts` extension
// is deliberate: it makes the module system unambiguous instead of leaving it
// to be inferred. This is repository tooling — it lives outside `src/`, so it
// never enters the published bundle, and `scripts/tsconfig.json` is what type
// -checks it. It needs the Node in `.nvmrc`, like the rest of the dev toolchain.
// ==============================================================================

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const LOCKFILE = 'pnpm-lock.yaml'
const WORKSPACE_MANIFEST = 'pnpm-workspace.yaml'
const REGISTRY = 'https://registry.npmjs.org'

/** How many packuments to have in flight at once. */
const CONCURRENCY = 8

/** Per-request ceiling, so a hung socket fails fast instead of at job timeout. */
const REQUEST_TIMEOUT_MS = 20_000

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

/** One line per violation, in the shape `main` prints. */
export function formatViolations(violations: readonly Violation[]): string {
  return violations
    .map((v) => `  [${v.code}] ${v.name}@${v.version} — ${v.detail}`)
    .join('\n')
}

// ── I/O half ─────────────────────────────────────────────────────────────────

function fail(message: string): never {
  console.error(`::error::${message}`)
  process.exit(1)
}

/** The packument facts for one package name, keyed by version. */
async function fetchRegistryFacts(
  name: string,
): Promise<Map<string, RegistryFact>> {
  const url = `${REGISTRY}/${name.replace('/', '%2F')}`
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  if (!response.ok) {
    throw new Error(`${url} responded ${String(response.status)}`)
  }

  const packument = (await response.json()) as {
    time?: Record<string, string>
    versions?: Record<string, unknown>
  }

  const time = packument.time ?? {}
  const published = new Set(Object.keys(packument.versions ?? {}))
  const facts = new Map<string, RegistryFact>()

  for (const version of new Set([...Object.keys(time), ...published])) {
    facts.set(version, {
      publishedAt: time[version],
      stillPublished: published.has(version),
    })
  }

  return facts
}

function readRepoFile(repoRoot: string, relativePath: string): string {
  try {
    return readFileSync(join(repoRoot, relativePath), 'utf8')
  } catch {
    fail(`Could not read ${relativePath} in the working tree.`)
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const verbose = argv.includes('--verbose')
  const sweepAll = argv.includes('--all')
  const baseIndex = argv.indexOf('--base')
  const baseRef = baseIndex === -1 ? 'origin/main' : (argv[baseIndex + 1] ?? '')

  if (sweepAll && baseIndex !== -1) {
    fail('`--all` and `--base` are different scopes; pass one or the other.')
  }

  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim()

  const headText = readRepoFile(repoRoot, LOCKFILE)
  const workspaceText = readRepoFile(repoRoot, WORKSPACE_MANIFEST)
  const declaredFloor = parseMinimumReleaseAge(workspaceText)

  // Not a violation but an un-runnable gate: there is no floor to enforce, and
  // reporting a clean tree would misdescribe a configuration that lost its
  // supply-chain quarantine.
  if (declaredFloor === null) {
    fail(
      `No \`minimumReleaseAge\` in ${WORKSPACE_MANIFEST}. That key is this ` +
        'repository’s supply-chain quarantine and the floor this gate backs ' +
        'up; restore it rather than removing the gate.',
    )
  }

  // The sweep asks the takedown question only — see the header.
  const minimumReleaseAgeMinutes = sweepAll ? null : declaredFloor

  let subjects: ResolvedPackage[]
  let scopeLabel: string

  if (sweepAll) {
    subjects = allResolvedVersions(headText)
    scopeLabel = `all ${String(subjects.length)} resolved version(s), takedown check only`
  } else {
    let baseText: string

    try {
      baseText = execFileSync('git', ['show', `${baseRef}:${LOCKFILE}`], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      })
    } catch {
      fail(
        `Could not read ${LOCKFILE} at ${baseRef}. Fetch the base ref ` +
          '(`git fetch origin main`) or pass `--base <ref>` naming a ref this ' +
          'clone has.',
      )
    }

    subjects = addedResolvedVersions(baseText, headText)
    scopeLabel =
      `${String(subjects.length)} newly resolved version(s), ` +
      `floor ${formatMinutes(declaredFloor)}`

    if (subjects.length === 0) {
      console.log(`OK — ${LOCKFILE} resolves nothing that ${baseRef} did not.`)

      return
    }
  }

  console.log(`Checking ${scopeLabel} against the registry.`)

  // One packument answers every version of a package, so the fan-out is over
  // distinct NAMES while the evaluation stays per version.
  const byName = new Map<string, ResolvedPackage[]>()
  for (const pkg of subjects) {
    const bucket = byName.get(pkg.name)
    if (bucket === undefined) byName.set(pkg.name, [pkg])
    else bucket.push(pkg)
  }

  const names = [...byName.keys()]
  const violations: Violation[] = []
  const unreachable: string[] = []
  const now = Date.now()
  let cursor = 0

  async function worker(): Promise<void> {
    while (cursor < names.length) {
      const name = names[cursor++]
      if (name === undefined) return

      let facts: Map<string, RegistryFact>

      try {
        facts = await fetchRegistryFacts(name)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        unreachable.push(`${name} (${reason})`)
        continue
      }

      for (const pkg of byName.get(name) ?? []) {
        const fact = facts.get(pkg.version) ?? {
          publishedAt: undefined,
          stillPublished: false,
        }

        if (verbose) {
          console.log(
            `  ${pkg.name}@${pkg.version} published=${fact.publishedAt ?? 'unknown'} ` +
              `stillPublished=${String(fact.stillPublished)}`,
          )
        }

        const violation = evaluatePackage({
          pkg,
          fact,
          now,
          minimumReleaseAgeMinutes,
        })

        if (violation !== null) violations.push(violation)
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, names.length) }, worker),
  )

  // A gate that reports green when it could not run is the "looks guarded"
  // state, and it is indistinguishable from a satisfied invariant.
  if (unreachable.length > 0) {
    fail(
      `Could not reach the registry for ${String(unreachable.length)} ` +
        `package(s): ${unreachable.join(', ')}. Re-run once the registry is ` +
        'reachable.',
    )
  }

  if (violations.length > 0) {
    console.error(
      `::error::${String(violations.length)} lockfile violation(s):`,
    )
    console.error(formatViolations(violations))
    console.error(
      '\nA `version-absent-from-registry` finding is a takedown until proven ' +
        'otherwise: do not re-resolve around it, establish why the version ' +
        'disappeared. A `version-too-fresh` finding clears itself by waiting.',
    )
    process.exit(1)
  }

  console.log(`OK — ${scopeLabel}: nothing to report.`)
}

await main()

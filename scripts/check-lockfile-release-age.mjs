// ==============================================================================
// Lockfile release-age gate
//
//   node scripts/check-lockfile-release-age.mjs [--base <ref>] [--verbose]
//
// Enforces one invariant over a proposed `pnpm-lock.yaml`: every `name@version`
// the change ADDS must still be published on the registry, and must have been
// published at least `minimumReleaseAge` minutes ago.
//
// WHY, when `pnpm-workspace.yaml` already sets `minimumReleaseAge`
//
// That setting steers RESOLUTION on the machine that runs it. It is the right
// first line — a package published minutes ago simply is not installable — but
// it is a preference of the resolving machine, and a lockfile can reach this
// branch from a machine this repository never configured: a contributor's
// checkout, a fork's CI, a hand-resolved merge conflict, or a Dependabot
// security update, which bypasses the cooldown in `.github/dependabot.yml` by
// design. This gate re-asserts the floor against the artifact that actually
// merges, and reads the number from `pnpm-workspace.yaml` so the two cannot
// drift to different floors.
//
// The registry-absence arm reaches something no age setting can see at all. A
// malicious release gets taken down rather than aged out, so a lockfile pinning
// a version that has DISAPPEARED from the registry is reporting a takedown —
// the highest-signal state observable from outside the registry, and one that
// stays true no matter when the version was published.
//
// WHY ONLY THE DELTA
//
// Versions already on the base branch were checked when they landed and have
// only aged since, so re-checking them buys nothing and costs one registry
// round-trip per package. Scoping to what the change adds keeps the gate
// proportional: a PR that does not touch the lockfile does no network I/O.
//
// Plain `.mjs` on purpose — this is repository tooling, not part of the shipped
// CLI. It never enters `src/`, so it cannot end up in the published bundle, and
// it needs no build step.
// ==============================================================================

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const LOCKFILE = 'pnpm-lock.yaml'
const WORKSPACE_MANIFEST = 'pnpm-workspace.yaml'
const REGISTRY = 'https://registry.npmjs.org'

/** How many packuments to have in flight at once. */
const CONCURRENCY = 8

/** Per-request ceiling, so a hung socket fails fast instead of at job timeout. */
const REQUEST_TIMEOUT_MS = 20_000

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
 *
 * @param {string} lockfileText
 * @returns {Set<string>}
 */
export function parseResolvedVersions(lockfileText) {
  const resolved = new Set()

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
 *
 * @param {string} key
 * @returns {{ name: string, version: string }}
 */
export function splitResolvedKey(key) {
  const separator = key.lastIndexOf('@')

  return { name: key.slice(0, separator), version: key.slice(separator + 1) }
}

/**
 * The entries `headText` resolves that `baseText` did not. A removal is not a
 * finding: only an addition can introduce an artifact this repository did not
 * already trust.
 *
 * @param {string} baseText
 * @param {string} headText
 * @returns {{ name: string, version: string }[]}
 */
export function addedResolvedVersions(baseText, headText) {
  const base = parseResolvedVersions(baseText)

  return [...parseResolvedVersions(headText)]
    .filter((key) => !base.has(key))
    .sort()
    .map(splitResolvedKey)
}

/**
 * The single-package decision. Returns `null` when the package is clean.
 *
 * Absence is reported ahead of age: a taken-down version is the more serious
 * state, and its publish date would otherwise describe something nobody can
 * install.
 *
 * @param {{
 *   pkg: { name: string, version: string },
 *   fact: { publishedAt: string | undefined, stillPublished: boolean },
 *   now: number,
 *   minimumReleaseAgeMinutes: number,
 * }} input
 * @returns {{ code: string, name: string, version: string, detail: string } | null}
 */
export function evaluatePackage(input) {
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

/**
 * Renders a minute count at the largest unit that stays readable.
 *
 * @param {number} minutes
 * @returns {string}
 */
export function formatMinutes(minutes) {
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
 *
 * @param {string} workspaceText
 * @returns {number | null}
 */
export function parseMinimumReleaseAge(workspaceText) {
  for (const line of workspaceText.split('\n')) {
    const match = /^minimumReleaseAge:\s*(\d+)\s*(?:#.*)?$/.exec(line)
    if (match !== null) {
      return Number(match[1])
    }
  }

  return null
}

/**
 * One line per violation, in the shape `main` prints.
 *
 * @param {{ code: string, name: string, version: string, detail: string }[]} violations
 * @returns {string}
 */
export function formatViolations(violations) {
  return violations
    .map((v) => `  [${v.code}] ${v.name}@${v.version} — ${v.detail}`)
    .join('\n')
}

// ── I/O half ─────────────────────────────────────────────────────────────────

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  console.error(`::error::${message}`)
  process.exit(1)
}

/**
 * The packument facts for one package name, keyed by version.
 *
 * @param {string} name
 * @returns {Promise<Map<string, { publishedAt: string | undefined, stillPublished: boolean }>>}
 */
async function fetchRegistryFacts(name) {
  const url = `${REGISTRY}/${name.replace('/', '%2F')}`
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  if (!response.ok) {
    throw new Error(`${url} responded ${response.status}`)
  }

  const packument = await response.json()
  const time = packument.time ?? {}
  const published = new Set(Object.keys(packument.versions ?? {}))
  const facts = new Map()

  for (const version of new Set([...Object.keys(time), ...published])) {
    facts.set(version, {
      publishedAt: time[version],
      stillPublished: published.has(version),
    })
  }

  return facts
}

async function main() {
  const argv = process.argv.slice(2)
  const verbose = argv.includes('--verbose')
  const baseIndex = argv.indexOf('--base')
  const baseRef = baseIndex === -1 ? 'origin/main' : argv[baseIndex + 1]

  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim()

  let baseText
  try {
    baseText = execFileSync('git', ['show', `${baseRef}:${LOCKFILE}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch {
    fail(
      `Could not read ${LOCKFILE} at ${baseRef}. Fetch the base ref ` +
        '(`git fetch origin main`) or pass `--base <ref>` naming a ref this clone has.',
    )
  }

  let headText
  try {
    headText = readFileSync(join(repoRoot, LOCKFILE), 'utf8')
  } catch {
    fail(`Could not read ${LOCKFILE} in the working tree.`)
  }

  let workspaceText
  try {
    workspaceText = readFileSync(join(repoRoot, WORKSPACE_MANIFEST), 'utf8')
  } catch {
    fail(`Could not read ${WORKSPACE_MANIFEST}.`)
  }

  const minimumReleaseAgeMinutes = parseMinimumReleaseAge(workspaceText)

  // Not a violation but an un-runnable gate: there is no floor to enforce, and
  // reporting a clean tree would misdescribe a configuration that lost its
  // supply-chain quarantine.
  if (minimumReleaseAgeMinutes === null) {
    fail(
      `No \`minimumReleaseAge\` in ${WORKSPACE_MANIFEST}. That key is this ` +
        'repository’s supply-chain quarantine and the floor this gate enforces; ' +
        'restore it rather than removing the gate.',
    )
  }

  const added = addedResolvedVersions(baseText, headText)

  if (added.length === 0) {
    console.log(`OK — ${LOCKFILE} resolves nothing that ${baseRef} did not.`)

    return
  }

  console.log(
    `Checking ${added.length} newly resolved version(s) against the registry, ` +
      `floor ${formatMinutes(minimumReleaseAgeMinutes)}.`,
  )

  // One packument answers every version of a package, so the fan-out is over
  // distinct NAMES while the evaluation stays per version.
  const byName = new Map()
  for (const pkg of added) {
    const bucket = byName.get(pkg.name)
    if (bucket === undefined) byName.set(pkg.name, [pkg])
    else bucket.push(pkg)
  }

  const names = [...byName.keys()]
  const violations = []
  const unreachable = []
  const now = Date.now()
  let cursor = 0

  async function worker() {
    while (cursor < names.length) {
      const name = names[cursor++]

      let facts
      try {
        facts = await fetchRegistryFacts(name)
      } catch (error) {
        unreachable.push(
          `${name} (${error instanceof Error ? error.message : error})`,
        )
        continue
      }

      for (const pkg of byName.get(name)) {
        const fact = facts.get(pkg.version) ?? {
          publishedAt: undefined,
          stillPublished: false,
        }

        if (verbose) {
          console.log(
            `  ${pkg.name}@${pkg.version} published=${fact.publishedAt ?? 'unknown'} ` +
              `stillPublished=${fact.stillPublished}`,
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
      `Could not reach the registry for ${unreachable.length} package(s): ` +
        `${unreachable.join(', ')}. Re-run once the registry is reachable.`,
    )
  }

  if (violations.length > 0) {
    console.error(
      `::error::${violations.length} lockfile release-age violation(s):`,
    )
    console.error(formatViolations(violations))
    console.error(
      '\nA `version-absent-from-registry` finding is a takedown until proven ' +
        'otherwise: do not re-resolve around it, establish why the version ' +
        'disappeared. A `version-too-fresh` finding clears itself by waiting.',
    )
    process.exit(1)
  }

  console.log(
    `OK — all ${added.length} newly resolved version(s) are still published ` +
      'and past the age floor.',
  )
}

// Run only when invoked directly, so the spec can import the pure helpers.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    fail(
      `Gate failed unexpectedly: ${error instanceof Error ? error.message : error}`,
    )
  })
}

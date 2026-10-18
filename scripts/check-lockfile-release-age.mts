// ==============================================================================
// Lockfile release-age gate — entry point (I/O half)
//
//   node --experimental-strip-types scripts/check-lockfile-release-age.mts \
//     [--base <ref> | --all] [--verbose]
//
// Asks the npm registry whether the versions `pnpm-lock.yaml` resolves are still
// published and, on a pull request, old enough. What each mode asks, and why,
// is written up in the pure half, `check-lockfile-release-age.logic.mts`. This
// file only gathers the inputs (argv, git, the working tree, the registry),
// hands them to that half, and turns its answer into an exit code.
//
// Every failure to gather an input FAILS the gate rather than skipping it: an
// unreadable lockfile, a missing `minimumReleaseAge`, an unreachable registry or
// anything unexpected. A gate that reports green when it could not run is
// indistinguishable from a satisfied invariant.
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

import type {
  RegistryFact,
  ResolvedPackage,
  Violation,
} from './check-lockfile-release-age.logic.mts'
import {
  addedResolvedVersions,
  allResolvedVersions,
  evaluatePackage,
  formatMinutes,
  formatViolations,
  LOCKFILE,
  parseCliArgs,
  parseMinimumReleaseAge,
  WORKSPACE_MANIFEST,
} from './check-lockfile-release-age.logic.mts'

const REGISTRY = 'https://registry.npmjs.org'

/** How many packuments to have in flight at once. */
const CONCURRENCY = 8

/** Per-request ceiling, so a hung socket fails fast instead of at job timeout. */
const REQUEST_TIMEOUT_MS = 20_000

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
  const parsed = parseCliArgs(process.argv.slice(2))
  if (!parsed.ok) {
    fail(parsed.error)
  }
  const { options } = parsed

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

  // The sweep asks the takedown question only — see the pure half.
  const minimumReleaseAgeMinutes =
    options.mode === 'sweep' ? null : declaredFloor

  let subjects: ResolvedPackage[]
  let scopeLabel: string

  if (options.mode === 'sweep') {
    subjects = allResolvedVersions(headText)
    scopeLabel = `all ${String(subjects.length)} resolved version(s), takedown check only`
  } else {
    let baseText: string

    try {
      baseText = execFileSync(
        'git',
        ['show', `${options.baseRef}:${LOCKFILE}`],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      )
    } catch {
      fail(
        `Could not read ${LOCKFILE} at ${options.baseRef}. Fetch the base ref ` +
          '(`git fetch origin main`) or pass `--base <ref>` naming a ref this ' +
          'clone has.',
      )
    }

    subjects = addedResolvedVersions(baseText, headText)
    scopeLabel =
      `${String(subjects.length)} newly resolved version(s), ` +
      `floor ${formatMinutes(declaredFloor)}`

    if (subjects.length === 0) {
      console.log(
        `OK — ${LOCKFILE} resolves nothing that ${options.baseRef} did not.`,
      )

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

        if (options.verbose) {
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

// The spec imports only the pure half, so this module is never loaded by the
// test runner and can run unconditionally. Any unexpected throw (a `git` that
// cannot run, a bug) still fails the gate, with a CI annotation instead of a
// bare stack trace.
main().catch((error: unknown) => {
  fail(
    'Lockfile release-age gate failed unexpectedly: ' +
      (error instanceof Error ? error.message : String(error)),
  )
})

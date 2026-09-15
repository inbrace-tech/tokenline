// ==============================================================================
// Lockfile release-age gate — spec.
//
// The `should-catch-*` cases are what make this gate more than a green tick: a
// checker that never fires is indistinguishable from one whose subject moved
// away underneath it.
//
// The final block runs the parser against the LIVE `pnpm-lock.yaml` rather than
// a fixture. Its job is not to re-assert what the fixtures prove but to
// establish that the lockfile still has the shape the parser looks for: a pnpm
// format change would leave every fixture case green while the gate parsed an
// empty set and reported a clean delta forever.
//
// It imports only the pure half (`.logic.mts`). The entry point runs `main()` —
// git, the registry, `process.exit` — the moment it is loaded, so keeping it out
// of the test runner is a property of the file layout rather than of a runtime
// guard that can be forgotten.
//
// Imports the vitest globals explicitly rather than relying on `globals: true`,
// since this file is type-checked by `scripts/tsconfig.json`, which does not
// pull in `vitest/globals`.
// ==============================================================================

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  addedResolvedVersions,
  allResolvedVersions,
  DEFAULT_BASE_REF,
  evaluatePackage,
  formatMinutes,
  formatViolations,
  parseCliArgs,
  parseMinimumReleaseAge,
  parseResolvedVersions,
  splitResolvedKey,
} from './check-lockfile-release-age.logic.mts'

const BASE_LOCKFILE = [
  'lockfileVersion: 9.0',
  '',
  'importers:',
  '',
  '  .:',
  '    devDependencies:',
  '      example:',
  '        specifier: 1.0.0',
  '        version: 1.0.0',
  '',
  'packages:',
  '',
  '  example@1.0.0:',
  '    resolution: {integrity: sha512-aaa}',
  '',
  "  '@scope/example@2.0.0':",
  '    resolution: {integrity: sha512-bbb}',
  '',
  'snapshots:',
  '',
  "  '@scope/example@2.0.0(example@1.0.0)':",
  '    dependencies:',
  '      example: 1.0.0',
  '',
].join('\n')

const HEAD_LOCKFILE = BASE_LOCKFILE.replace(/example@1\.0\.0/g, 'example@1.0.1')

const FLOOR_MINUTES = 4320
const NOW = Date.parse('2026-08-20T12:00:00.000Z')

describe('parseCliArgs', () => {
  it('defaults to the delta mode against origin/main', () => {
    expect(parseCliArgs([])).toEqual({
      ok: true,
      options: { mode: 'delta', baseRef: DEFAULT_BASE_REF, verbose: false },
    })
  })

  it('reads --base and --verbose in either order', () => {
    const expected = {
      ok: true,
      options: { mode: 'delta', baseRef: 'abc123', verbose: true },
    }

    expect(parseCliArgs(['--base', 'abc123', '--verbose'])).toEqual(expected)
    expect(parseCliArgs(['--verbose', '--base', 'abc123'])).toEqual(expected)
  })

  it('selects the sweep mode with --all', () => {
    expect(parseCliArgs(['--all'])).toEqual({
      ok: true,
      options: { mode: 'sweep', verbose: false },
    })
  })

  it('should-catch: --all together with --base', () => {
    expect(parseCliArgs(['--all', '--base', 'abc123']).ok).toBe(false)
  })

  it('should-catch: --base with no value', () => {
    // As the last argument, `--base` used to become an empty ref, and
    // `git show :pnpm-lock.yaml` reads the index — the head itself — so the
    // gate reported "nothing added" on every PR.
    expect(parseCliArgs(['--base']).ok).toBe(false)
  })

  it('should-catch: --base with an empty value', () => {
    // What `--base "${BASE_SHA}"` becomes if the workflow ever loses the SHA.
    expect(parseCliArgs(['--base', '']).ok).toBe(false)
    expect(parseCliArgs(['--base', '  ']).ok).toBe(false)
  })

  it('should-catch: --base swallowing the next flag', () => {
    expect(parseCliArgs(['--base', '--verbose']).ok).toBe(false)
  })

  it('should-catch: an unknown argument instead of falling back to delta', () => {
    // A typo of `--all` in the scheduled sweep must not quietly become a delta
    // run that checks nothing.
    expect(parseCliArgs(['--al']).ok).toBe(false)
  })
})

describe('parseResolvedVersions', () => {
  it('reads a plain entry and a scoped entry from the packages block', () => {
    const resolved = parseResolvedVersions(BASE_LOCKFILE)

    expect(resolved.has('example@1.0.0')).toBe(true)
    expect(resolved.has('@scope/example@2.0.0')).toBe(true)
  })

  it('collapses a peer-suffixed snapshot key onto the published artifact', () => {
    const scoped = [...parseResolvedVersions(BASE_LOCKFILE)].filter((key) =>
      key.startsWith('@scope/example@'),
    )

    expect(scoped).toEqual(['@scope/example@2.0.0'])
  })

  it('ignores the importers block, whose version lines sit deeper', () => {
    // `      version: 1.0.0` under `importers:` echoes a specifier; matching it
    // would invent a package named `version`.
    expect([...parseResolvedVersions(BASE_LOCKFILE)]).not.toContain(
      'version@1.0.0',
    )
  })
})

describe('splitResolvedKey', () => {
  it('splits a scoped name on the last separator, not the first', () => {
    expect(splitResolvedKey('@scope/example@2.0.0')).toEqual({
      name: '@scope/example',
      version: '2.0.0',
    })
  })

  it('keeps a prerelease version whole', () => {
    expect(splitResolvedKey('example@1.0.0-rc.1')).toEqual({
      name: 'example',
      version: '1.0.0-rc.1',
    })
  })
})

describe('allResolvedVersions', () => {
  it('returns every resolution, which is what the --all sweep walks', () => {
    // The sweep's whole point is that it does not depend on a base ref: a
    // version pulled from the registry long after it merged is added by no
    // pull request, so only a full pass over the lockfile can see it.
    expect(allResolvedVersions(BASE_LOCKFILE)).toEqual([
      { name: '@scope/example', version: '2.0.0' },
      { name: 'example', version: '1.0.0' },
    ])
  })
})

describe('addedResolvedVersions', () => {
  it('reports only what the head adds', () => {
    const added = addedResolvedVersions(BASE_LOCKFILE, HEAD_LOCKFILE)

    expect(added).toContainEqual({ name: 'example', version: '1.0.1' })
    expect(added).not.toContainEqual({ name: 'example', version: '1.0.0' })
  })

  it('reports nothing when the lockfile is untouched', () => {
    expect(addedResolvedVersions(BASE_LOCKFILE, BASE_LOCKFILE)).toEqual([])
  })

  it('does not treat a removal as a finding', () => {
    expect(
      addedResolvedVersions(HEAD_LOCKFILE, BASE_LOCKFILE),
    ).not.toContainEqual({
      name: 'example',
      version: '1.0.1',
    })
  })
})

describe('evaluatePackage', () => {
  const clean = {
    publishedAt: '2026-01-10T00:00:00.000Z',
    stillPublished: true,
  }

  it('passes a version published well past the floor', () => {
    expect(
      evaluatePackage({
        pkg: { name: 'example', version: '1.0.0' },
        fact: clean,
        now: NOW,
        minimumReleaseAgeMinutes: FLOOR_MINUTES,
      }),
    ).toBeNull()
  })

  it('should-catch: a version published inside the floor', () => {
    const violation = evaluatePackage({
      pkg: { name: 'example', version: '1.0.1' },
      fact: {
        publishedAt: new Date(NOW - 90 * 60_000).toISOString(),
        stillPublished: true,
      },
      now: NOW,
      minimumReleaseAgeMinutes: FLOOR_MINUTES,
    })

    expect(violation?.code).toBe('version-too-fresh')
  })

  it('should-catch: a version the registry no longer lists', () => {
    // The arm no age setting can reach: a taken-down version ages past every
    // floor while staying uninstallable and untrustworthy.
    const violation = evaluatePackage({
      pkg: { name: 'example', version: '1.0.1' },
      fact: { publishedAt: '2026-01-10T00:00:00.000Z', stillPublished: false },
      now: NOW,
      minimumReleaseAgeMinutes: FLOOR_MINUTES,
    })

    expect(violation?.code).toBe('version-absent-from-registry')
  })

  it('reports absence ahead of age when a version is both fresh and gone', () => {
    const violation = evaluatePackage({
      pkg: { name: 'example', version: '1.0.1' },
      fact: {
        publishedAt: new Date(NOW - 90 * 60_000).toISOString(),
        stillPublished: false,
      },
      now: NOW,
      minimumReleaseAgeMinutes: FLOOR_MINUTES,
    })

    expect(violation?.code).toBe('version-absent-from-registry')
  })

  it('should-catch: a published version the registry gives no date for', () => {
    const violation = evaluatePackage({
      pkg: { name: 'example', version: '1.0.1' },
      fact: { publishedAt: undefined, stillPublished: true },
      now: NOW,
      minimumReleaseAgeMinutes: FLOOR_MINUTES,
    })

    expect(violation?.code).toBe('publish-date-unknown')
  })

  it('should-catch: an unparseable publish date', () => {
    const violation = evaluatePackage({
      pkg: { name: 'example', version: '1.0.1' },
      fact: { publishedAt: 'not-a-date', stillPublished: true },
      now: NOW,
      minimumReleaseAgeMinutes: FLOOR_MINUTES,
    })

    expect(violation?.code).toBe('publish-date-unknown')
  })

  it('sweep mode still reports a taken-down version', () => {
    // `minimumReleaseAgeMinutes: null` is what `--all` passes. The takedown
    // question is the one the PR gate structurally cannot ask about an entry
    // that merged weeks ago, so it must survive the sweep's narrower scope.
    const violation = evaluatePackage({
      pkg: { name: 'example', version: '1.0.1' },
      fact: { publishedAt: '2026-01-10T00:00:00.000Z', stillPublished: false },
      now: NOW,
      minimumReleaseAgeMinutes: null,
    })

    expect(violation?.code).toBe('version-absent-from-registry')
  })

  it('sweep mode does not re-flag a fresh version as too fresh', () => {
    // Every entry already on the branch passed the floor when it merged;
    // re-flagging one that merged yesterday would make the daily sweep noise.
    expect(
      evaluatePackage({
        pkg: { name: 'example', version: '1.0.1' },
        fact: {
          publishedAt: new Date(NOW - 90 * 60_000).toISOString(),
          stillPublished: true,
        },
        now: NOW,
        minimumReleaseAgeMinutes: null,
      }),
    ).toBeNull()
  })

  it('sweep mode tolerates a missing publish date', () => {
    // The date is only needed to answer the age question, which the sweep does
    // not ask — so an old package with thin metadata must not fail it.
    expect(
      evaluatePackage({
        pkg: { name: 'example', version: '1.0.1' },
        fact: { publishedAt: undefined, stillPublished: true },
        now: NOW,
        minimumReleaseAgeMinutes: null,
      }),
    ).toBeNull()
  })

  it('passes a version that clears the floor by a minute', () => {
    expect(
      evaluatePackage({
        pkg: { name: 'example', version: '1.0.1' },
        fact: {
          publishedAt: new Date(
            NOW - (FLOOR_MINUTES + 1) * 60_000,
          ).toISOString(),
          stillPublished: true,
        },
        now: NOW,
        minimumReleaseAgeMinutes: FLOOR_MINUTES,
      }),
    ).toBeNull()
  })
})

describe('parseMinimumReleaseAge', () => {
  it('reads the key from the workspace manifest', () => {
    expect(parseMinimumReleaseAge('minimumReleaseAge: 4320\n')).toBe(4320)
  })

  it('reads it past a trailing comment', () => {
    expect(parseMinimumReleaseAge('minimumReleaseAge: 4320 # 3 days\n')).toBe(
      4320,
    )
  })

  it('does not mistake a longer sibling key for the floor', () => {
    expect(
      parseMinimumReleaseAge('minimumReleaseAgeStrict: false\n'),
    ).toBeNull()
  })

  it('reports absence rather than defaulting to zero', () => {
    // A silent 0 would be a floor no version can fail — the gate's own
    // "looks guarded" state.
    expect(parseMinimumReleaseAge('allowBuilds:\n  esbuild: true\n')).toBeNull()
  })
})

describe('formatMinutes', () => {
  it('renders each unit at its own scale', () => {
    expect(formatMinutes(45)).toBe('45min')
    expect(formatMinutes(720)).toBe('12.0h')
    expect(formatMinutes(4320)).toBe('3.0d')
  })
})

describe('formatViolations', () => {
  it('names the code, the package and the reason on one line', () => {
    const rendered = formatViolations([
      {
        code: 'version-too-fresh',
        name: 'example',
        version: '1.0.1',
        detail: 'too new.',
      },
    ])

    expect(rendered).toContain('version-too-fresh')
    expect(rendered).toContain('example@1.0.1')
  })
})

describe('against the live repository', () => {
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim()

  it('parses the real lockfile into a non-trivial set of resolutions', () => {
    const resolved = parseResolvedVersions(
      readFileSync(join(repoRoot, 'pnpm-lock.yaml'), 'utf8'),
    )

    // A pnpm lockfile-format change is the failure this guards: the parser would
    // match nothing, the delta would be empty forever, and the gate would report
    // clean on every PR.
    expect(resolved.size).toBeGreaterThan(50)
    expect([...resolved].every((key) => key.includes('@'))).toBe(true)
  })

  it('finds the floor the workspace manifest actually declares', () => {
    const declared = parseMinimumReleaseAge(
      readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'),
    )

    expect(declared).toBeGreaterThan(0)
  })
})

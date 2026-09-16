// ==============================================================================
// Changeset summary gate — entry point (I/O half)
//
//   node --experimental-strip-types scripts/check-changeset-size.mts [--verbose]
//
// Fails a pending `.changeset/*.md` whose summary is missing, runs past
// `MAX_SUMMARY_CHARS`, or spans more than one line. Why the summary is one
// line is written up in the pure half, `check-changeset-size.logic.mts`.
//
// There is deliberately no "found nothing" guard: between releases, and on most
// pull requests, `.changeset/` holds no pending changeset, and that is the
// ordinary state rather than a lost subject.
//
// Repository tooling, executed by Node's type stripping and type-checked by
// `scripts/tsconfig.json`. It needs no `pnpm install`.
// ==============================================================================

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ChangesetFile } from './check-changeset-size.logic.mts'
import {
  formatChangesetViolations,
  isChangeset,
  MAX_SUMMARY_CHARS,
  scanChangesets,
} from './check-changeset-size.logic.mts'

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim()

function readPending(): ChangesetFile[] {
  return readdirSync(join(repoRoot, '.changeset'))
    .map((name) => `.changeset/${name}`)
    .filter(isChangeset)
    .map((path) => ({
      path,
      source: readFileSync(join(repoRoot, path), 'utf8'),
    }))
}

const files = readPending()
const result = scanChangesets(files)

if (process.argv.includes('--verbose')) {
  for (const file of files) console.log(`  ${file.path}`)
}

if (result.violations.length > 0) {
  console.error(
    `::error::${result.violations.length} changeset(s) whose summary is prose rather than a line:`,
  )
  console.error(formatChangesetViolations(result.violations))
  console.error(
    '\nA changeset summary becomes one line of CHANGELOG.md and one line of the GitHub Release ' +
      'body. Put the reasoning in the pull request; the changelog line links to it. ' +
      `Ceiling: ${MAX_SUMMARY_CHARS} characters, one line.`,
  )
  process.exit(1)
}

console.log(
  `Changeset summaries OK — ${result.scannedCount} pending, longest ${result.longest} of ` +
    `${MAX_SUMMARY_CHARS} characters.`,
)

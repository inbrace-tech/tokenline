// ==============================================================================
// Changeset summary gate — pure half
//
// A changeset's summary becomes one bullet of CHANGELOG.md and one bullet of the
// GitHub Release body. Its reader is deciding whether to upgrade, not reviewing
// the change. So the summary is ONE line saying what a user of the package
// receives. The reasoning (the measurements, the rejected alternatives, how it
// was tested) belongs in the pull request, and `@changesets/changelog-github`
// renders a link to that pull request beside every line.
//
// WHY A GATE RATHER THAN A CONVENTION
// -----------------------------------
// A changeset is written at the end of a piece of work by whoever holds the
// whole reasoning, which is exactly when writing all of it down feels right.
// The convention alone fails under the conditions it exists for: the sibling
// repository inbrace-tech/inbrace-ai-harness followed it in none of its first
// 166 entries, and a release there produced a 149,009-character body that
// GitHub rejected against its 125,000-character cap after the tag was pushed.
//
// It gates nothing but `.changeset/*.md`. Pull request bodies, commit messages
// and issues have no ceiling.
//
// Pure: no I/O, no process access. The entry point (`check-changeset-size.mts`)
// reads the files and turns the result into an exit code.
// ==============================================================================

/** One changeset file, as the checker sees it. */
export type ChangesetFile = {
  /** Repo-relative, POSIX-separated. */
  readonly path: string
  readonly source: string
}

export type ChangesetViolationKind =
  'summary-too-long' | 'summary-multi-line' | 'no-summary'

export type ChangesetViolation = {
  readonly path: string
  readonly kind: ChangesetViolationKind
  readonly message: string
  /** Summary length in characters, 0 where there is no summary. */
  readonly length: number
}

export type ChangesetScanResult = {
  readonly violations: ReadonlyArray<ChangesetViolation>
  readonly scannedCount: number
  readonly longest: number
}

/**
 * The ceiling, in characters, on a changeset's summary.
 *
 * A conventional-commit subject is conventionally kept under 72 characters;
 * 200 leaves room for a subject plus a short qualifying clause and still
 * refuses a paragraph, which is the shape that makes a changelog unreadable.
 */
export const MAX_SUMMARY_CHARS = 200

/** Everything after the closing `---` of the YAML frontmatter. */
export function summaryOf(source: string): string {
  const withoutBom = source.replace(/^\uFEFF/, '')
  if (!withoutBom.startsWith('---')) return withoutBom.trim()
  const end = withoutBom.indexOf('\n---', 3)
  if (end === -1) return ''
  const afterFence = withoutBom.indexOf('\n', end + 1)
  return afterFence === -1 ? '' : withoutBom.slice(afterFence + 1).trim()
}

/**
 * The summary as `@changesets/changelog-github` renders it: without the
 * `pr:`, `commit:` and `author:` override lines it reads and strips (same
 * patterns as its `getReleaseLine`). Those lines are metadata, not prose.
 */
export function renderedSummaryOf(source: string): string {
  return summaryOf(source)
    .replace(/^\s*(?:pr|pull|pull\s+request):\s*#?(\d+)/im, '')
    .replace(/^\s*commit:\s*([^\s]+)/im, '')
    .replace(/^\s*(?:author|user):\s*@?([^\s]+)/gim, '')
    .trim()
}

/** `README.md` is changesets' own documentation and carries no frontmatter. */
export function isChangeset(path: string): boolean {
  return (
    path.startsWith('.changeset/') &&
    path.endsWith('.md') &&
    !path.endsWith('/README.md')
  )
}

export function scanChangesets(
  files: ReadonlyArray<ChangesetFile>,
): ChangesetScanResult {
  const violations: ChangesetViolation[] = []
  let longest = 0

  for (const file of files) {
    const summary = renderedSummaryOf(file.source)
    longest = Math.max(longest, summary.length)

    if (summary === '') {
      violations.push({
        path: file.path,
        kind: 'no-summary',
        length: 0,
        message:
          'give this changeset a summary — one line saying what a user of the package receives',
      })
      continue
    }

    // The renderer turns the first line into the bullet and indents every
    // further line beneath it, so a hard-wrapped summary is prose even when it
    // fits the ceiling and has no blank line.
    if (summary.includes('\n')) {
      violations.push({
        path: file.path,
        kind: 'summary-multi-line',
        length: summary.length,
        message:
          'keep the summary to a single line — the reasoning goes in the pull request, ' +
          'which the changelog line links to',
      })
      continue
    }

    if (summary.length > MAX_SUMMARY_CHARS) {
      violations.push({
        path: file.path,
        kind: 'summary-too-long',
        length: summary.length,
        message:
          `shorten the summary to ${MAX_SUMMARY_CHARS} characters or fewer — it is ` +
          `${summary.length}. State what changed for a user and leave the why to the pull request`,
      })
    }
  }

  return { violations, scannedCount: files.length, longest }
}

/** Render violations for a terminal, in path order. */
export function formatChangesetViolations(
  violations: ReadonlyArray<ChangesetViolation>,
): string {
  return [...violations]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(
      (violation) =>
        `  ${violation.path}\n    ${violation.kind}: ${violation.message}`,
    )
    .join('\n')
}

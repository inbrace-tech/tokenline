// ==============================================================================
// Changeset summary gate — spec.
//
// Imports only the pure half (`.logic.mts`): the entry point reads the working
// tree and calls `process.exit` the moment it is loaded.
//
// Imports the vitest globals explicitly rather than relying on `globals: true`,
// since this file is type-checked by `scripts/tsconfig.json`, which does not
// pull in `vitest/globals`.
// ==============================================================================

import { describe, expect, it } from 'vitest'

import {
  formatChangesetViolations,
  isChangeset,
  MAX_SUMMARY_CHARS,
  scanChangesets,
  summaryOf,
} from './check-changeset-size.logic.mts'

const frontmatter = '---\n"@inbrace-tech/tokenline": patch\n---\n\n'

function changeset(summary: string, path = '.changeset/a.md') {
  return { path, source: `${frontmatter}${summary}\n` }
}

describe('summaryOf', () => {
  it('returns the text after the frontmatter, trimmed', () => {
    expect(summaryOf(`${frontmatter}fix: a line\n`)).toBe('fix: a line')
  })

  it('returns an empty summary for an unclosed frontmatter', () => {
    expect(summaryOf('---\n"@inbrace-tech/tokenline": patch\n')).toBe('')
  })

  it('strips a byte-order mark before reading the fence', () => {
    expect(summaryOf(`\uFEFF${frontmatter}fix: a line`)).toBe('fix: a line')
  })
})

describe('isChangeset', () => {
  it('accepts a markdown file under .changeset/', () => {
    expect(isChangeset('.changeset/quiet-lions.md')).toBe(true)
  })

  it('rejects the changesets README and non-markdown files', () => {
    expect(isChangeset('.changeset/README.md')).toBe(false)
    expect(isChangeset('.changeset/config.json')).toBe(false)
  })
})

describe('scanChangesets', () => {
  it('passes a one-line summary and reports its length as the longest', () => {
    const result = scanChangesets([
      changeset('fix: read resets_at as epoch seconds'),
    ])

    expect(result.violations).toEqual([])
    expect(result.scannedCount).toBe(1)
    expect(result.longest).toBe('fix: read resets_at as epoch seconds'.length)
  })

  it('passes a summary exactly at the ceiling', () => {
    const result = scanChangesets([changeset('x'.repeat(MAX_SUMMARY_CHARS))])

    expect(result.violations).toEqual([])
  })

  it('should catch a summary one character past the ceiling', () => {
    const result = scanChangesets([
      changeset('x'.repeat(MAX_SUMMARY_CHARS + 1)),
    ])

    expect(result.violations.map((v) => v.kind)).toEqual(['summary-too-long'])
    expect(result.violations[0]?.length).toBe(MAX_SUMMARY_CHARS + 1)
  })

  it('should catch a short summary that carries a second paragraph', () => {
    const result = scanChangesets([
      changeset('fix: a line\n\nAnd the reasoning.'),
    ])

    expect(result.violations.map((v) => v.kind)).toEqual([
      'summary-multi-paragraph',
    ])
  })

  it('should catch a changeset with no summary', () => {
    const result = scanChangesets([changeset('')])

    expect(result.violations.map((v) => v.kind)).toEqual(['no-summary'])
  })

  it('reports nothing for an empty .changeset/ directory', () => {
    expect(scanChangesets([])).toEqual({
      violations: [],
      scannedCount: 0,
      longest: 0,
    })
  })
})

describe('formatChangesetViolations', () => {
  it('lists violations in path order', () => {
    const { violations } = scanChangesets([
      changeset('', '.changeset/b.md'),
      changeset('', '.changeset/a.md'),
    ])

    const rendered = formatChangesetViolations(violations)

    expect(rendered.indexOf('.changeset/a.md')).toBeLessThan(
      rendered.indexOf('.changeset/b.md'),
    )
  })
})

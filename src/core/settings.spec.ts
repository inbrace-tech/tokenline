import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readSettings } from './settings'

// readSettings is the first link in the settings.json patching contract (#5).
// It has four branches, all covered here: an absent file (exists: false), an
// empty/whitespace file (empty settings, raw preserved), a valid JSON file
// (parsed data + raw), and invalid JSON (data: null) — the last so callers
// never clobber a file they can't understand.
//
// This spec doubles as the pattern for the fuller contract tests: drive real
// files under a throwaway temp dir and clean up after each case, so no test
// ever touches the developer's real ~/.claude/settings.json.
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tokenline-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

it('reports a missing settings file as non-existent, with empty data', () => {
  const result = readSettings(join(dir, 'settings.json'))

  expect(result.exists).toBe(false)
  expect(result.data).toEqual({})
})

it('refuses to parse invalid JSON, returning data: null (never clobber)', () => {
  const file = join(dir, 'settings.json')
  writeFileSync(file, '{ not valid json')

  const result = readSettings(file)

  expect(result.exists).toBe(true)
  expect(result.data).toBeNull()
})

it('treats a whitespace-only file as empty settings, preserving the raw text', () => {
  const file = join(dir, 'settings.json')
  writeFileSync(file, '   \n  ')

  const result = readSettings(file)

  expect(result.exists).toBe(true)
  expect(result.data).toEqual({})
  expect(result.raw).toBe('   \n  ')
})

it('parses a valid settings file, exposing both the data and its raw text', () => {
  const file = join(dir, 'settings.json')
  const settings = {
    statusLine: { type: 'command', command: 'bash tokenline.sh' },
  }
  const raw = JSON.stringify(settings)
  writeFileSync(file, raw)

  const result = readSettings(file)

  expect(result.exists).toBe(true)
  expect(result.data).toEqual(settings)
  expect(result.raw).toBe(raw)
})

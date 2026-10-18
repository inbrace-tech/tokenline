import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Options } from '../shared/types'
import { cmdUninstall } from './uninstall'

// cmdUninstall resolves its targets from os.homedir() (global scope). Point
// homedir at a throwaway temp dir so no case ever touches the developer's real
// ~/.claude. A module mock is used instead of stubbing $HOME because homedir()
// reads the process environment natively, which a stubbed process.env may not
// reach in every vitest pool.
const fake = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>()
  return { ...os, homedir: () => fake.home }
})

const opts = (o: Partial<Options> = {}): Options => ({
  _: ['uninstall'],
  targetCli: 'claude',
  dir: null,
  global: true,
  dryRun: false,
  force: false,
  purge: false,
  subagents: true,
  help: false,
  version: false,
  unknown: [],
  ...o,
})

let claude: string
let settingsPath: string
let scriptPath: string
let log: string

const ours = {
  statusLine: {
    type: 'command',
    command: 'bash /home/u/.claude/tokenline.sh',
    refreshInterval: 1,
  },
  subagentStatusLine: {
    type: 'command',
    command: 'bash /home/u/.claude/tokenline.sh',
  },
}

const writeSettings = (data: unknown): string => {
  const raw = JSON.stringify(data, null, 2) + '\n'
  writeFileSync(settingsPath, raw)
  return raw
}
const readJson = (): unknown => JSON.parse(readFileSync(settingsPath, 'utf8'))

beforeEach(() => {
  fake.home = mkdtempSync(join(tmpdir(), 'tokenline-'))
  claude = join(fake.home, '.claude')
  mkdirSync(claude)
  settingsPath = join(claude, 'settings.json')
  scriptPath = join(claude, 'tokenline.sh')
  writeFileSync(scriptPath, '#!/usr/bin/env bash\n')
  log = ''
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    log += a.join(' ') + '\n'
  })
  process.exitCode = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
  rmSync(fake.home, { recursive: true, force: true })
})

it('removes both tokenline blocks, backs up first, and keeps unrelated keys', () => {
  const before = writeSettings({ ...ours, theme: 'dark', model: 'opus' })

  cmdUninstall(opts())

  expect(readJson()).toEqual({ theme: 'dark', model: 'opus' })
  expect(readFileSync(`${settingsPath}.bak`, 'utf8')).toBe(before)
  expect(log).toContain('removed statusLine + subagentStatusLine')
  expect(existsSync(scriptPath)).toBe(true)
  expect(process.exitCode).toBeUndefined()
})

it('removes only the statusLine when that is the only tokenline block', () => {
  writeSettings({ statusLine: ours.statusLine, theme: 'dark' })

  cmdUninstall(opts())

  expect(readJson()).toEqual({ theme: 'dark' })
  expect(log).toContain('removed statusLine from')
})

it("leaves another tool's subagentStatusLine in place", () => {
  const other = { type: 'command', command: 'bash other.sh' }
  writeSettings({ statusLine: ours.statusLine, subagentStatusLine: other })

  cmdUninstall(opts())

  expect(readJson()).toEqual({ subagentStatusLine: other })
})

it('leaves a foreign statusLine untouched, without writing or backing up', () => {
  const before = writeSettings({
    statusLine: { type: 'command', command: 'bash other.sh' },
  })

  cmdUninstall(opts())

  expect(readFileSync(settingsPath, 'utf8')).toBe(before)
  expect(existsSync(`${settingsPath}.bak`)).toBe(false)
  expect(log).toContain('No tokenline statusLine')
  expect(process.exitCode).toBeUndefined()
})

it('warns and changes nothing when settings.json is missing', () => {
  cmdUninstall(opts())

  expect(existsSync(settingsPath)).toBe(false)
  expect(log).toContain('No usable settings')
  expect(process.exitCode).toBeUndefined()
})

it('warns and never clobbers a settings.json that is not valid JSON', () => {
  writeFileSync(settingsPath, '{ not valid json')

  cmdUninstall(opts())

  expect(readFileSync(settingsPath, 'utf8')).toBe('{ not valid json')
  expect(existsSync(`${settingsPath}.bak`)).toBe(false)
  expect(log).toContain('No usable settings')
  expect(process.exitCode).toBeUndefined()
})

it('--purge also deletes the installed tokenline.sh', () => {
  writeSettings(ours)

  cmdUninstall(opts({ purge: true }))

  expect(existsSync(scriptPath)).toBe(false)
  expect(readJson()).toEqual({})
  expect(log).toContain(`deleted ${scriptPath}`)
})

it('--purge deletes the script from a custom --dir', () => {
  const custom = join(fake.home, 'tools')
  mkdirSync(custom)
  const customScript = join(custom, 'tokenline.sh')
  writeFileSync(customScript, '#!/usr/bin/env bash\n')

  cmdUninstall(opts({ purge: true, dir: custom }))

  expect(existsSync(customScript)).toBe(false)
  expect(existsSync(scriptPath)).toBe(true)
})

it('--purge with no installed script is a quiet no-op', () => {
  rmSync(scriptPath)
  writeSettings(ours)

  cmdUninstall(opts({ purge: true }))

  expect(log).not.toContain('deleted')
  expect(process.exitCode).toBeUndefined()
})

it('--dry-run writes nothing and deletes nothing, even with --purge', () => {
  const before = writeSettings({ ...ours, theme: 'dark' })

  cmdUninstall(opts({ dryRun: true, purge: true }))

  expect(readFileSync(settingsPath, 'utf8')).toBe(before)
  expect(existsSync(`${settingsPath}.bak`)).toBe(false)
  expect(existsSync(scriptPath)).toBe(true)
  expect(log).toContain(
    '[dry-run] would remove statusLine + subagentStatusLine',
  )
  expect(log).toContain(`[dry-run] would delete ${scriptPath}`)
  expect(process.exitCode).toBeUndefined()
})

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Options } from '../shared/types'
import { cmdInit } from './init'

// The settings.json patching contract of `init`: merge only tokenline's keys,
// back up before writing, refuse (exit 1, nothing written) on a conflict or on
// invalid JSON, and write nothing at all under --dry-run.
//
// cmdInit resolves its targets from os.homedir() (global scope), so homedir is
// pointed at a throwaway temp dir: no case ever touches the developer's real
// ~/.claude. A module mock is used instead of stubbing $HOME because homedir()
// reads the process environment natively, which a stubbed process.env may not
// reach in every vitest pool. platform() is mockable too, for the
// unsupported-platform refusal.
const fake = vi.hoisted(() => ({ home: '', platform: '' }))
vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>()
  return {
    ...os,
    homedir: () => fake.home,
    platform: () => fake.platform || os.platform(),
  }
})

// SCRIPT_SOURCE resolves next to the built CLI (dist/), which does not exist
// when the source runs under vitest. Point it at the repo's tokenline.sh.
vi.mock('../core/paths', async (importOriginal) => {
  const paths = await importOriginal<typeof import('../core/paths')>()
  return {
    ...paths,
    SCRIPT_SOURCE: join(__dirname, '..', '..', 'tokenline.sh'),
  }
})

const VERSION = '1.2.3'

const opts = (o: Partial<Options> = {}): Options => ({
  _: ['init'],
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
let command: string
let out: string

const statusLine = () => ({ type: 'command', command, refreshInterval: 1 })
const subagentStatusLine = () => ({ type: 'command', command })
const foreign = {
  type: 'command',
  command: 'node /home/u/other-statusline.js',
  refreshInterval: 1,
}

const writeSettings = (data: unknown): string => {
  mkdirSync(claude, { recursive: true })
  const raw = JSON.stringify(data, null, 2) + '\n'
  writeFileSync(settingsPath, raw)
  return raw
}
const readRaw = (): string => readFileSync(settingsPath, 'utf8')
const readJson = (): unknown => JSON.parse(readRaw())

beforeEach(() => {
  fake.home = mkdtempSync(join(tmpdir(), 'tokenline-'))
  fake.platform = ''
  claude = join(fake.home, '.claude')
  settingsPath = join(claude, 'settings.json')
  scriptPath = join(claude, 'tokenline.sh')
  command = `bash ${scriptPath}`
  out = ''
  const capture = (...a: unknown[]): void => {
    out += a.join(' ') + '\n'
  }
  vi.spyOn(console, 'log').mockImplementation(capture)
  vi.spyOn(console, 'error').mockImplementation(capture)
  process.exitCode = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
  rmSync(fake.home, { recursive: true, force: true })
})

describe('fresh install', () => {
  it('writes the executable stamped script and both blocks', () => {
    cmdInit(opts(), VERSION)

    expect(process.exitCode).toBeUndefined()
    expect(statSync(scriptPath).mode & 0o777).toBe(0o755)
    expect(readFileSync(scriptPath, 'utf8')).toContain(
      `TOKENLINE_VERSION="${VERSION}"`,
    )
    expect(readJson()).toEqual({
      statusLine: statusLine(),
      subagentStatusLine: subagentStatusLine(),
    })
    // Nothing existed before, so there is nothing to back up.
    expect(existsSync(`${settingsPath}.bak`)).toBe(false)
    expect(out).toContain('added statusLine')
    expect(out).toContain('added subagentStatusLine')
  })

  it('points the command at --dir when given', () => {
    const dir = join(fake.home, 'bin')

    cmdInit(opts({ dir }), VERSION)

    const custom = `bash ${join(dir, 'tokenline.sh')}`
    expect(existsSync(join(dir, 'tokenline.sh'))).toBe(true)
    expect(existsSync(scriptPath)).toBe(false)
    expect(readJson()).toEqual({
      statusLine: { type: 'command', command: custom, refreshInterval: 1 },
      subagentStatusLine: { type: 'command', command: custom },
    })
  })
})

describe('existing settings.json', () => {
  it('re-running is idempotent: no duplicate, reports confirmed, backs up', () => {
    cmdInit(opts(), VERSION)
    const first = readRaw()
    out = ''

    cmdInit(opts(), VERSION)

    expect(process.exitCode).toBeUndefined()
    expect(readRaw()).toBe(first)
    expect(readRaw().match(/"statusLine"/g)).toHaveLength(1)
    expect(readRaw().match(/"subagentStatusLine"/g)).toHaveLength(1)
    expect(readFileSync(`${settingsPath}.bak`, 'utf8')).toBe(first)
    expect(out).toContain('confirmed statusLine')
    expect(out).toContain('confirmed subagentStatusLine')
  })

  it('merges only its own keys, preserving unrelated ones', () => {
    const before = writeSettings({
      theme: 'dark',
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: {},
    })

    cmdInit(opts(), VERSION)

    expect(readJson()).toEqual({
      theme: 'dark',
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: {},
      statusLine: statusLine(),
      subagentStatusLine: subagentStatusLine(),
    })
    expect(readFileSync(`${settingsPath}.bak`, 'utf8')).toBe(before)
  })

  it('refuses a different statusLine without --force: exit 1, writes nothing', () => {
    const before = writeSettings({ statusLine: foreign, theme: 'dark' })

    cmdInit(opts(), VERSION)

    expect(process.exitCode).toBe(1)
    expect(readRaw()).toBe(before)
    expect(existsSync(scriptPath)).toBe(false)
    expect(existsSync(`${settingsPath}.bak`)).toBe(false)
    expect(out).toContain('A different statusLine is already configured')
    expect(out).toContain(foreign.command)
  })

  it('replaces a different statusLine with --force', () => {
    const before = writeSettings({ statusLine: foreign, theme: 'dark' })

    cmdInit(opts({ force: true }), VERSION)

    expect(process.exitCode).toBeUndefined()
    expect(readJson()).toEqual({
      statusLine: statusLine(),
      theme: 'dark',
      subagentStatusLine: subagentStatusLine(),
    })
    expect(readFileSync(`${settingsPath}.bak`, 'utf8')).toBe(before)
    expect(out).toContain('replaced statusLine')
  })

  it('refuses invalid JSON: exit 1, file untouched, prints the manual block', () => {
    mkdirSync(claude)
    writeFileSync(settingsPath, '{ not valid json')

    cmdInit(opts(), VERSION)

    expect(process.exitCode).toBe(1)
    expect(readRaw()).toBe('{ not valid json')
    expect(existsSync(scriptPath)).toBe(false)
    expect(existsSync(`${settingsPath}.bak`)).toBe(false)
    expect(out).toContain('invalid JSON')
    const manual = {
      statusLine: statusLine(),
      subagentStatusLine: subagentStatusLine(),
    }
    expect(out).toContain(JSON.stringify(manual, null, 2))
  })

  it('prints only the statusLine block for invalid JSON with --no-subagents', () => {
    mkdirSync(claude)
    writeFileSync(settingsPath, '{ not valid json')

    cmdInit(opts({ subagents: false }), VERSION)

    expect(process.exitCode).toBe(1)
    expect(out).toContain(JSON.stringify({ statusLine: statusLine() }, null, 2))
    expect(out).not.toContain('subagentStatusLine')
  })
})

describe('--dry-run', () => {
  it('writes nothing on a fresh install', () => {
    cmdInit(opts({ dryRun: true }), VERSION)

    expect(process.exitCode).toBeUndefined()
    expect(existsSync(claude)).toBe(false)
    expect(out).toContain('[dry-run] would:')
    expect(out).toContain(JSON.stringify(statusLine(), null, 2))
    expect(out).toContain(JSON.stringify(subagentStatusLine(), null, 2))
  })

  it('writes no script, settings or backup over an existing file', () => {
    const before = writeSettings({ theme: 'dark' })

    cmdInit(opts({ dryRun: true }), VERSION)

    expect(readRaw()).toBe(before)
    expect(existsSync(scriptPath)).toBe(false)
    expect(existsSync(`${settingsPath}.bak`)).toBe(false)
    expect(out).toContain(`backup       → ${settingsPath}.bak`)
  })

  it('announces a kept foreign subagentStatusLine instead of printing its block', () => {
    writeSettings({ subagentStatusLine: foreign })

    cmdInit(opts({ dryRun: true }), VERSION)

    expect(out).not.toContain('subagentStatusLine block:')
    expect(out).toContain('kept the existing subagentStatusLine')
  })
})

describe('subagentStatusLine', () => {
  it('repoints a tokenline block at another path, even without --force', () => {
    writeSettings({
      subagentStatusLine: {
        type: 'command',
        command: 'bash /home/u/old/tokenline.sh',
      },
    })

    cmdInit(opts(), VERSION)

    expect(process.exitCode).toBeUndefined()
    expect(readJson()).toEqual({
      statusLine: statusLine(),
      subagentStatusLine: subagentStatusLine(),
    })
    expect(out).toContain('replaced subagentStatusLine')
  })

  it("keeps another tool's block without --force, and still installs", () => {
    writeSettings({ subagentStatusLine: foreign })

    cmdInit(opts(), VERSION)

    // An extra on top of statusLine: a foreign block never fails the install.
    expect(process.exitCode).toBeUndefined()
    expect(readJson()).toEqual({
      subagentStatusLine: foreign,
      statusLine: statusLine(),
    })
    expect(out).toContain('kept the existing subagentStatusLine')
    expect(out).toContain('--force')
  })

  it("replaces another tool's block with --force", () => {
    writeSettings({ subagentStatusLine: foreign })

    cmdInit(opts({ force: true }), VERSION)

    expect(readJson()).toEqual({
      subagentStatusLine: subagentStatusLine(),
      statusLine: statusLine(),
    })
    expect(out).toContain('replaced subagentStatusLine')
  })

  it('is not written with --no-subagents, leaving an existing block alone', () => {
    writeSettings({ subagentStatusLine: foreign })

    cmdInit(opts({ subagents: false }), VERSION)

    expect(readJson()).toEqual({
      subagentStatusLine: foreign,
      statusLine: statusLine(),
    })
    expect(out).not.toContain('subagentStatusLine in')
    expect(out).not.toContain('kept the existing subagentStatusLine')
  })

  it('is skipped for Antigravity, which has no agent panel', () => {
    const agDir = join(fake.home, '.gemini', 'antigravity-cli')
    const agScript = join(agDir, 'tokenline.sh')

    cmdInit(opts({ targetCli: 'antigravity' }), VERSION)

    expect(process.exitCode).toBeUndefined()
    expect(existsSync(agScript)).toBe(true)
    expect(
      JSON.parse(readFileSync(join(agDir, 'settings.json'), 'utf8')),
    ).toEqual({
      statusLine: {
        type: 'command',
        command: `bash ${agScript}`,
        refreshInterval: 1,
      },
    })
    expect(out).toContain('Restart Antigravity CLI')
  })

  it('prints only the statusLine block for invalid JSON on Antigravity', () => {
    const agDir = join(fake.home, '.gemini', 'antigravity-cli')
    mkdirSync(agDir, { recursive: true })
    writeFileSync(join(agDir, 'settings.json'), '{ not valid json')

    cmdInit(opts({ targetCli: 'antigravity' }), VERSION)

    expect(process.exitCode).toBe(1)
    expect(out).toContain('"statusLine"')
    expect(out).not.toContain('subagentStatusLine')
  })
})

it('refuses an unsupported platform without --force: exit 1, writes nothing', () => {
  fake.platform = 'win32'

  cmdInit(opts(), VERSION)

  expect(process.exitCode).toBe(1)
  expect(existsSync(claude)).toBe(false)
  expect(out).toContain('Unsupported platform')
})

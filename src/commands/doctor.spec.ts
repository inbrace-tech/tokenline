import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { MockInstance } from 'vitest'

import { checkBash, checkJq, checkPlatform } from '../infra/system'
import { cmdDoctor } from './doctor'

// doctor reads three settings files: the project's ./.claude/settings.json
// (resolved from the cwd) and the global Claude and Antigravity ones (resolved
// from os.homedir()). Both roots are redirected into a throwaway temp dir, so
// no case ever reads or writes the developer's real ~/.claude. The platform
// and dependency probes have their own spec (system.spec.ts) and are stubbed
// here, keeping this suite independent of the host's bash/jq.
let root: string
let home: string
let project: string

vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>()
  return { ...os, homedir: () => home }
})
vi.mock('../infra/system', () => ({
  checkPlatform: vi.fn(() => true),
  checkBash: vi.fn(() => true),
  checkJq: vi.fn(() => true),
}))

const projectSettings = () => join(project, '.claude', 'settings.json')
const globalSettings = () => join(home, '.claude', 'settings.json')
const antigravitySettings = () =>
  join(home, '.gemini', 'antigravity-cli', 'settings.json')

const write = (file: string, content: unknown): void => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(
    file,
    typeof content === 'string' ? content : JSON.stringify(content),
  )
}

const TOKENLINE = { type: 'command', command: 'bash ~/.claude/tokenline.sh' }
const OTHER = { type: 'command', command: 'bash other.sh' }

let log: MockInstance<typeof console.log>

// Runs doctor and returns what it printed, one entry per line, ANSI stripped.
const doctor = (): string[] => {
  cmdDoctor()
  return log.mock.calls
    .map((c) => String(c[0] ?? ''))
    .join('\n')
    .split('\n')
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')) // eslint-disable-line no-control-regex
    .filter((l) => l.trim() !== '')
}

// Every file under the temp root with its content and mtime: a fingerprint
// that changes if doctor writes, backs up, creates or deletes anything.
const snapshot = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const name of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    const p = join(dir, name)
    const st = statSync(p)
    out[name] = st.isDirectory()
      ? 'dir'
      : `${readFileSync(p, 'utf8')}@${st.mtimeMs}`
  }
  return out
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tokenline-doctor-'))
  home = join(root, 'home')
  project = join(root, 'project')
  mkdirSync(home)
  mkdirSync(project)
  vi.spyOn(process, 'cwd').mockReturnValue(project)
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

it('runs the platform, bash and jq probes', () => {
  doctor()

  expect(checkPlatform).toHaveBeenCalledOnce()
  expect(checkBash).toHaveBeenCalledOnce()
  expect(checkJq).toHaveBeenCalledOnce()
})

it('reports every target as not configured when no settings exist', () => {
  const lines = doctor()

  expect(lines).toContain(
    `→ claude (project) settings: not configured (${projectSettings()})`,
  )
  expect(lines).toContain(
    `→ claude (global) settings: not configured (${globalSettings()})`,
  )
  expect(lines).toContain(
    `→ antigravity (global) settings: not configured (${antigravitySettings()})`,
  )
  expect(lines.some((l) => l.includes('subagent rows'))).toBe(false)
})

it('reports project, global and antigravity settings as configured', () => {
  write(projectSettings(), { statusLine: TOKENLINE })
  write(globalSettings(), { statusLine: TOKENLINE })
  write(antigravitySettings(), { statusLine: TOKENLINE })

  const lines = doctor()

  expect(lines).toContain(
    `✓ claude (project) settings: tokenline configured (${projectSettings()})`,
  )
  expect(lines).toContain(
    `✓ claude (global) settings: tokenline configured (${globalSettings()})`,
  )
  expect(lines).toContain(
    `✓ antigravity (global) settings: tokenline configured (${antigravitySettings()})`,
  )
})

it('reports invalid JSON per target, without a subagent rows line', () => {
  write(projectSettings(), '{ not valid json')
  write(globalSettings(), { statusLine: TOKENLINE })

  const lines = doctor()

  expect(lines).toContain(
    `! claude (project) settings: invalid JSON (${projectSettings()})`,
  )
  expect(lines).toContain(
    `✓ claude (global) settings: tokenline configured (${globalSettings()})`,
  )
  expect(lines.some((l) => l.includes('claude (project) subagent'))).toBe(false)
})

it("treats another tool's statusLine as not configured", () => {
  write(globalSettings(), { statusLine: OTHER })

  const lines = doctor()

  expect(lines).toContain(
    `→ claude (global) settings: not configured (${globalSettings()})`,
  )
  expect(lines.some((l) => l.includes('subagent rows'))).toBe(false)
})

describe('subagent rows', () => {
  it('reports tokenline subagent rows as configured', () => {
    write(globalSettings(), {
      statusLine: TOKENLINE,
      subagentStatusLine: TOKENLINE,
    })

    expect(doctor()).toContain(
      '✓ claude (global) subagent rows: tokenline configured',
    )
  })

  it('suggests re-running init when only the main statusLine is tokenline', () => {
    write(projectSettings(), { statusLine: TOKENLINE })

    expect(doctor()).toContain(
      '→ claude (project) subagent rows: not configured (re-run init to add)',
    )
  })

  it("names another tool's subagent command", () => {
    write(globalSettings(), {
      statusLine: TOKENLINE,
      subagentStatusLine: OTHER,
    })

    expect(doctor()).toContain(
      '→ claude (global) subagent rows: another command (bash other.sh)',
    )
  })

  it('describes a subagent block without a command as "no command"', () => {
    write(globalSettings(), {
      statusLine: TOKENLINE,
      subagentStatusLine: { type: 'command' },
    })

    expect(doctor()).toContain(
      '→ claude (global) subagent rows: another command (no command)',
    )
  })

  it('reports tokenline subagent rows even when the main statusLine is not tokenline', () => {
    write(globalSettings(), {
      statusLine: OTHER,
      subagentStatusLine: TOKENLINE,
    })

    const lines = doctor()

    expect(lines).toContain(
      `→ claude (global) settings: not configured (${globalSettings()})`,
    )
    expect(lines).toContain(
      '✓ claude (global) subagent rows: tokenline configured',
    )
  })

  it('stays silent about subagent rows when nothing of tokenline is set', () => {
    write(globalSettings(), { theme: 'dark' })

    expect(doctor().some((l) => l.includes('subagent rows'))).toBe(false)
  })

  it('never reports subagent rows for Antigravity, which has no agent panel', () => {
    write(antigravitySettings(), {
      statusLine: TOKENLINE,
      subagentStatusLine: TOKENLINE,
    })

    expect(doctor().some((l) => l.includes('subagent rows'))).toBe(false)
  })
})

it('changes nothing on disk: no writes, no backups, no new files', () => {
  write(projectSettings(), { statusLine: TOKENLINE })
  write(globalSettings(), '{ not valid json')
  write(antigravitySettings(), { statusLine: OTHER })
  const before = snapshot(root)

  doctor()

  expect(snapshot(root)).toEqual(before)
})

it('creates no config dirs for targets that do not exist yet', () => {
  doctor()

  expect(readdirSync(home)).toEqual([])
  expect(readdirSync(project)).toEqual([])
})

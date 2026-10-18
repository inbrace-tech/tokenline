import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Where tokenline.sh keeps its per-turn caches and update check. Each case
// points XDG_RUNTIME_DIR and TMPDIR at throwaway paths, so nothing touches the
// developer's own runtime dir.
const SCRIPT = join(__dirname, '..', 'tokenline.sh')
const UID = process.getuid?.() ?? 0
const SUBDIR = `tokenline-${UID}`

let dir: string
let session = 0
let sid: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tokenline-runtime-'))
  sid = `spec-runtime-${process.pid}-${++session}`
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  // The bare-/tmp fallback writes there; remove only this case's files.
  for (const f of readdirSync('/tmp')) {
    if (f.endsWith(sid)) rmSync(join('/tmp', f), { force: true })
  }
})

function render(env: Record<string, string>, script = SCRIPT): string {
  const payload = {
    model: { display_name: 'Opus 4.8', id: 'claude-opus-4-8' },
    session_id: sid,
    context_window: {
      used_percentage: 10,
      context_window_size: 200_000,
      current_usage: {
        input_tokens: 1000,
        output_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  }
  const out = execFileSync('bash', [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  // eslint-disable-next-line no-control-regex
  return out.replace(/\x1b\[[0-9;]*m/g, '')
}

// A copy of the script stamped as an installed 1.4.0, the way the installer
// writes it, so the update notice is live.
function stampedScript(): string {
  const path = join(dir, 'tokenline.sh')
  const src = readFileSync(SCRIPT, 'utf8')
    .replace(/^TOKENLINE_VERSION=""$/m, 'TOKENLINE_VERSION="1.4.0"')
    .replace(/^TOKENLINE_UPDATE_CMD=""$/m, 'TOKENLINE_UPDATE_CMD="update-me"')
  writeFileSync(path, src)
  return path
}

// A fresh check result, recorded by this same session, so the render reads it
// and never starts a network fetch.
function seedLatest(runtime: string, version: string): void {
  writeFileSync(join(runtime, 'latest-version'), `${version}\n`)
  writeFileSync(join(runtime, 'latest-version.session'), `${sid}\n`)
}

it('uses XDG_RUNTIME_DIR when it is a directory we own', () => {
  const xdg = join(dir, 'xdg')
  const tmp = join(dir, 'tmp')
  mkdirSync(xdg, { mode: 0o700 })
  mkdirSync(tmp)
  render({ XDG_RUNTIME_DIR: xdg, TMPDIR: tmp })
  expect(existsSync(join(xdg, SUBDIR, `lastts-${sid}`))).toBe(true)
  expect(existsSync(join(tmp, SUBDIR))).toBe(false)
})

it('falls back to TMPDIR when XDG_RUNTIME_DIR is set but missing', () => {
  const tmp = join(dir, 'tmp')
  mkdirSync(tmp)
  render({
    XDG_RUNTIME_DIR: join(dir, 'run', 'user', String(UID)),
    TMPDIR: tmp,
  })
  const runtime = join(tmp, SUBDIR)
  expect(statSync(runtime).mode & 0o777).toBe(0o700)
  expect(existsSync(join(runtime, `lastts-${sid}`))).toBe(true)
})

it('falls back to TMPDIR when XDG_RUNTIME_DIR is unset', () => {
  const tmp = join(dir, 'tmp')
  mkdirSync(tmp)
  const env: Record<string, string> = { TMPDIR: tmp }
  const saved = process.env.XDG_RUNTIME_DIR
  delete process.env.XDG_RUNTIME_DIR
  try {
    render(env)
  } finally {
    if (saved !== undefined) process.env.XDG_RUNTIME_DIR = saved
  }
  expect(existsSync(join(tmp, SUBDIR, `lastts-${sid}`))).toBe(true)
})

it('shows the update notice from the TMPDIR fallback', () => {
  const tmp = join(dir, 'tmp')
  const runtime = join(tmp, SUBDIR)
  mkdirSync(runtime, { recursive: true, mode: 0o700 })
  seedLatest(runtime, '1.5.0')
  const out = render(
    { XDG_RUNTIME_DIR: join(dir, 'missing'), TMPDIR: tmp },
    stampedScript(),
  )
  expect(out).toContain('↑ tokenline 1.5.0 available')
})

it('rejects a symlink planted at the fallback path', () => {
  const tmp = join(dir, 'tmp')
  const target = join(dir, 'elsewhere')
  mkdirSync(tmp)
  mkdirSync(target, { mode: 0o700 })
  seedLatest(target, '1.5.0')
  symlinkSync(target, join(tmp, SUBDIR))
  const out = render(
    { XDG_RUNTIME_DIR: join(dir, 'missing'), TMPDIR: tmp },
    stampedScript(),
  )
  // Nothing is written through the link, and the private-dir features stay off.
  expect(existsSync(join(target, `lastts-${sid}`))).toBe(false)
  expect(out).not.toContain('available')
})

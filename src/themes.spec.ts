import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Renders tokenline.sh under each --theme and checks which lines it prints.
// Runs the bash script itself: it stays the single source of truth.
const SCRIPT = join(__dirname, '..', 'tokenline.sh')
const INSTALL = join(__dirname, '..', 'install.sh')

let dir: string
let session = 0
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tokenline-themes-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// A turn with cache activity and both rate-limit windows, so `full` prints all
// three lines (plus the separator).
function payload() {
  const now = Math.floor(Date.now() / 1000)
  return {
    model: { display_name: 'Opus 4.8' },
    session_id: `theme-${++session}`,
    transcript_path: '',
    context_window: {
      used_percentage: 46.2,
      context_window_size: 200_000,
      current_usage: {
        input_tokens: 1200,
        output_tokens: 800,
        cache_creation_input_tokens: 46_200,
        cache_read_input_tokens: 40_000,
      },
    },
    rate_limits: {
      five_hour: { used_percentage: 30, resets_at: now + 9000 },
      seven_day: { used_percentage: 55, resets_at: now + 400_000 },
    },
  }
}

function render(args: string[], env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync('bash', [SCRIPT, ...args], {
    input: JSON.stringify(payload()),
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, XDG_RUNTIME_DIR: dir, ...env },
  })
  // eslint-disable-next-line no-control-regex
  const plain = r.stdout.replace(/\x1b\[[0-9;]*m/g, '')
  return { status: r.status, lines: plain.split('\n').filter((l) => l !== '') }
}

describe('tokenline.sh --theme', () => {
  it('full prints line 1, the economics and the rate limits', () => {
    const { lines } = render(['--theme', 'full'])
    expect(lines).toHaveLength(4)
    expect(lines[0]).toMatch(/^Opus 4\.8 \| ctx: /)
    expect(lines[1]).toMatch(/^read\(/)
    expect(lines[3]).toMatch(/^5h: /)
  })

  it('renders full when no theme is given', () => {
    expect(render([]).lines).toHaveLength(4)
  })

  it('minimal prints one line: model, ctx % and cache state', () => {
    const { lines } = render(['--theme', 'minimal'])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^Opus 4\.8 · ctx 46% · cache HOT/)
  })

  it('compact adds the token counts, the cache clock and the saving %', () => {
    const { lines } = render(['--theme=compact'])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(
      /^Opus 4\.8 · ctx \S+\/200\.0k 46% · cache \d+:\d\d HOT · save \d+%$/,
    )
  })

  it('economics drops the rate limits, limits drops the economics', () => {
    const econ = render(['--theme', 'economics']).lines
    expect(econ).toHaveLength(2)
    expect(econ[1]).toMatch(/^read\(/)

    const limits = render(['--theme', 'limits']).lines
    expect(limits).toHaveLength(3)
    expect(limits.some((l) => l.startsWith('read('))).toBe(false)
    expect(limits[2]).toMatch(/^5h: /)
  })

  it('reads TOKENLINE_THEME when no flag is given', () => {
    expect(render([], { TOKENLINE_THEME: 'minimal' }).lines).toHaveLength(1)
  })

  it('falls back to full on an unknown theme', () => {
    expect(render(['--theme', 'nope']).lines).toHaveLength(4)
  })

  it('never hangs when --theme is the last argument', () => {
    const { status, lines } = render(['--theme'])
    expect(status).toBe(0)
    expect(lines).toHaveLength(4)
  })
})

describe('install.sh --theme', () => {
  // From the repo, install.sh uses the tokenline.sh beside it and only prints.
  function snippet(args: string[]) {
    const r = spawnSync('bash', [INSTALL, ...args], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, HOME: dir },
    })
    return r.stdout
  }

  it('adds the flag to the statusLine command only', () => {
    const out = snippet(['--theme', 'compact'])
    expect(out).toContain(`"command": "bash ${SCRIPT} --theme compact",`)
    expect(out).toContain(`"command": "bash ${SCRIPT}"\n`)
  })

  it('prints no flag for full or an unknown theme', () => {
    expect(snippet(['--theme', 'full'])).toContain(
      `"command": "bash ${SCRIPT}",`,
    )
    const out = snippet(['--theme', 'nope'])
    expect(out).toContain("unknown theme 'nope'")
    expect(out).toContain(`"command": "bash ${SCRIPT}",`)
  })
})

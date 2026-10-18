import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Renders tokenline.sh with a payload and returns the per-turn economics line,
// ANSI stripped. Runs the bash script itself: it stays the single source of truth.
const SCRIPT = join(__dirname, '..', 'tokenline.sh')

// One turn: 100k cache read, 10k cache write, 1k new input, 1k output.
const USAGE = {
  input_tokens: 1000,
  output_tokens: 1000,
  cache_creation_input_tokens: 10_000,
  cache_read_input_tokens: 100_000,
}

// Each render gets its own runtime dir and session, so the per-turn cache never
// touches the developer's own XDG_RUNTIME_DIR and no render sees another's TTL.
let dir: string
let session = 0
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tokenline-statusline-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// A transcript whose last assistant turn wrote the cache with the given TTL.
function transcript(ttl: '5m' | '1h'): string {
  const path = join(dir, 'transcript.jsonl')
  const line = {
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: {
      usage: { cache_creation: { [`ephemeral_${ttl}_input_tokens`]: 10_000 } },
    },
  }
  writeFileSync(path, JSON.stringify(line) + '\n')
  return path
}

function economicsLine(
  model: { display_name: string; id: string },
  transcriptPath = '',
): string {
  const payload = {
    model,
    session_id: `spec-${++session}`,
    transcript_path: transcriptPath,
    context_window: {
      used_percentage: 10,
      context_window_size: 1_000_000,
      current_usage: USAGE,
    },
  }
  const out = execFileSync('bash', [SCRIPT], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, XDG_RUNTIME_DIR: dir },
  })
  // eslint-disable-next-line no-control-regex
  const plain = out.replace(/\x1b\[[0-9;]*m/g, '')
  return plain.split('\n').find((line) => line.includes('read(')) ?? ''
}

// Equivalent tokens and saving % exactly as compute_turn_breakdown derives them.
function expected(read: number, write: number, output: number) {
  const {
    input_tokens,
    output_tokens,
    cache_creation_input_tokens,
    cache_read_input_tokens,
  } = USAGE
  const eq = Math.trunc(
    cache_read_input_tokens * read +
      cache_creation_input_tokens * write +
      input_tokens +
      output_tokens * output,
  )
  const uncached = Math.trunc(
    cache_read_input_tokens +
      cache_creation_input_tokens +
      input_tokens +
      output_tokens * output,
  )
  const saving = Math.trunc((100 * (uncached - eq)) / uncached)
  return `eq: ${(eq / 1000).toFixed(1)}k saving: ${saving}%`
}

describe('Claude cache-read multiplier', () => {
  it.each([
    ['Opus 4.8', 'claude-opus-4-8', '0.1'],
    ['Haiku 5.5', 'claude-haiku-5-5', '0.1'],
    ['Opus 5', 'claude-opus-5', '0.1'],
    ['Fable 5.10', 'claude-fable-5-10', '0.1'],
    ['Fable 5.1', 'claude-fable-5-1', '0.025'],
    ['Mythos 5.1 (1M context)', 'claude-mythos-5-1[1m]', '0.025'],
    ['Opus 5.5', 'claude-opus-5-5', '0.05'],
    ['Sonnet 5.5', 'claude-sonnet-5-5', '0.05'],
  ])('%s (%s) reads at %sx', (display_name, id, read) => {
    const line = economicsLine({ display_name, id })
    expect(line).toContain(`read(${read}x)`)
    expect(line).toContain('new(1x)')
    expect(line).toContain('output(5x)')
    expect(line).toContain(expected(Number(read), 1.25, 5))
  })

  it('matches by display name when the id is missing', () => {
    expect(economicsLine({ display_name: 'Fable 5.1', id: '' })).toContain(
      'read(0.025x)',
    )
    expect(economicsLine({ display_name: 'Sonnet 5.5', id: '' })).toContain(
      'read(0.05x)',
    )
  })
})

describe('Claude cache-write multiplier', () => {
  const model = { display_name: 'Opus 4.8', id: 'claude-opus-4-8' }

  it('bills a 5m cache write at 1.25x', () => {
    const line = economicsLine(model, transcript('5m'))
    expect(line).toContain('write(1.25x)')
    expect(line).toContain(expected(0.1, 1.25, 5))
  })

  it('bills a 1h cache write at 2x', () => {
    const line = economicsLine(model, transcript('1h'))
    expect(line).toContain('write(2x)')
    expect(line).toContain(expected(0.1, 2, 5))
  })
})

describe('Gemini economics multipliers', () => {
  it('bills Gemini 4 Argon cache reads at 0.05x and output at 5x', () => {
    const line = economicsLine({
      display_name: 'Gemini 4 Argon',
      id: 'gemini-4-argon',
    })
    expect(line).toContain('read(0.05x)')
    expect(line).toContain('write(1.0x)')
    expect(line).toContain('new(1x)')
    expect(line).toContain('output(5x)')
    expect(line).toContain(expected(0.05, 1, 5))
  })

  it('matches Argon from the API id alone', () => {
    const line = economicsLine({ display_name: 'Gemini', id: 'gemini-4-argon' })
    expect(line).toContain('read(0.05x)')
    expect(line).toContain('output(5x)')
  })

  it('keeps 0.25x / 4x on other Gemini models', () => {
    const line = economicsLine({
      display_name: 'Gemini 3 Pro',
      id: 'gemini-3-pro',
    })
    expect(line).toContain('read(0.25x)')
    expect(line).toContain('write(1.0x)')
    expect(line).toContain('output(4x)')
    expect(line).toContain(expected(0.25, 1, 4))
  })

  it('ignores a 1h transcript turn: Gemini cache writes stay 1.0x', () => {
    const line = economicsLine(
      { display_name: 'Gemini 3 Pro', id: 'gemini-3-pro' },
      transcript('1h'),
    )
    expect(line).toContain('write(1.0x)')
  })
})

import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

// Renders tokenline.sh with a payload and returns the per-turn economics line,
// ANSI stripped. Runs the bash script itself: it stays the single source of truth.
const SCRIPT = join(__dirname, '..', 'tokenline.sh')

function economicsLine(model: { display_name: string; id: string }): string {
  const payload = {
    model,
    context_window: {
      used_percentage: 10,
      context_window_size: 1_000_000,
      current_usage: {
        input_tokens: 1000,
        output_tokens: 1000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 100_000,
      },
    },
  }
  const out = execFileSync('bash', [SCRIPT], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  })
  // eslint-disable-next-line no-control-regex
  const plain = out.replace(/\x1b\[[0-9;]*m/g, '')
  return plain.split('\n').find((line) => line.includes('read(')) ?? ''
}

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
    expect(line).toContain('output(4x)')
  })
})

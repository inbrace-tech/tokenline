import { spawnSync } from 'node:child_process'
import { platform } from 'node:os'

import type { MockInstance } from 'vitest'

import { checkBash, checkJq, checkPlatform } from './system'

// The probes shell out to `bash --version` / `jq --version` and read
// os.platform(). Both boundaries are mocked so the suite never depends on the
// CI runner's OS or toolchain: each case scripts exactly what the host
// "has", and asserts the verdict and the line doctor/init print for it.
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  platform: vi.fn(),
}))

const spawn = vi.mocked(spawnSync)
const os = vi.mocked(platform)

// Fakes one spawnSync result. A missing binary surfaces as status null
// (with an ENOENT error), never as a thrown exception.
const ran = (status: number | null, stdout = '') =>
  ({ status, stdout, stderr: '' }) as unknown as ReturnType<typeof spawnSync>

const output = (): string =>
  log.mock.calls
    .map((c) => String(c[0]))
    .join('\n')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*m/g, '')

let log: MockInstance<typeof console.log>

beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.resetAllMocks()
  vi.restoreAllMocks()
})

describe('checkPlatform', () => {
  it.each(['linux', 'darwin'] as const)('accepts %s', (p) => {
    os.mockReturnValue(p)

    expect(checkPlatform()).toBe(true)
    expect(output()).toContain(`platform: ${p} (supported)`)
  })

  it.each(['win32', 'freebsd', 'aix'] as const)('rejects %s', (p) => {
    os.mockReturnValue(p)

    expect(checkPlatform()).toBe(false)
    expect(output()).toContain(`platform: ${p} — supported on Linux/WSL2`)
  })
})

describe('checkBash', () => {
  it('accepts bash 5 and reports its major.minor', () => {
    spawn.mockReturnValue(
      ran(0, 'GNU bash, version 5.2.21(1)-release (x86_64-pc-linux-gnu)\n'),
    )

    expect(checkBash()).toBe(true)
    expect(spawn).toHaveBeenCalledWith('bash', ['--version'], {
      encoding: 'utf8',
    })
    expect(output()).toContain('bash 5.2')
  })

  it('accepts bash 4.0, the minimum', () => {
    spawn.mockReturnValue(ran(0, 'GNU bash, version 4.0.44(1)-release\n'))

    expect(checkBash()).toBe(true)
    expect(output()).toContain('bash 4.0')
  })

  it("rejects macOS's stock bash 3.2", () => {
    spawn.mockReturnValue(
      ran(0, 'GNU bash, version 3.2.57(1)-release (arm64-apple-darwin23)\n'),
    )

    expect(checkBash()).toBe(false)
    expect(output()).toContain('bash 3.2 found — the script needs bash 4+.')
  })

  it('rejects a bash whose version it cannot parse', () => {
    spawn.mockReturnValue(ran(0, 'something unexpected\n'))

    expect(checkBash()).toBe(false)
    expect(output()).toContain('bash ? found — the script needs bash 4+.')
  })

  it('reports bash as missing when it does not run', () => {
    spawn.mockReturnValue(ran(null))

    expect(checkBash()).toBe(false)
    expect(output()).toContain('bash not found')
  })
})

describe('checkJq', () => {
  it('accepts any jq that runs and echoes its version line', () => {
    spawn.mockReturnValue(ran(0, 'jq-1.7.1\n'))

    expect(checkJq()).toBe(true)
    expect(spawn).toHaveBeenCalledWith('jq', ['--version'], {
      encoding: 'utf8',
    })
    expect(output()).toContain('jq-1.7.1')
  })

  it('reports jq as missing when it does not run', () => {
    spawn.mockReturnValue(ran(null))

    expect(checkJq()).toBe(false)
    expect(output()).toContain('jq not found — required at runtime.')
  })

  it('reports jq as missing when it exits non-zero', () => {
    spawn.mockReturnValue(ran(127))

    expect(checkJq()).toBe(false)
    expect(output()).toContain('jq not found')
  })
})

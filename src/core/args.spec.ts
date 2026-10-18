import { parseArgs } from './args'

describe('parseArgs', () => {
  it('returns the defaults for an empty argv', () => {
    expect(parseArgs([])).toEqual({
      _: [],
      targetCli: 'claude',
      dir: null,
      global: false,
      dryRun: false,
      force: false,
      purge: false,
      subagents: true,
      help: false,
      version: false,
      unknown: [],
    })
  })

  it('parses the boolean flags', () => {
    const opts = parseArgs([
      '--global',
      '--dry-run',
      '--force',
      '--purge',
      '--no-subagents',
    ])

    expect(opts.global).toBe(true)
    expect(opts.dryRun).toBe(true)
    expect(opts.force).toBe(true)
    expect(opts.purge).toBe(true)
    expect(opts.subagents).toBe(false)
  })

  it('takes the next argument as the --dir value', () => {
    const opts = parseArgs(['init', '--dir', '/home/u/bin', 'extra'])

    expect(opts.dir).toBe('/home/u/bin')
    expect(opts._).toEqual(['init', 'extra'])
  })

  it('leaves dir null when --dir is the last argument', () => {
    expect(parseArgs(['--dir']).dir).toBeNull()
  })

  it('makes --antigravity a global install for the antigravity target', () => {
    const opts = parseArgs(['--antigravity'])

    expect(opts.targetCli).toBe('antigravity')
    expect(opts.global).toBe(true)
  })

  it.each([
    ['-h', 'help'],
    ['--help', 'help'],
    ['-v', 'version'],
    ['--version', 'version'],
  ] as const)('maps %s to %s', (flag, key) => {
    expect(parseArgs([flag])[key]).toBe(true)
  })

  it('collects unknown flags and positionals separately, in order', () => {
    const opts = parseArgs(['init', '--bogus', 'doctor', '-x'])

    expect(opts.unknown).toEqual(['--bogus', '-x'])
    expect(opts._).toEqual(['init', 'doctor'])
  })
})

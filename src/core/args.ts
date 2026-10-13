import type { Options } from '../shared/types'

// Argument parsing (no deps). Lives outside cli.ts so it can be unit-tested:
// importing cli.ts runs main() as a side effect.
export function parseArgs(argv: string[]): Options {
  const out: Options = {
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
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--dir':
        out.dir = argv[++i] ?? null
        break
      case '--antigravity':
        out.targetCli = 'antigravity'
        out.global = true
        break
      case '--global':
        out.global = true
        break
      case '--dry-run':
        out.dryRun = true
        break
      case '--force':
        out.force = true
        break
      case '--purge':
        out.purge = true
        break
      case '--no-subagents':
        out.subagents = false
        break
      case '-h':
      case '--help':
        out.help = true
        break
      case '-v':
      case '--version':
        out.version = true
        break
      default:
        if (a !== undefined && a.startsWith('-')) out.unknown.push(a)
        else if (a !== undefined) out._.push(a)
    }
  }
  return out
}

#!/usr/bin/env node
// =============================================================================
// @inbrace-tech/tokenline — installer CLI
//
// Install-time only. Copies tokenline.sh to a stable path and wires it into
// your Claude Code settings.json. The statusline itself runs as
// `bash tokenline.sh` — there is NO Node in the per-second hot path.
//
//   npx @inbrace-tech/tokenline init              # install into ~/.claude
//   npx @inbrace-tech/tokenline init --project    # install into ./.claude
//   npx @inbrace-tech/tokenline doctor            # check deps, change nothing
//   npx @inbrace-tech/tokenline uninstall         # remove the statusLine block
//
// Authored in TypeScript; published as compiled dist/cli.js. Zero runtime
// dependencies — only Node built-ins.
// =============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { cmdDoctor } from './commands/doctor'
import { cmdInit } from './commands/init'
import { cmdUninstall } from './commands/uninstall'
import { bold, err, warn } from './shared/logger'
import type { Options } from './shared/types'

const PKG = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
) as { version: string }

// --- Argument parsing (no deps) ----------------------------------------------
function parseArgs(argv: string[]): Options {
  const out: Options = {
    _: [],
    dir: null,
    project: false,
    dryRun: false,
    force: false,
    purge: false,
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
      case '--project':
      case '--local':
        out.project = true
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

function help(): void {
  console.log(`
${bold('tokenline')} — a cache-aware statusline for AI coding CLIs

${bold('Usage')}
  npx @inbrace-tech/tokenline <command> [options]

${bold('Commands')}
  init          Install tokenline.sh and wire it into your Claude Code settings
  doctor        Check dependencies and current config — changes nothing
  uninstall     Remove the tokenline statusLine block from settings

${bold('Options')}
  --project     Target ./.claude (project) instead of ~/.claude (global)
  --dir <path>  Write tokenline.sh to a custom directory
  --dry-run     Show what would happen without writing anything
  --force       Proceed on an unsupported platform / replace an existing statusLine
  --purge       (uninstall) also delete the installed tokenline.sh
  -h, --help    Show this help
  -v, --version Show version

${bold('Notes')}
  The statusline runs as 'bash tokenline.sh' — no Node in the per-second hot path.
  jq is required at runtime; this installer checks for it but cannot install it.
`)
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.unknown.length > 0) {
    opts.unknown.forEach((u) => warn(`ignoring unknown option: ${u}`))
  }
  if (opts.version) {
    console.log(PKG.version)
    return
  }
  if (opts.help || opts._.length === 0) {
    help()
    return
  }

  try {
    switch (opts._[0]) {
      case 'init':
        cmdInit(opts)
        break
      case 'doctor':
        cmdDoctor()
        break
      case 'uninstall':
      case 'remove':
        cmdUninstall(opts)
        break
      default:
        err(`Unknown command: ${opts._[0]}`)
        help()
        process.exitCode = 1
    }
  } catch (e) {
    err(e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  }
}

main()

#!/usr/bin/env node
// =============================================================================
// @inbrace-tech/tokenline — installer CLI
//
// Install-time only. Copies tokenline.sh to a stable path and wires it into
// your Claude Code settings.json. The statusline itself runs as
// `bash tokenline.sh` — there is NO Node in the per-second hot path.
//
//   npx @inbrace-tech/tokenline init              # install into ./.claude (project)
//   npx @inbrace-tech/tokenline init --global     # install into ~/.claude (global)
//   npx @inbrace-tech/tokenline init --antigravity # install into ~/.gemini/antigravity-cli
//   npx @inbrace-tech/tokenline@latest update --global # refresh the installed script
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
import { cmdUpdate } from './commands/update'
import { parseArgs } from './core/args'
import { bold, err, warn } from './shared/logger'

const PKG = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
) as { version: string }

function help(): void {
  console.log(`
${bold('tokenline')} — a cache-aware statusline for AI coding CLIs

${bold('Usage')}
  npx @inbrace-tech/tokenline <command> [options]

${bold('Commands')}
  init          Install tokenline.sh and wire it into settings
  update        Replace the installed tokenline.sh with this version (run it as @latest)
  doctor        Check dependencies and current config — changes nothing
  uninstall     Remove the tokenline blocks (statusLine, subagentStatusLine) from settings

${bold('Options')}
  --antigravity Target Antigravity CLI (~/.gemini/antigravity-cli)
  --global      Target ~/.claude (global) instead of ./.claude (project)
  --dir <path>  Write tokenline.sh to a custom directory
  --dry-run     Show what would happen without writing anything
  --force       Proceed on an unsupported platform / replace an existing statusLine
  --purge       (uninstall) also delete the installed tokenline.sh
  --no-subagents (init) skip the per-subagent cache rows in the agent panel
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
        cmdInit(opts, PKG.version)
        break
      case 'update':
        cmdUpdate(opts, PKG.version)
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

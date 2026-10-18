import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { scriptTarget, settingsTarget, statusLineCommand } from '../core/paths'
import { backup, planSubagentStatusLine, readSettings } from '../core/settings'
import { updateCommand } from '../core/stamp'
import { writeStampedScript } from '../infra/script'
import { checkBash, checkJq, checkPlatform } from '../infra/system'
import { bold, err, green, step, warn } from '../shared/logger'
import type {
  Options,
  Settings,
  StatusLineBlock,
  SubagentStatusLineBlock,
} from '../shared/types'

function keepNotice(existing: unknown): void {
  warn(
    `kept the existing subagentStatusLine (${JSON.stringify(existing)}); ` +
      're-run with --force to use tokenline for subagent rows.',
  )
}

export function cmdInit(opts: Options, version: string): void {
  console.log(bold('\ntokenline — installing the statusline\n'))

  const supported = checkPlatform()
  if (!supported && !opts.force) {
    err('Unsupported platform. Re-run with --force to install anyway.')
    process.exitCode = 1
    return
  }
  checkBash()
  checkJq()

  const scriptPath = scriptTarget(opts)
  const settingsPath = settingsTarget(opts)
  const block: StatusLineBlock = {
    type: 'command',
    command: statusLineCommand(scriptPath),
    refreshInterval: 1,
  }

  // Read settings first so we can fail safely *before* writing anything.
  const s = readSettings(settingsPath)
  if (s.exists && s.data === null) {
    err(`Could not parse ${settingsPath} (invalid JSON). Leaving it untouched.`)
    console.log('\nAdd this block manually, inside the top-level object:\n')
    const manual =
      opts.targetCli === 'claude' && opts.subagents
        ? {
            statusLine: block,
            subagentStatusLine: { type: 'command', command: block.command },
          }
        : { statusLine: block }
    console.log(JSON.stringify(manual, null, 2) + '\n')
    process.exitCode = 1
    return
  }

  const existing = s.data ? s.data.statusLine : undefined
  const alreadyOurs =
    existing !== undefined && existing.command === block.command
  const conflict = existing !== undefined && !alreadyOurs
  if (conflict && !opts.force) {
    err(`A different statusLine is already configured in ${settingsPath}:`)
    console.log(`    ${JSON.stringify(existing)}`)
    warn('Re-run with --force to replace it.')
    process.exitCode = 1
    return
  }

  // The same script renders Claude Code's agent panel (one row per subagent,
  // each with its own cache countdown). Only Claude Code has that panel.
  const subBlock: SubagentStatusLineBlock | null =
    opts.targetCli === 'claude' && opts.subagents
      ? { type: 'command', command: block.command }
      : null
  const subPlan = subBlock
    ? planSubagentStatusLine(
        s.data?.subagentStatusLine,
        subBlock.command,
        opts.force,
      )
    : null

  if (opts.dryRun) {
    console.log(bold('\n[dry-run] would:'))
    step(`write script  → ${scriptPath}`)
    step(`${s.exists ? 'patch' : 'create'} settings → ${settingsPath}`)
    if (s.exists) step(`backup       → ${settingsPath}.bak`)
    console.log(`\nstatusLine block:\n${JSON.stringify(block, null, 2)}\n`)
    if (subBlock && subPlan !== 'keep') {
      console.log(
        `subagentStatusLine block:\n${JSON.stringify(subBlock, null, 2)}\n`,
      )
    }
    if (subPlan === 'keep') keepNotice(s.data?.subagentStatusLine)
    return
  }

  // 1) Write the statusline script (executable).
  writeStampedScript(scriptPath, version, updateCommand(opts))
  step(`wrote ${scriptPath} (v${version})`)

  // 2) Patch settings.json: back up, then merge only the statusLine key.
  const data: Settings = s.data ?? {}
  if (s.exists) {
    backup(settingsPath)
    step(`backed up ${settingsPath} → settings.json.bak`)
  } else {
    mkdirSync(dirname(settingsPath), { recursive: true })
  }
  data.statusLine = block
  if (subBlock && subPlan !== 'keep') data.subagentStatusLine = subBlock
  writeFileSync(settingsPath, JSON.stringify(data, null, 2) + '\n')
  step(
    `${alreadyOurs ? 'confirmed' : conflict ? 'replaced' : 'added'} statusLine in ${settingsPath}`,
  )
  if (subPlan === 'keep') keepNotice(s.data?.subagentStatusLine)
  else if (subPlan !== null) {
    const verb = { add: 'added', confirm: 'confirmed', replace: 'replaced' }[
      subPlan
    ]
    step(`${verb} subagentStatusLine in ${settingsPath}`)
  }

  const targetName =
    opts.targetCli === 'antigravity' ? 'Antigravity CLI' : 'Claude Code'
  console.log(
    `\n${green('Done.')} Restart ${targetName} to see the statusline.\n`,
  )
}

import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  SCRIPT_SOURCE,
  scriptTarget,
  settingsTarget,
  statusLineCommand,
} from '../core/paths'
import { backup, readSettings } from '../core/settings'
import { checkBash, checkJq, checkPlatform } from '../infra/system'
import { bold, err, green, step, warn } from '../shared/logger'
import type { Options, Settings, StatusLineBlock } from '../shared/types'

export function cmdInit(opts: Options): void {
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
    console.log(JSON.stringify({ statusLine: block }, null, 2) + '\n')
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

  if (opts.dryRun) {
    console.log(bold('\n[dry-run] would:'))
    step(`write script  → ${scriptPath}`)
    step(`${s.exists ? 'patch' : 'create'} settings → ${settingsPath}`)
    if (s.exists) step(`backup       → ${settingsPath}.bak`)
    console.log(`\nstatusLine block:\n${JSON.stringify(block, null, 2)}\n`)
    return
  }

  // 1) Write the statusline script (executable).
  mkdirSync(dirname(scriptPath), { recursive: true })
  copyFileSync(SCRIPT_SOURCE, scriptPath)
  chmodSync(scriptPath, 0o755)
  step(`wrote ${scriptPath}`)

  // 2) Patch settings.json: back up, then merge only the statusLine key.
  const data: Settings = s.data ?? {}
  if (s.exists) {
    backup(settingsPath)
    step(`backed up ${settingsPath} → settings.json.bak`)
  } else {
    mkdirSync(dirname(settingsPath), { recursive: true })
  }
  data.statusLine = block
  writeFileSync(settingsPath, JSON.stringify(data, null, 2) + '\n')
  step(
    `${alreadyOurs ? 'confirmed' : conflict ? 'replaced' : 'added'} statusLine in ${settingsPath}`,
  )

  console.log(
    `\n${green('Done.')} Restart Claude Code to see the statusline.\n`,
  )
}

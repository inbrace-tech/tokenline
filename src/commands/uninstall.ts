import { existsSync, unlinkSync, writeFileSync } from 'node:fs'

import { scriptTarget, settingsTarget } from '../core/paths'
import { backup, isTokenlineCommand, readSettings } from '../core/settings'
import { bold, green, step, warn } from '../shared/logger'
import type { Options } from '../shared/types'

export function cmdUninstall(opts: Options): void {
  console.log(bold('\ntokenline — uninstall\n'))
  const settingsPath = settingsTarget(opts)
  const s = readSettings(settingsPath)

  if (!s.exists || s.data === null) {
    warn(`No usable settings at ${settingsPath} — nothing to remove.`)
  } else if (isTokenlineCommand(s.data.statusLine?.command)) {
    if (opts.dryRun) {
      step(`[dry-run] would remove statusLine from ${settingsPath}`)
    } else {
      backup(settingsPath)
      delete s.data.statusLine
      writeFileSync(settingsPath, JSON.stringify(s.data, null, 2) + '\n')
      step(
        `removed statusLine from ${settingsPath} (backup: settings.json.bak)`,
      )
    }
  } else {
    step(`No tokenline statusLine in ${settingsPath} — left untouched.`)
  }

  if (opts.purge) {
    const scriptPath = scriptTarget(opts)
    if (existsSync(scriptPath)) {
      if (opts.dryRun) step(`[dry-run] would delete ${scriptPath}`)
      else {
        unlinkSync(scriptPath)
        step(`deleted ${scriptPath}`)
      }
    }
  }
  console.log(`\n${green('Done.')} Restart Claude Code.\n`)
}

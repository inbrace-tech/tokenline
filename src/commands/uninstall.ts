import { existsSync, unlinkSync, writeFileSync } from 'node:fs'

import { scriptTarget, settingsTarget } from '../core/paths'
import { backup, readSettings, removeTokenlineBlocks } from '../core/settings'
import { bold, green, step, warn } from '../shared/logger'
import type { Options } from '../shared/types'

export function cmdUninstall(opts: Options): void {
  console.log(bold('\ntokenline — uninstall\n'))
  const settingsPath = settingsTarget(opts)
  const s = readSettings(settingsPath)

  const ours = (s.data ? removeTokenlineBlocks({ ...s.data }) : []).join(' + ')
  if (!s.exists || s.data === null) {
    warn(`No usable settings at ${settingsPath} — nothing to remove.`)
  } else if (ours !== '') {
    if (opts.dryRun) {
      step(`[dry-run] would remove ${ours} from ${settingsPath}`)
    } else {
      backup(settingsPath)
      removeTokenlineBlocks(s.data)
      writeFileSync(settingsPath, JSON.stringify(s.data, null, 2) + '\n')
      step(`removed ${ours} from ${settingsPath} (backup: settings.json.bak)`)
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
  const targetName =
    opts.targetCli === 'antigravity' ? 'Antigravity CLI' : 'Claude Code'
  console.log(`\n${green('Done.')} Restart ${targetName}.\n`)
}

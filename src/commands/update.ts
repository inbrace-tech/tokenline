import { existsSync } from 'node:fs'

import { settingsTarget } from '../core/paths'
import { readSettings } from '../core/settings'
import { scriptPathFromCommand, updateCommand } from '../core/stamp'
import { writeStampedScript } from '../infra/script'
import { bold, err, green, step } from '../shared/logger'
import type { Options } from '../shared/types'

// Overwrites the installed tokenline.sh with this package's version. The
// script is found through the target's statusLine, so settings.json is only
// read, never written — updating can't disturb the rest of the user's config.
export function cmdUpdate(opts: Options, version: string): void {
  console.log(bold('\ntokenline — updating the statusline\n'))

  const settingsPath = settingsTarget(opts)
  const s = readSettings(settingsPath)
  const scriptPath = scriptPathFromCommand(s.data?.statusLine?.command)

  if (scriptPath === null || !existsSync(scriptPath)) {
    err(`No installed tokenline.sh found through ${settingsPath}.`)
    const scope =
      opts.targetCli === 'antigravity' || opts.global ? '' : ' (or --global)'
    console.log(
      `\nInstall it first: npx @inbrace-tech/tokenline init${scope}\n`,
    )
    process.exitCode = 1
    return
  }

  if (opts.dryRun) {
    step(`[dry-run] would overwrite ${scriptPath} with v${version}`)
    return
  }

  writeStampedScript(scriptPath, version, updateCommand(opts))
  step(`updated ${scriptPath} → v${version}`)
  console.log(
    `\n${green('Done.')} The statusline picks up the new version on its next refresh.\n`,
  )
}

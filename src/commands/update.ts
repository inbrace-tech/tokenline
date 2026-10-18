import { existsSync } from 'node:fs'

import { settingsTarget } from '../core/paths'
import { readSettings } from '../core/settings'
import { scriptPathFromCommand, updateCommand } from '../core/stamp'
import { subagentRowsHint } from '../core/upgrade'
import { writeStampedScript } from '../infra/script'
import { bold, err, green, step, warn } from '../shared/logger'
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

  const hint = subagentRowsHint(s.data, opts, scriptPath)

  if (opts.dryRun) {
    step(`[dry-run] would overwrite ${scriptPath} with v${version}`)
    if (hint) subagentRowsNotice(hint)
    return
  }

  writeStampedScript(scriptPath, version, updateCommand(opts))
  step(`updated ${scriptPath} → v${version}`)
  console.log(
    `\n${green('Done.')} The statusline picks up the new version on its next refresh.\n`,
  )
  if (hint) subagentRowsNotice(hint)
}

// update only reads settings.json, so it can't wire subagent rows itself; it
// names the one command that does. init is idempotent: it confirms the
// existing statusLine and only adds subagentStatusLine.
function subagentRowsNotice(initCmd: string): void {
  warn('Subagent rows are available but not wired in these settings.')
  console.log(
    `  Each subagent in the agent panel can show its own cache countdown.\n` +
      `  Turn them on (your statusLine stays as is):\n\n    ${initCmd}\n`,
  )
}

import { dirname } from 'node:path'

import type { Settings, Target } from '../shared/types'
import { scriptTarget } from './paths'

// Command that re-runs `init` for the copy `update` just replaced. It must
// target the same place: without the original --dir, init would write a second
// script to the default path and repoint statusLine at it.
export function initCommand(o: Target, scriptPath: string): string {
  const parts = ['npx -y @inbrace-tech/tokenline@latest init']
  if (o.targetCli === 'antigravity') parts.push('--antigravity')
  else if (o.global) parts.push('--global')
  if (scriptPath !== scriptTarget({ ...o, dir: null })) {
    const dir = dirname(scriptPath)
    parts.push(dir.includes(' ') ? `--dir "${dir}"` : `--dir ${dir}`)
  }
  return parts.join(' ')
}

// `update` replaces the script but never edits settings.json, so a Claude Code
// install from before subagent rows stays without them. Returns the command
// that turns them on, or null when there is nothing to suggest: not Claude
// Code, unreadable settings, or a subagentStatusLine already there (tokenline's,
// or another tool's the user chose).
export function subagentRowsHint(
  data: Settings | null,
  o: Target,
  scriptPath: string,
): string | null {
  if (o.targetCli !== 'claude' || data === null) return null
  if (data.subagentStatusLine !== undefined) return null
  return initCommand(o, scriptPath)
}

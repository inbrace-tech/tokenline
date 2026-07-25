import { settingsTarget } from '../core/paths'
import { isTokenlineCommand, readSettings } from '../core/settings'
import { checkBash, checkJq, checkPlatform } from '../infra/system'
import { bold, ok, step, warn } from '../shared/logger'
import type { Target } from '../shared/types'

export function cmdDoctor(): void {
  console.log(bold('\ntokenline — environment check\n'))
  checkPlatform()
  checkBash()
  checkJq()

  const scopes: Array<{ label: string; target: Target }> = [
    {
      label: 'claude (project)',
      target: { global: false, dir: null, targetCli: 'claude' },
    },
    {
      label: 'claude (global)',
      target: { global: true, dir: null, targetCli: 'claude' },
    },
    {
      label: 'antigravity (global)',
      target: { global: true, dir: null, targetCli: 'antigravity' },
    },
  ]

  for (const scope of scopes) {
    const f = settingsTarget(scope.target)
    const s = readSettings(f)

    if (s.exists && s.data && isTokenlineCommand(s.data.statusLine?.command)) {
      ok(`${scope.label} settings: tokenline configured (${f})`)
    } else if (s.exists && s.data === null) {
      warn(`${scope.label} settings: invalid JSON (${f})`)
    } else {
      step(`${scope.label} settings: not configured (${f})`)
    }
  }
  console.log()
}

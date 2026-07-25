import { settingsTarget, targetLabel } from '../core/paths'
import { isTokenlineCommand, readSettings } from '../core/settings'
import { checkBash, checkJq, checkPlatform } from '../infra/system'
import { bold, ok, step, warn } from '../shared/logger'
import type { Target } from '../shared/types'

export function cmdDoctor(): void {
  console.log(bold('\ntokenline — environment check\n'))
  checkPlatform()
  checkBash()
  checkJq()

  const targets: Target[] = [
    { global: false, dir: null, targetCli: 'claude' },
    { global: true, dir: null, targetCli: 'claude' },
    { global: true, dir: null, targetCli: 'antigravity' },
  ]

  for (const target of targets) {
    const label = targetLabel(target)
    const f = settingsTarget(target)
    const s = readSettings(f)

    if (s.exists && s.data && isTokenlineCommand(s.data.statusLine?.command)) {
      ok(`${label} settings: tokenline configured (${f})`)
    } else if (s.exists && s.data === null) {
      warn(`${label} settings: invalid JSON (${f})`)
    } else {
      step(`${label} settings: not configured (${f})`)
    }
  }
  console.log()
}

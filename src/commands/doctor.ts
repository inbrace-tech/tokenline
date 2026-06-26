import { settingsTarget } from '../core/paths'
import { isTokenlineCommand, readSettings } from '../core/settings'
import { checkBash, checkJq, checkPlatform } from '../infra/system'
import { bold, ok, step, warn } from '../shared/logger'

export function cmdDoctor(): void {
  console.log(bold('\ntokenline — environment check\n'))
  checkPlatform()
  checkBash()
  checkJq()

  const scopes: Array<{ label: string; global: boolean }> = [
    { label: 'project', global: false },
    { label: 'global', global: true },
  ]

  for (const scope of scopes) {
    const f = settingsTarget({ global: scope.global, dir: null })
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

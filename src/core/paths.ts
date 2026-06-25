import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import type { Target } from '../shared/types'

// The bundled script ships next to this CLI's package root (see package.json
// "files"). In dev that resolves to the repo-root tokenline.sh.
export const SCRIPT_SOURCE = join(__dirname, '..', 'tokenline.sh')

export const claudeDir = (o: Target): string =>
  o.project ? resolve('.claude') : join(homedir(), '.claude')
export const scriptTarget = (o: Target): string =>
  o.dir ? resolve(o.dir, 'tokenline.sh') : join(claudeDir(o), 'tokenline.sh')
export const settingsTarget = (o: Target): string =>
  join(claudeDir(o), 'settings.json')

// Command the host CLI runs every second. Quote only when the path has a space,
// to stay byte-identical to the install.sh snippet in the common case.
export const statusLineCommand = (scriptPath: string): string =>
  scriptPath.includes(' ') ? `bash "${scriptPath}"` : `bash ${scriptPath}`

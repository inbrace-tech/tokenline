import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { SCRIPT_SOURCE } from '../core/paths'
import { stampScript } from '../core/stamp'

// Writes the bundled tokenline.sh to scriptPath (executable), stamped with the
// installed version and the command that updates this copy.
export function writeStampedScript(
  scriptPath: string,
  version: string,
  updateCmd: string,
): void {
  const stamped = stampScript(
    readFileSync(SCRIPT_SOURCE, 'utf8'),
    version,
    updateCmd,
  )
  mkdirSync(dirname(scriptPath), { recursive: true })
  writeFileSync(scriptPath, stamped)
  chmodSync(scriptPath, 0o755)
}

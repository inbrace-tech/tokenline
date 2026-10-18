import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

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
  writeExecutableAtomic(scriptPath, stamped)
}

// The host CLI runs this file every second, so it must never be seen half
// written: write a temp file next to it, then rename over it (atomic on one
// filesystem). A symlink the user placed at `path` (e.g. into a dotfiles repo)
// is resolved first, so the real file is updated and the link is kept.
export function writeExecutableAtomic(path: string, content: string): void {
  const target = existsSync(path) ? realpathSync(path) : path
  mkdirSync(dirname(target), { recursive: true })
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`)
  // 'wx' = O_CREAT | O_EXCL: fails instead of reusing or following whatever
  // already sits at the temp path, which is then left alone.
  writeFileSync(tmp, content, { flag: 'wx', mode: 0o755 })
  try {
    chmodSync(tmp, 0o755) // mode above is masked by the umask
    renameSync(tmp, target)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

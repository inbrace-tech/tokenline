import { spawnSync } from 'node:child_process'
import { platform } from 'node:os'

import { ok, warn } from '../shared/logger'

export function checkPlatform(): boolean {
  const p = platform()
  if (p === 'linux' || p === 'darwin') {
    ok(`platform: ${p} (supported)`)
    return true
  }
  warn(
    `platform: ${p} — supported on Linux/WSL2 and macOS; the bash statusline ` +
      `likely won't render yet (see roadmap). Use --force to install anyway.`,
  )
  return false
}

export function checkJq(): boolean {
  const r = spawnSync('jq', ['--version'], { encoding: 'utf8' })
  if (r.status === 0) {
    ok(String(r.stdout).trim())
    return true
  }
  warn(
    'jq not found — required at runtime. Install it (apt install jq / brew install jq).',
  )
  return false
}

export function checkBash(): boolean {
  const r = spawnSync('bash', ['--version'], { encoding: 'utf8' })
  if (r.status === 0) {
    const m = String(r.stdout).match(/version (\d+)\.(\d+)/)
    if (m && Number(m[1]) >= 4) {
      ok(`bash ${m[1]}.${m[2]}`)
      return true
    }
    warn(
      `bash ${m ? `${m[1]}.${m[2]}` : '?'} found — the script needs bash 4+.`,
    )
    return false
  }
  warn('bash not found — the statusline runs as a bash script.')
  return false
}

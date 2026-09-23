import { copyFileSync, existsSync, readFileSync } from 'node:fs'

import type { ReadResult, Settings } from '../shared/types'

// data is null when the file exists but is not valid JSON — callers must refuse
// to overwrite in that case (never clobber).
export function readSettings(file: string): ReadResult {
  if (!existsSync(file)) return { exists: false, data: {} }
  const raw = readFileSync(file, 'utf8')
  if (raw.trim() === '') return { exists: true, data: {}, raw }
  try {
    return { exists: true, data: JSON.parse(raw) as Settings, raw }
  } catch {
    return { exists: true, data: null, raw }
  }
}

export function backup(file: string): string {
  const bak = `${file}.bak`
  copyFileSync(file, bak)
  return bak
}

export const isTokenlineCommand = (cmd: string | undefined): boolean =>
  typeof cmd === 'string' && /tokenline\.sh/.test(cmd)

export type SubagentPlan = 'add' | 'confirm' | 'replace' | 'keep'

// What `init` does with subagentStatusLine. It is an extra on top of the main
// statusLine, so another tool's block there never blocks the install: it is
// kept ('keep') unless --force replaces it.
export function planSubagentStatusLine(
  existing: { command?: unknown } | undefined,
  command: string,
  force: boolean,
): SubagentPlan {
  if (existing === undefined) return 'add'
  if (existing.command === command) return 'confirm'
  return force ? 'replace' : 'keep'
}

// Removes every block tokenline owns from a parsed settings object, leaving
// other tools' blocks alone. Returns the keys it removed.
export function removeTokenlineBlocks(data: Settings): string[] {
  const removed: string[] = []
  if (isTokenlineCommand(data.statusLine?.command)) {
    delete data.statusLine
    removed.push('statusLine')
  }
  if (isTokenlineCommand(data.subagentStatusLine?.command)) {
    delete data.subagentStatusLine
    removed.push('subagentStatusLine')
  }
  return removed
}

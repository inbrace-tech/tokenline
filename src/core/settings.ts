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

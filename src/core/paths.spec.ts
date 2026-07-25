import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { baseConfigDir, scriptTarget, settingsTarget } from './paths'

describe('paths', () => {
  it('resolves project Claude config path by default', () => {
    const target = { global: false, dir: null }
    expect(baseConfigDir(target)).toBe(resolve('.claude'))
    expect(scriptTarget(target)).toBe(resolve('.claude/tokenline.sh'))
    expect(settingsTarget(target)).toBe(resolve('.claude/settings.json'))
  })

  it('resolves global Claude config path when global is true', () => {
    const target = { global: true, dir: null }
    expect(baseConfigDir(target)).toBe(join(homedir(), '.claude'))
    expect(scriptTarget(target)).toBe(join(homedir(), '.claude/tokenline.sh'))
    expect(settingsTarget(target)).toBe(
      join(homedir(), '.claude/settings.json'),
    )
  })

  it('resolves Antigravity CLI config path when targetCli is antigravity', () => {
    const target = {
      global: true,
      dir: null,
      targetCli: 'antigravity' as const,
    }
    expect(baseConfigDir(target)).toBe(
      join(homedir(), '.gemini', 'antigravity-cli'),
    )
    expect(scriptTarget(target)).toBe(
      join(homedir(), '.gemini', 'antigravity-cli', 'tokenline.sh'),
    )
    expect(settingsTarget(target)).toBe(
      join(homedir(), '.gemini', 'antigravity-cli', 'settings.json'),
    )
  })

  it('respects custom dir for scriptTarget even with antigravity targetCli', () => {
    const target = {
      global: true,
      dir: '/custom/dir',
      targetCli: 'antigravity' as const,
    }
    expect(scriptTarget(target)).toBe(resolve('/custom/dir/tokenline.sh'))
    expect(settingsTarget(target)).toBe(
      join(homedir(), '.gemini', 'antigravity-cli', 'settings.json'),
    )
  })
})

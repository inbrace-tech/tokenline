import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import type { Target } from '../shared/types'
import {
  baseConfigDir,
  claudeDir,
  scriptTarget,
  settingsTarget,
  statusLineCommand,
  targetLabel,
} from './paths'

describe('paths', () => {
  it('should resolve project Claude config path by default', () => {
    const target: Target = { global: false, dir: null, targetCli: 'claude' }
    expect(baseConfigDir(target)).toBe(resolve('.claude'))
    expect(scriptTarget(target)).toBe(resolve('.claude/tokenline.sh'))
    expect(settingsTarget(target)).toBe(resolve('.claude/settings.json'))
    expect(targetLabel(target)).toBe('claude (project)')
  })

  it('should resolve global Claude config path when global is true', () => {
    const target: Target = { global: true, dir: null, targetCli: 'claude' }
    expect(baseConfigDir(target)).toBe(join(homedir(), '.claude'))
    expect(scriptTarget(target)).toBe(join(homedir(), '.claude/tokenline.sh'))
    expect(settingsTarget(target)).toBe(
      join(homedir(), '.claude/settings.json'),
    )
    expect(targetLabel(target)).toBe('claude (global)')
  })

  it('should resolve Antigravity CLI config path when targetCli is antigravity', () => {
    const target: Target = { global: true, dir: null, targetCli: 'antigravity' }
    expect(baseConfigDir(target)).toBe(
      join(homedir(), '.gemini', 'antigravity-cli'),
    )
    expect(scriptTarget(target)).toBe(
      join(homedir(), '.gemini', 'antigravity-cli', 'tokenline.sh'),
    )
    expect(settingsTarget(target)).toBe(
      join(homedir(), '.gemini', 'antigravity-cli', 'settings.json'),
    )
    expect(targetLabel(target)).toBe('antigravity (global)')
  })

  it('should respect custom dir for scriptTarget even with antigravity targetCli', () => {
    const target: Target = {
      global: true,
      dir: '/custom/dir',
      targetCli: 'antigravity',
    }
    expect(scriptTarget(target)).toBe(resolve('/custom/dir/tokenline.sh'))
    expect(settingsTarget(target)).toBe(
      join(homedir(), '.gemini', 'antigravity-cli', 'settings.json'),
    )
  })
})

describe('claudeDir', () => {
  it('is the project .claude dir by default and ~/.claude with --global', () => {
    expect(claudeDir({ global: false, dir: null, targetCli: 'claude' })).toBe(
      resolve('.claude'),
    )
    expect(claudeDir({ global: true, dir: null, targetCli: 'claude' })).toBe(
      join(homedir(), '.claude'),
    )
  })
})

describe('--dir override', () => {
  it('moves only the script for a project install; settings stay in .claude', () => {
    const target: Target = {
      global: false,
      dir: '/home/u/bin',
      targetCli: 'claude',
    }
    expect(scriptTarget(target)).toBe(resolve('/home/u/bin/tokenline.sh'))
    expect(settingsTarget(target)).toBe(resolve('.claude/settings.json'))
  })

  it('moves only the script for a global install; settings stay in ~/.claude', () => {
    const target: Target = {
      global: true,
      dir: '/home/u/bin',
      targetCli: 'claude',
    }
    expect(scriptTarget(target)).toBe(resolve('/home/u/bin/tokenline.sh'))
    expect(settingsTarget(target)).toBe(
      join(homedir(), '.claude/settings.json'),
    )
  })

  it('resolves a relative --dir against the working directory', () => {
    const target: Target = { global: false, dir: 'bin', targetCli: 'claude' }
    expect(scriptTarget(target)).toBe(resolve('bin', 'tokenline.sh'))
  })
})

describe('statusLineCommand', () => {
  it('leaves a space-free path unquoted, matching the install.sh snippet', () => {
    expect(statusLineCommand('/p/tokenline.sh')).toBe('bash /p/tokenline.sh')
  })

  it('quotes a path that contains a space', () => {
    expect(statusLineCommand('/My Drive/tokenline.sh')).toBe(
      'bash "/My Drive/tokenline.sh"',
    )
  })
})

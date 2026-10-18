import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Target } from '../shared/types'
import { statusLineCommand } from './paths'
import {
  CURL_UPDATE_CMD,
  scriptPathFromCommand,
  stampScript,
  updateCommand,
} from './stamp'

const REPO_SCRIPT = readFileSync(
  join(__dirname, '..', '..', 'tokenline.sh'),
  'utf8',
)

describe('updateCommand', () => {
  const t = (o: Partial<Target>): Target => ({
    global: false,
    dir: null,
    targetCli: 'claude',
    ...o,
  })

  it('targets the project by default, global and antigravity by flag', () => {
    expect(updateCommand(t({}))).toBe(
      'npx -y @inbrace-tech/tokenline@latest update',
    )
    expect(updateCommand(t({ global: true }))).toBe(
      'npx -y @inbrace-tech/tokenline@latest update --global',
    )
    expect(updateCommand(t({ targetCli: 'antigravity', global: true }))).toBe(
      'npx -y @inbrace-tech/tokenline@latest update --antigravity',
    )
  })

  it('needs no --dir flag: update finds a custom dir through settings', () => {
    expect(updateCommand(t({ global: true, dir: '/opt/tl' }))).toBe(
      'npx -y @inbrace-tech/tokenline@latest update --global',
    )
  })
})

describe('stampScript', () => {
  it('stamps the repo tokenline.sh: both lines filled, nothing else changed', () => {
    const cmd = 'npx -y @inbrace-tech/tokenline@latest update --global'
    const out = stampScript(REPO_SCRIPT, '1.2.5', cmd)

    expect(out).toContain('\nTOKENLINE_VERSION="1.2.5"\n')
    expect(out).toContain(`\nTOKENLINE_UPDATE_CMD='${cmd}'\n`)
    expect(out).not.toContain('TOKENLINE_VERSION=""')
    expect(out).not.toContain('TOKENLINE_UPDATE_CMD=""')
    const diff = out
      .split('\n')
      .filter((l, i) => l !== REPO_SCRIPT.split('\n')[i])
    expect(diff).toHaveLength(2)
  })

  it('keeps a curl pipeline intact inside single quotes', () => {
    const cmd = 'curl -fsSL https://example.com/install.sh | bash'
    expect(stampScript(REPO_SCRIPT, '1.0.0', cmd)).toContain(
      `TOKENLINE_UPDATE_CMD='${cmd}'`,
    )
  })

  it('stamps the release asset command: latest install.sh, piped to bash', () => {
    expect(CURL_UPDATE_CMD).toBe(
      'curl -fsSL https://github.com/inbrace-tech/tokenline/releases/latest/download/install.sh | bash',
    )
    expect(stampScript(REPO_SCRIPT, '1.3.0', CURL_UPDATE_CMD)).toContain(
      `\nTOKENLINE_UPDATE_CMD='${CURL_UPDATE_CMD}'\n`,
    )
  })

  it('rejects a version that is not plain x.y.z', () => {
    for (const v of ['1.2', '1.2.3-beta.1', 'v1.2.3', '1.2.3"; rm -rf ~; "']) {
      expect(() => stampScript(REPO_SCRIPT, v, 'x')).toThrow(/Invalid version/)
    }
  })

  it('rejects an update command that would break out of its quotes', () => {
    expect(() => stampScript(REPO_SCRIPT, '1.0.0', "x' ; evil '")).toThrow(
      /single quote/,
    )
  })

  it('throws when a placeholder is missing or repeated (never ship unstamped)', () => {
    const missing = REPO_SCRIPT.replace('TOKENLINE_VERSION=""', '')
    expect(() => stampScript(missing, '1.0.0', 'x')).toThrow(/exactly one/)

    const stamped = stampScript(REPO_SCRIPT, '1.0.0', 'x')
    expect(() => stampScript(stamped, '1.0.1', 'x')).toThrow(/exactly one/)

    const twice = `${REPO_SCRIPT}\nTOKENLINE_UPDATE_CMD=""\n`
    expect(() => stampScript(twice, '1.0.0', 'x')).toThrow(/exactly one/)
  })
})

describe('scriptPathFromCommand', () => {
  it('round-trips every command init writes', () => {
    for (const p of ['/home/u/.claude/tokenline.sh', '/a dir/tokenline.sh']) {
      expect(scriptPathFromCommand(statusLineCommand(p))).toBe(p)
    }
  })

  it('refuses anything init did not write (never overwrite a foreign file)', () => {
    for (const cmd of [
      undefined,
      '',
      'bash $CLAUDE_PROJECT_DIR/tokenline.sh',
      'bash "$HOME/.claude/tokenline.sh"',
      'bash /home/u/.claude/other.sh',
      'bash /home/u/.claude/tokenline.sh --flag',
      'sh /home/u/.claude/tokenline.sh',
      'bash /home/u/.claude/my-tokenline.sh',
    ]) {
      expect(scriptPathFromCommand(cmd)).toBeNull()
    }
  })
})

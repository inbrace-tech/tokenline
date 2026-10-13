import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import type { Target } from '../shared/types'
import { initCommand, subagentRowsHint } from './upgrade'

const t = (o: Partial<Target>): Target => ({
  global: false,
  dir: null,
  targetCli: 'claude',
  ...o,
})
const globalScript = join(homedir(), '.claude', 'tokenline.sh')
const statusLine = {
  type: 'command' as const,
  command: `bash ${globalScript}`,
  refreshInterval: 1,
}

describe('initCommand', () => {
  it('re-runs init for the same scope', () => {
    expect(initCommand(t({ global: true }), globalScript)).toBe(
      'npx -y @inbrace-tech/tokenline@latest init --global',
    )
    expect(initCommand(t({}), resolve('.claude', 'tokenline.sh'))).toBe(
      'npx -y @inbrace-tech/tokenline@latest init',
    )
  })

  it('keeps a custom --dir, so init does not install a second copy elsewhere', () => {
    expect(initCommand(t({ global: true }), '/opt/tl/tokenline.sh')).toBe(
      'npx -y @inbrace-tech/tokenline@latest init --global --dir /opt/tl',
    )
    expect(initCommand(t({ global: true }), '/my tools/tokenline.sh')).toBe(
      'npx -y @inbrace-tech/tokenline@latest init --global --dir "/my tools"',
    )
  })
})

describe('subagentRowsHint', () => {
  it('suggests init when a Claude Code install has no subagentStatusLine', () => {
    expect(
      subagentRowsHint({ statusLine }, t({ global: true }), globalScript),
    ).toBe('npx -y @inbrace-tech/tokenline@latest init --global')
  })

  it('stays quiet when subagent rows are already wired, by tokenline or another tool', () => {
    const ours = { statusLine, subagentStatusLine: statusLine }
    const other = {
      statusLine,
      subagentStatusLine: {
        type: 'command' as const,
        command: 'bash other.sh',
      },
    }

    expect(subagentRowsHint(ours, t({ global: true }), globalScript)).toBeNull()
    expect(
      subagentRowsHint(other, t({ global: true }), globalScript),
    ).toBeNull()
  })

  it('stays quiet for Antigravity, which has no agent panel, and for unreadable settings', () => {
    expect(
      subagentRowsHint(
        { statusLine },
        t({ targetCli: 'antigravity', global: true }),
        globalScript,
      ),
    ).toBeNull()
    expect(subagentRowsHint(null, t({ global: true }), globalScript)).toBeNull()
  })
})

export type CliTarget = 'claude' | 'antigravity'

export interface Options {
  _: string[]
  targetCli: CliTarget
  dir: string | null
  global: boolean
  dryRun: boolean
  force: boolean
  purge: boolean
  subagents: boolean
  help: boolean
  version: boolean
  unknown: string[]
}

export interface StatusLineBlock {
  type: 'command'
  command: string
  refreshInterval: number
}

// Claude Code's agent panel: one row per subagent. It runs on the panel's own
// refresh tick, so the block takes no refreshInterval.
export interface SubagentStatusLineBlock {
  type: 'command'
  command: string
}

export interface Settings {
  statusLine?: StatusLineBlock
  subagentStatusLine?: SubagentStatusLineBlock
  [key: string]: unknown
}

export interface ReadResult {
  exists: boolean
  data: Settings | null
  raw?: string
}

export type Target = Pick<Options, 'global' | 'dir' | 'targetCli'>

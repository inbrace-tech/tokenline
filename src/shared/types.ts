export interface Options {
  _: string[]
  dir: string | null
  global: boolean
  dryRun: boolean
  force: boolean
  purge: boolean
  help: boolean
  version: boolean
  unknown: string[]
}

export interface StatusLineBlock {
  type: 'command'
  command: string
  refreshInterval: number
}

export interface Settings {
  statusLine?: StatusLineBlock
  [key: string]: unknown
}

export interface ReadResult {
  exists: boolean
  data: Settings | null
  raw?: string
}

export type Target = Pick<Options, 'global' | 'dir'>

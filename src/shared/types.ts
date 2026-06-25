export interface Options {
  _: string[]
  dir: string | null
  project: boolean
  dryRun: boolean
  force: boolean
  purge: boolean
  help: boolean
  version: boolean
  unknown: string | null
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

export type Target = Pick<Options, 'project' | 'dir'>

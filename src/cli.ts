#!/usr/bin/env node
// =============================================================================
// @inbrace-tech/tokenline — installer CLI
//
// Install-time only. Copies tokenline.sh to a stable path and wires it into
// your Claude Code settings.json. The statusline itself runs as
// `bash tokenline.sh` — there is NO Node in the per-second hot path.
//
//   npx @inbrace-tech/tokenline init              # install into ~/.claude
//   npx @inbrace-tech/tokenline init --project    # install into ./.claude
//   npx @inbrace-tech/tokenline doctor            # check deps, change nothing
//   npx @inbrace-tech/tokenline uninstall         # remove the statusLine block
//
// Authored in TypeScript; published as compiled dist/cli.js. Zero runtime
// dependencies — only Node built-ins.
// =============================================================================

import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const PKG = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
) as { version: string }

// --- Types -------------------------------------------------------------------
interface Options {
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

interface StatusLineBlock {
  type: 'command'
  command: string
  refreshInterval: number
}

interface Settings {
  statusLine?: StatusLineBlock
  [key: string]: unknown
}

interface ReadResult {
  exists: boolean
  data: Settings | null
  raw?: string
}

type Target = Pick<Options, 'project' | 'dir'>

// --- Output helpers (color only on a TTY, honoring NO_COLOR) ------------------
const COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
const paint = (code: string, s: string): string =>
  COLOR ? `\x1b[${code}m${s}\x1b[0m` : s
const bold = (s: string): string => paint('1', s)
const dim = (s: string): string => paint('2', s)
const green = (s: string): string => paint('32', s)
const red = (s: string): string => paint('31', s)
const yellow = (s: string): string => paint('33', s)

const ok = (m: string): void => console.log(`${green('✓')} ${m}`)
const warn = (m: string): void => console.log(`${yellow('!')} ${m}`)
const err = (m: string): void => console.error(`${red('✗')} ${m}`)
const step = (m: string): void => console.log(`${dim('→')} ${m}`)

// --- Argument parsing (no deps) ----------------------------------------------
function parseArgs(argv: string[]): Options {
  const out: Options = {
    _: [],
    dir: null,
    project: false,
    dryRun: false,
    force: false,
    purge: false,
    help: false,
    version: false,
    unknown: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--dir':
        out.dir = argv[++i] ?? null
        break
      case '--project':
      case '--local':
        out.project = true
        break
      case '--dry-run':
        out.dryRun = true
        break
      case '--force':
        out.force = true
        break
      case '--purge':
        out.purge = true
        break
      case '-h':
      case '--help':
        out.help = true
        break
      case '-v':
      case '--version':
        out.version = true
        break
      default:
        if (a !== undefined && a.startsWith('-')) out.unknown = a
        else if (a !== undefined) out._.push(a)
    }
  }
  return out
}

// --- Paths -------------------------------------------------------------------
// The bundled script ships next to this CLI's package root (see package.json
// "files"). In dev that resolves to the repo-root tokenline.sh.
const SCRIPT_SOURCE = join(__dirname, '..', 'tokenline.sh')

const claudeDir = (o: Target): string =>
  o.project ? resolve('.claude') : join(homedir(), '.claude')
const scriptTarget = (o: Target): string =>
  o.dir ? resolve(o.dir, 'tokenline.sh') : join(claudeDir(o), 'tokenline.sh')
const settingsTarget = (o: Target): string =>
  join(claudeDir(o), 'settings.json')

// Command the host CLI runs every second. Quote only when the path has a space,
// to stay byte-identical to the install.sh snippet in the common case.
const statusLineCommand = (scriptPath: string): string =>
  scriptPath.includes(' ') ? `bash "${scriptPath}"` : `bash ${scriptPath}`

// --- Dependency / environment checks -----------------------------------------
function checkPlatform(): boolean {
  const p = platform()
  if (p === 'linux') {
    ok(`platform: ${p} (supported)`)
    return true
  }
  warn(
    `platform: ${p} — v1 targets Linux/WSL2; the bash statusline likely won't ` +
      `render yet (see roadmap). Use --force to install anyway.`,
  )
  return false
}

function checkJq(): boolean {
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

function checkBash(): boolean {
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

// --- settings.json read / backup ---------------------------------------------
// data is null when the file exists but is not valid JSON — callers must refuse
// to overwrite in that case (never clobber).
function readSettings(file: string): ReadResult {
  if (!existsSync(file)) return { exists: false, data: {} }
  const raw = readFileSync(file, 'utf8')
  if (raw.trim() === '') return { exists: true, data: {}, raw }
  try {
    return { exists: true, data: JSON.parse(raw) as Settings, raw }
  } catch {
    return { exists: true, data: null, raw }
  }
}

function backup(file: string): string {
  const bak = `${file}.bak`
  copyFileSync(file, bak)
  return bak
}

const isTokenlineCommand = (cmd: string | undefined): boolean =>
  typeof cmd === 'string' && /tokenline\.sh/.test(cmd)

// --- Commands ----------------------------------------------------------------
function cmdDoctor(): void {
  console.log(bold('\ntokenline — environment check\n'))
  checkPlatform()
  checkBash()
  checkJq()
  const scopes: Array<{ label: string; project: boolean }> = [
    { label: 'global', project: false },
    { label: 'project', project: true },
  ]
  for (const scope of scopes) {
    const f = settingsTarget({ project: scope.project, dir: null })
    const s = readSettings(f)
    if (s.exists && s.data && isTokenlineCommand(s.data.statusLine?.command)) {
      ok(`${scope.label} settings: tokenline configured (${f})`)
    } else if (s.exists && s.data === null) {
      warn(`${scope.label} settings: invalid JSON (${f})`)
    } else {
      step(`${scope.label} settings: not configured (${f})`)
    }
  }
  console.log()
}

function cmdInit(opts: Options): void {
  console.log(bold('\ntokenline — installing the statusline\n'))

  const supported = checkPlatform()
  if (!supported && !opts.force) {
    err('Unsupported platform. Re-run with --force to install anyway.')
    process.exitCode = 1
    return
  }
  checkBash()
  checkJq()

  const scriptPath = scriptTarget(opts)
  const settingsPath = settingsTarget(opts)
  const block: StatusLineBlock = {
    type: 'command',
    command: statusLineCommand(scriptPath),
    refreshInterval: 1,
  }

  // Read settings first so we can fail safely *before* writing anything.
  const s = readSettings(settingsPath)
  if (s.exists && s.data === null) {
    err(`Could not parse ${settingsPath} (invalid JSON). Leaving it untouched.`)
    console.log('\nAdd this block manually, inside the top-level object:\n')
    console.log(JSON.stringify({ statusLine: block }, null, 2) + '\n')
    process.exitCode = 1
    return
  }

  const existing = s.data ? s.data.statusLine : undefined
  const alreadyOurs =
    existing !== undefined && existing.command === block.command
  const conflict = existing !== undefined && !alreadyOurs
  if (conflict && !opts.force) {
    err(`A different statusLine is already configured in ${settingsPath}:`)
    console.log(`    ${JSON.stringify(existing)}`)
    warn('Re-run with --force to replace it.')
    process.exitCode = 1
    return
  }

  if (opts.dryRun) {
    console.log(bold('\n[dry-run] would:'))
    step(`write script  → ${scriptPath}`)
    step(`${s.exists ? 'patch' : 'create'} settings → ${settingsPath}`)
    if (s.exists) step(`backup       → ${settingsPath}.bak`)
    console.log(`\nstatusLine block:\n${JSON.stringify(block, null, 2)}\n`)
    return
  }

  // 1) Write the statusline script (executable).
  mkdirSync(dirname(scriptPath), { recursive: true })
  copyFileSync(SCRIPT_SOURCE, scriptPath)
  chmodSync(scriptPath, 0o755)
  step(`wrote ${scriptPath}`)

  // 2) Patch settings.json: back up, then merge only the statusLine key.
  const data: Settings = s.data ?? {}
  if (s.exists) {
    backup(settingsPath)
    step(`backed up ${settingsPath} → settings.json.bak`)
  } else {
    mkdirSync(dirname(settingsPath), { recursive: true })
  }
  data.statusLine = block
  writeFileSync(settingsPath, JSON.stringify(data, null, 2) + '\n')
  step(
    `${alreadyOurs ? 'confirmed' : conflict ? 'replaced' : 'added'} statusLine in ${settingsPath}`,
  )

  console.log(
    `\n${green('Done.')} Restart Claude Code to see the statusline.\n`,
  )
}

function cmdUninstall(opts: Options): void {
  console.log(bold('\ntokenline — uninstall\n'))
  const settingsPath = settingsTarget(opts)
  const s = readSettings(settingsPath)

  if (!s.exists || s.data === null) {
    warn(`No usable settings at ${settingsPath} — nothing to remove.`)
  } else if (isTokenlineCommand(s.data.statusLine?.command)) {
    if (opts.dryRun) {
      step(`[dry-run] would remove statusLine from ${settingsPath}`)
    } else {
      backup(settingsPath)
      delete s.data.statusLine
      writeFileSync(settingsPath, JSON.stringify(s.data, null, 2) + '\n')
      step(
        `removed statusLine from ${settingsPath} (backup: settings.json.bak)`,
      )
    }
  } else {
    step(`No tokenline statusLine in ${settingsPath} — left untouched.`)
  }

  if (opts.purge) {
    const scriptPath = scriptTarget(opts)
    if (existsSync(scriptPath)) {
      if (opts.dryRun) step(`[dry-run] would delete ${scriptPath}`)
      else {
        unlinkSync(scriptPath)
        step(`deleted ${scriptPath}`)
      }
    }
  }
  console.log(`\n${green('Done.')} Restart Claude Code.\n`)
}

function help(): void {
  console.log(`
${bold('tokenline')} — a cache-aware statusline for AI coding CLIs

${bold('Usage')}
  npx @inbrace-tech/tokenline <command> [options]

${bold('Commands')}
  init          Install tokenline.sh and wire it into your Claude Code settings
  doctor        Check dependencies and current config — changes nothing
  uninstall     Remove the tokenline statusLine block from settings

${bold('Options')}
  --project     Target ./.claude (project) instead of ~/.claude (global)
  --dir <path>  Write tokenline.sh to a custom directory
  --dry-run     Show what would happen without writing anything
  --force       Proceed on an unsupported platform / replace an existing statusLine
  --purge       (uninstall) also delete the installed tokenline.sh
  -h, --help    Show this help
  -v, --version Show version

${bold('Notes')}
  The statusline runs as 'bash tokenline.sh' — no Node in the per-second hot path.
  jq is required at runtime; this installer checks for it but cannot install it.
`)
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.unknown) warn(`ignoring unknown option: ${opts.unknown}`)
  if (opts.version) {
    console.log(PKG.version)
    return
  }
  if (opts.help || opts._.length === 0) {
    help()
    return
  }

  try {
    switch (opts._[0]) {
      case 'init':
        cmdInit(opts)
        break
      case 'doctor':
        cmdDoctor()
        break
      case 'uninstall':
      case 'remove':
        cmdUninstall(opts)
        break
      default:
        err(`Unknown command: ${opts._[0]}`)
        help()
        process.exitCode = 1
    }
  } catch (e) {
    err(e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  }
}

main()

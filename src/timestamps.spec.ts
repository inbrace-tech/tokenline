import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The cache countdown starts at the last turn's transcript timestamp: Claude
// Code's `.timestamp` or Antigravity's `.created_at`. When the script cannot
// parse it, it falls back to the transcript's mtime. These specs set the mtime
// an hour back, so a failed parse shows COLD and a good one shows the
// countdown from a turn 70s ago. They run on GNU tools and on BSD shims.

const SCRIPT = join(__dirname, '..', 'tokenline.sh')
const hasJq = spawnSync('jq', ['--version']).status === 0
const hasGnuTools =
  spawnSync('date', ['-d', '@0']).status === 0 &&
  spawnSync('stat', ['-c', '%Y', '.']).status === 0
// eslint-disable-next-line no-control-regex
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')
const realBin = (name: string): string =>
  spawnSync('bash', ['-c', `command -v ${name}`], {
    encoding: 'utf8',
  }).stdout.trim()

let dir: string
let session = 0
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tokenline-timestamps-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// 70s ago, written as Antigravity does (`2026-01-02T03:04:05Z`: no fraction).
const turnAt = (): Date => new Date((Math.floor(Date.now() / 1000) - 70) * 1000)
const antigravityIso = (d: Date): string =>
  d.toISOString().replace(/\.\d{3}Z$/, 'Z')

function render(
  turn: Record<string, unknown>,
  model: string,
  env: NodeJS.ProcessEnv = {},
): string {
  const transcript = join(dir, 'transcript.jsonl')
  writeFileSync(transcript, JSON.stringify(turn) + '\n')
  const hourAgo = Date.now() / 1000 - 3600
  utimesSync(transcript, hourAgo, hourAgo)
  const r = spawnSync('bash', [SCRIPT], {
    input: JSON.stringify({
      model: { display_name: model },
      session_id: `ts-${++session}`,
      transcript_path: transcript,
    }),
    encoding: 'utf8',
    env: { ...process.env, XDG_RUNTIME_DIR: dir, ...env },
  })
  expect(r.status).toBe(0)
  return plain(r.stdout).split('\n')[0]
}

const planner = (createdAt: string) => ({
  type: 'PLANNER_RESPONSE',
  created_at: createdAt,
})
const assistant = (timestamp: string) => ({
  type: 'assistant',
  timestamp,
  message: { usage: { cache_creation: { ephemeral_5m_input_tokens: 10 } } },
})

// Each case: what the transcript holds, and the model that wrote it.
const cases: [string, () => [Record<string, unknown>, string]][] = [
  [
    'Antigravity .created_at (YYYY-MM-DDTHH:MM:SSZ)',
    () => [planner(antigravityIso(turnAt())), 'Gemini 3 Pro'],
  ],
  [
    'Antigravity .created_at with fractional seconds',
    () => [planner(turnAt().toISOString()), 'Gemini 3 Pro'],
  ],
  [
    'Antigravity .created_at with a +00:00 offset',
    () => [
      planner(antigravityIso(turnAt()).replace(/Z$/, '+00:00')),
      'Gemini 3 Pro',
    ],
  ],
  [
    'Claude Code .timestamp (milliseconds and Z)',
    () => [assistant(turnAt().toISOString()), 'Opus 5.5'],
  ],
]

describe.skipIf(!hasJq || !hasGnuTools)(
  'tokenline.sh — transcript timestamp on GNU date',
  () => {
    it.each(cases)('counts down from the %s', (_, make) => {
      const [turn, model] = make()
      expect(render(turn, model)).toMatch(/\[5m\] cache: 3:[345]\d HOT/)
    })
  },
)

// macOS ships BSD `date`, which has no -d and parses with `-j -f <format>`.
// This shim behaves like it, and is strict: the string must match the format,
// or it fails like BSD's "failed conversion". So a pass proves the script's
// fixed mask fits the format, not just that GNU `date` is lenient.
describe.skipIf(!hasJq || !hasGnuTools)(
  'tokenline.sh — transcript timestamp on BSD date (macOS)',
  () => {
    let bsdEnv: NodeJS.ProcessEnv

    beforeEach(() => {
      const shimDir = join(dir, 'bsd-bin')
      mkdirSync(shimDir)
      writeFileSync(
        join(shimDir, 'date'),
        `#!/usr/bin/env bash
real='${realBin('date')}'
[ "$1" = "-d" ] && exit 1
if [ "$1 $2 $3" = "-u -j -f" ]; then
  re="$4"
  for f in Y m d H M S; do
    if [ "$f" = Y ]; then n=4; else n=2; fi
    re="\${re//%$f/[0-9]{$n\\}}"
  done
  [[ "$5" =~ ^$re ]] || { echo "date: failed conversion" >&2; exit 1; }
  exec "$real" -u -d "$5" "$6"
fi
exec "$real" "$@"
`,
        { mode: 0o755 },
      )
      bsdEnv = { PATH: `${shimDir}:${process.env.PATH ?? ''}` }
    })

    it.each(cases)('counts down from the %s', (_, make) => {
      const [turn, model] = make()
      expect(render(turn, model, bsdEnv)).toMatch(/\[5m\] cache: 3:[345]\d HOT/)
    })

    it('rejects a string off the mask, so a failed parse shows up as COLD', () => {
      // Guards the shim itself: a space separator does not fit the mask, and
      // the script falls back to the hour-old mtime.
      const spaced = antigravityIso(turnAt()).replace('T', ' ')
      expect(render(planner(spaced), 'Gemini 3 Pro', bsdEnv)).toContain(
        '[5m] cache: COLD',
      )
    })
  },
)

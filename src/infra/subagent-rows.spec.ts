import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Drives the real tokenline.sh in subagentStatusLine mode: a payload with a
// `tasks` array on stdin, one {"id","content"} JSON line per row on stdout.
// Transcripts are written under a throwaway dir, and XDG_RUNTIME_DIR points
// there too, so the per-subagent state never touches the developer's own.

const SCRIPT = join(__dirname, '..', '..', 'tokenline.sh')
const hasJq = spawnSync('jq', ['--version']).status === 0
const ESC = '\u001b'
const BLINK = `${ESC}[1;5m`
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')
const plain = (s: string): string => s.replace(SGR, '')

let dir: string
let now: number
const iso = (secondsAgo: number): string =>
  new Date((now - secondsAgo) * 1000).toISOString()
const line = (o: unknown): string => JSON.stringify(o) + '\n'

const assistant = (
  secondsAgo: number,
  opts: { write5m?: number; tool?: string } = {},
) =>
  line({
    type: 'assistant',
    timestamp: iso(secondsAgo),
    message: {
      usage: {
        cache_creation: {
          ephemeral_5m_input_tokens: opts.write5m ?? 0,
          ephemeral_1h_input_tokens: 0,
        },
      },
      content: opts.tool
        ? [{ type: 'tool_use', name: opts.tool }]
        : [{ type: 'text', text: 'ok' }],
    },
  })
const toolResult = line({
  type: 'user',
  message: { content: [{ type: 'tool_result' }] },
})

function render(
  payload: unknown,
  env: NodeJS.ProcessEnv = {},
): { status: number | null; rows: Row[] } {
  const r = spawnSync('bash', [SCRIPT], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, XDG_RUNTIME_DIR: dir, ...env },
  })
  const rows = r.stdout
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Row)
  return { status: r.status, rows }
}
interface Row {
  id: string
  content: string
}

function payload(columns: number) {
  return {
    session_id: 'sess-1',
    transcript_path: join(dir, 'proj', 'sess-1.jsonl'),
    columns,
    tasks: [
      {
        id: 'agent-waiting',
        type: 'code-reviewer',
        status: 'running',
        description: 'Review the auth diff — com acentuação',
        startTime: (now - 190) * 1000,
        tokenCount: 45200,
        contextWindowSize: 200000,
        model: 'claude-haiku-4-5-20251001',
        effort: 'high',
      },
      {
        id: 'cold',
        type: 'general-purpose',
        status: 'running',
        description: 'Run the e2e suite',
        startTime: (now - 900) * 1000,
        tokenCount: 170000,
        contextWindowSize: 200000,
      },
      {
        id: 'agent-done',
        type: 'Explore',
        status: 'completed',
        description: 'Find callers',
        startTime: (now - 60) * 1000,
        tokenCount: 8000,
      },
      {
        id: 'agent-done-cold',
        type: 'Explore',
        status: 'completed',
        description: 'Old lookup',
        startTime: (now - 1200) * 1000,
        tokenCount: 9000,
      },
      {
        id: 'agent-new',
        name: 'fresh',
        status: 'running',
        description: 'Just started',
        startTime: (now - 2) * 1000,
        tokenCount: 0,
      },
    ],
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tokenline-subagents-'))
  now = Math.floor(Date.now() / 1000)
  const subagents = join(dir, 'proj', 'sess-1', 'subagents')
  mkdirSync(join(subagents, 'workflows', 'wf_1'), { recursive: true })
  // Last call still pending, followed by a half-written line (a live transcript).
  writeFileSync(
    join(subagents, 'agent-waiting.jsonl'),
    line({ type: 'user', message: { content: 'go' } }) +
      assistant(70, { write5m: 900, tool: 'Bash' }) +
      '{"type":"assist',
  )
  // Workflow-spawned agent, one level down, past the 5m TTL.
  writeFileSync(
    join(subagents, 'workflows', 'wf_1', 'agent-cold.jsonl'),
    assistant(400, { write5m: 10, tool: 'Read' }) + toolResult,
  )
  writeFileSync(join(subagents, 'agent-done.jsonl'), assistant(20))
  writeFileSync(
    join(subagents, 'agent-done-cold.jsonl'),
    assistant(900, { write5m: 5 }),
  )
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!hasJq)('tokenline.sh — subagent rows', () => {
  it('emits one row per task, keeping every task id', () => {
    const { status, rows } = render(payload(140))

    expect(status).toBe(0)
    expect(rows.map((r) => r.id)).toEqual([
      'agent-waiting',
      'cold',
      'agent-done',
      'agent-done-cold',
      'agent-new',
    ])
  })

  it("counts down each subagent's own cache and names the tool it waits on", () => {
    const { rows } = render(payload(140))
    const waiting = plain(rows[0].content)

    expect(waiting).toMatch(/^code-reviewer\s+●/)
    expect(waiting).toContain('ctx: 45.2k (22%)')
    expect(waiting).toMatch(/\[5m\] cache: 3:[45]\d HOT/)
    expect(waiting).toContain('waiting: Bash')
  })

  it('finds a workflow agent one level down and blinks COLD while it runs', () => {
    const { rows } = render(payload(140))

    expect(plain(rows[1].content)).toContain('[5m] cache: COLD')
    expect(rows[1].content).toContain(BLINK)
    expect(plain(rows[1].content)).toContain('last: Read')
  })

  it('never blinks for a finished subagent, hot or cold', () => {
    const { rows } = render(payload(140))

    expect(plain(rows[2].content)).toMatch(/cache: 4:\d\d HOT/)
    expect(plain(rows[3].content)).toContain('cache: cold')
    expect(rows[2].content).not.toContain(BLINK)
    expect(rows[3].content).not.toContain(BLINK)
  })

  it('shortens the model id and leaves model and effort blank when absent', () => {
    const { rows } = render(payload(160))
    const withModel = plain(rows[0].content)
    const without = plain(rows[4].content)

    expect(withModel).toMatch(/●\s+haiku 4\.5\s+high\s/)
    expect(without).not.toMatch(/haiku|high/)
    // Blank cells still hold their width, so the cache column stays aligned.
    expect(without.indexOf('cache:') + '[5m] '.length).toBe(
      withModel.indexOf('cache:'),
    )
  })

  it('keeps a subagent idling on its own background job marked as waiting', () => {
    const subagents = join(dir, 'proj', 'sess-1', 'subagents')
    const bgCall = line({
      type: 'assistant',
      timestamp: iso(40),
      message: {
        usage: { cache_creation: { ephemeral_5m_input_tokens: 50 } },
        content: [
          {
            type: 'tool_use',
            name: 'Bash',
            input: { command: 'make test', run_in_background: true },
          },
        ],
      },
    })
    // The call answers at once, the subagent says a line, then idles.
    writeFileSync(
      join(subagents, 'agent-new.jsonl'),
      bgCall + toolResult + assistant(35),
    )

    const idle = plain(render(payload(160)).rows[4].content)
    expect(idle).toContain('waiting: Bash (bg)')

    // Once the job's notification arrives, the wait is over.
    writeFileSync(
      join(subagents, 'agent-new.jsonl'),
      bgCall +
        toolResult +
        assistant(35) +
        line({ type: 'user', message: { content: 'background job finished' } }),
    )
    const woken = plain(render(payload(160)).rows[4].content)
    expect(woken).toContain('last: Bash')
  })

  it('shows a placeholder until a subagent has a transcript', () => {
    const { rows } = render(payload(140))
    const fresh = plain(rows[4].content)

    expect(fresh).toMatch(/^fresh\s+●/)
    expect(fresh).toContain('cache: --')
    expect(fresh).not.toContain('ctx:')
  })

  it.each([140, 100, 80, 60, 40])(
    'keeps every row within %i columns, cache countdown included',
    (columns) => {
      const { rows } = render(payload(columns))

      for (const r of rows) {
        expect(plain(r.content).length).toBeLessThanOrEqual(columns)
        expect(plain(r.content)).toContain('cache:')
      }
    },
  )

  it('lines the cache column up across rows', () => {
    const { rows } = render(payload(140))
    const at = rows.map((r) => plain(r.content).indexOf('cache:'))
    const bracketed = rows
      .map((r, i) => (plain(r.content).includes('[5m]') ? at[i] - 5 : at[i]))
      .filter((_, i) => i !== 4)

    expect(new Set(bracketed).size).toBe(1)
  })

  it('renders the main statusline when "tasks" is not an array', () => {
    const r = spawnSync('bash', [SCRIPT], {
      input: JSON.stringify({
        model: { display_name: 'Opus 5.5' },
        session_id: 'main',
        note: 'mentions "tasks"',
        tasks: 'not-an-array',
      }),
      encoding: 'utf8',
      env: { ...process.env, XDG_RUNTIME_DIR: dir },
    })

    expect(r.status).toBe(0)
    expect(plain(r.stdout).split('\n')[0]).toMatch(/^Opus 5\.5/)
  })

  it.each(['', 'garbage', '{"tasks":[]}', '{"tasks":[1,null,"x"]}'])(
    'exits 0 with no rows on %j',
    (input) => {
      const { status, rows } = render(input)

      expect(status).toBe(0)
      expect(rows).toEqual([])
    },
  )
})

// macOS ships BSD `date` and `stat`, which reject GNU's `-d` and `-c`. These
// shims behave like the BSD tools (answering through the real GNU ones), and
// sit first on PATH, so the script's BSD branches run on a Linux CI runner.
const realBin = (name: string): string =>
  spawnSync('bash', ['-c', `command -v ${name}`], {
    encoding: 'utf8',
  }).stdout.trim()
const hasGnuTools =
  spawnSync('date', ['-d', '@0']).status === 0 &&
  spawnSync('stat', ['-c', '%Y', '.']).status === 0

describe.skipIf(!hasJq || !hasGnuTools)(
  'tokenline.sh — subagent rows on BSD date/stat (macOS)',
  () => {
    let shimDir: string

    beforeEach(() => {
      shimDir = join(dir, 'bsd-bin')
      mkdirSync(shimDir)
      // BSD stat: no -c; -f takes %m (mtime) and %z (size).
      writeFileSync(
        join(shimDir, 'stat'),
        `#!/usr/bin/env bash
real='${realBin('stat')}'
[ "$1" = "-c" ] && { echo "stat: illegal option -- c" >&2; exit 1; }
if [ "$1" = "-f" ]; then
  m=$("$real" -c %Y "$3") || exit 1
  z=$("$real" -c %s "$3") || exit 1
  out="\${2//%m/$m}"; printf '%s\\n' "\${out//%z/$z}"; exit 0
fi
exec "$real" "$@"
`,
        { mode: 0o755 },
      )
      // BSD date: no -d; parses with -j -f <format> <string>.
      writeFileSync(
        join(shimDir, 'date'),
        `#!/usr/bin/env bash
real='${realBin('date')}'
[ "$1" = "-d" ] && exit 1
if [ "$1 $2 $3" = "-u -j -f" ]; then exec "$real" -u -d "$5" "$6"; fi
exec "$real" "$@"
`,
        { mode: 0o755 },
      )
    })

    const bsd = (): NodeJS.ProcessEnv => ({
      PATH: `${shimDir}:${process.env.PATH ?? ''}`,
    })

    it('reads the countdown from the transcript timestamp, not the file mtime', () => {
      const { status, rows } = render(payload(160), bsd())

      expect(status).toBe(0)
      // The transcript says 70s ago; an mtime fallback would read ~5:00.
      expect(plain(rows[0].content)).toMatch(/\[5m\] cache: 3:[45]\d HOT/)
      expect(plain(rows[1].content)).toContain('cache: COLD')
    })

    it('keeps the per-subagent scan cache working through stat -f', () => {
      render(payload(160), bsd())
      const again = render(payload(160), bsd())

      expect(plain(again.rows[0].content)).toContain('waiting: Bash')
      expect(plain(again.rows[0].content)).toMatch(/cache: 3:[45]\d HOT/)
    })
  },
)

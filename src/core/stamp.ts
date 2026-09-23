import type { Target } from '../shared/types'

// The installed copy of tokenline.sh carries two stamped lines: the version it
// was installed from and the command that updates it. The repo copy leaves
// them empty, which is what keeps the statusline's update check off there.
const VERSION_LINE = 'TOKENLINE_VERSION=""'
const UPDATE_CMD_LINE = 'TOKENLINE_UPDATE_CMD=""'

const SEMVER = /^\d+\.\d+\.\d+$/

// Exact command that updates the copy installed for this target. `update`
// finds the script through the target's settings.json, so --dir needs no flag.
// -y skips npx's install prompt, so it also runs as a `!` command in Claude Code.
export const updateCommand = (o: Target): string => {
  const base = 'npx -y @inbrace-tech/tokenline@latest update'
  if (o.targetCli === 'antigravity') return `${base} --antigravity`
  return o.global ? `${base} --global` : base
}

// Pure: returns the script with both placeholder lines filled in. Throws when a
// placeholder is missing or repeated, so a changed script can't ship unstamped.
export function stampScript(
  source: string,
  version: string,
  updateCmd: string,
): string {
  if (!SEMVER.test(version)) throw new Error(`Invalid version: ${version}`)
  if (updateCmd.includes("'")) {
    throw new Error('Update command must not contain a single quote')
  }
  const lines = source.split('\n')
  const fill = (placeholder: string, stamped: string): void => {
    const at = lines.flatMap((l, i) => (l === placeholder ? [i] : []))
    if (at.length !== 1) {
      throw new Error(
        `Expected exactly one "${placeholder}" line in tokenline.sh`,
      )
    }
    lines[at[0]] = stamped
  }
  fill(VERSION_LINE, `TOKENLINE_VERSION="${version}"`)
  fill(UPDATE_CMD_LINE, `TOKENLINE_UPDATE_CMD='${updateCmd}'`)
  return lines.join('\n')
}

// Script path from a statusLine command written by `init` (see
// statusLineCommand): `bash /path/tokenline.sh` or `bash "/path with space/tokenline.sh"`.
// Anything else (a variable, a wrapper, another script) returns null, so
// `update` never overwrites a file it didn't install.
export function scriptPathFromCommand(cmd: string | undefined): string | null {
  if (typeof cmd !== 'string') return null
  const m = /^bash (?:"([^"$`\\]+)"|([^\s"'$`\\]+))$/.exec(cmd)
  const path = m ? (m[1] ?? m[2]) : undefined
  return path !== undefined && path.endsWith('/tokenline.sh') ? path : null
}

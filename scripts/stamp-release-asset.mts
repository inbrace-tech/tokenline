// ==============================================================================
// Release asset stamp — entry point (I/O only)
//
//   node --experimental-strip-types scripts/stamp-release-asset.mts <out-file>
//
// Writes tokenline.sh to <out-file>, stamped with the version in package.json
// and CURL_UPDATE_CMD, then prints the version (the Release workflow uses it
// for the tag). The stamping rules — x.y.z only, no single quote, exactly one
// of each placeholder — live in src/core/stamp.ts and its spec, the same code
// the npm installer runs, so the two install paths can't drift apart.
// ==============================================================================

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { CURL_UPDATE_CMD, stampScript } from '../src/core/stamp.ts'

const out = process.argv[2]
if (out === undefined) {
  console.error('usage: stamp-release-asset.mts <out-file>')
  process.exit(1)
}

const root = join(import.meta.dirname, '..')
const { version } = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8'),
) as { version: string }
const source = readFileSync(join(root, 'tokenline.sh'), 'utf8')

writeFileSync(out, stampScript(source, version, CURL_UPDATE_CMD))
console.log(version)

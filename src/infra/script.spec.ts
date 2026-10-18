import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeExecutableAtomic } from './script'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tokenline-script-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

it('creates missing dirs and writes an executable file, leaving no temp file', () => {
  const path = join(dir, 'nested', 'tokenline.sh')
  writeExecutableAtomic(path, 'v1\n')

  expect(readFileSync(path, 'utf8')).toBe('v1\n')
  expect(statSync(path).mode & 0o777).toBe(0o755)
  expect(readdirSync(join(dir, 'nested'))).toEqual(['tokenline.sh'])
})

it('replaces an existing copy by rename, never in place', () => {
  const path = join(dir, 'tokenline.sh')
  writeFileSync(path, 'old\n')
  const before = statSync(path).ino

  writeExecutableAtomic(path, 'new\n')

  expect(readFileSync(path, 'utf8')).toBe('new\n')
  // A new inode proves the old file was swapped, not truncated and rewritten.
  expect(statSync(path).ino).not.toBe(before)
  expect(readdirSync(dir)).toEqual(['tokenline.sh'])
})

it("updates the real file behind a user's symlink and keeps the link", () => {
  const real = join(dir, 'dotfiles', 'tokenline.sh')
  writeExecutableAtomic(real, 'old\n')
  const link = join(dir, 'tokenline.sh')
  symlinkSync(real, link)

  writeExecutableAtomic(link, 'new\n')

  expect(lstatSync(link).isSymbolicLink()).toBe(true)
  expect(readFileSync(real, 'utf8')).toBe('new\n')
})

it('refuses to reuse a pre-existing temp path, and cleans up nothing it did not create', () => {
  const path = join(dir, 'tokenline.sh')
  writeFileSync(path, 'old\n')
  const tmp = join(dir, `.tokenline.sh.${process.pid}.tmp`)
  writeFileSync(tmp, 'planted\n')

  expect(() => writeExecutableAtomic(path, 'new\n')).toThrow(/EEXIST/)
  expect(readFileSync(path, 'utf8')).toBe('old\n')
  expect(readFileSync(tmp, 'utf8')).toBe('planted\n')
})

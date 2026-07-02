import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['cjs'],
  // Down-level syntax to the engines.node support floor (see package.json /
  // AGENTS.md). Keep this in lockstep with that floor.
  target: 'node18',
  clean: true,
  minify: true,
  outDir: 'dist',
})

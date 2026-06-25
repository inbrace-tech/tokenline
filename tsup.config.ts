import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['cjs'],
  target: 'node18',
  clean: true,
  minify: true,
  outDir: 'dist',
})

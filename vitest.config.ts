import { configDefaults, defineConfig } from 'vitest/config'

// Minimal vitest setup for the installer CLI (`src/`). tokenline is plain
// TypeScript bundled by tsup (no decorators), so vitest's default transformer
// is enough — no extra transform plugin needed.
//
// Kept intentionally small: this is the starting point others extend. The full
// settings.json patching contract is tracked in follow-up issues.
export default defineConfig({
  test: {
    // Specs use bare `it`/`expect` (no imports); `tsconfig.json` adds
    // "vitest/globals" so TypeScript resolves them.
    globals: true,
    // Co-locate specs next to the source they cover: src/**/*.spec.ts.
    include: ['src/**/*.spec.ts'],
    // Never collect specs from worktree copies under .claude/.
    exclude: [...configDefaults.exclude, '**/.claude/**'],
  },
})

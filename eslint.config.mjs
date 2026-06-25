// @ts-check
import eslint from '@eslint/js'
import { defineConfig } from 'eslint/config'
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended'
import simpleImportSort from 'eslint-plugin-simple-import-sort'
import globals from 'globals'
import tseslint from 'typescript-eslint'

// Minimal flat config: ESLint recommended + type-checked TS rules + Prettier +
// import sorting. Intentionally small (no project-specific rules) so it doubles
// as a starting-point example.
export default defineConfig(
  { ignores: ['dist', 'node_modules'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        // `defaultProject` gives `eslint.config.mjs` itself real Node types so
        // type-aware rules can check it (see tsconfig.eslint.json).
        projectService: {
          allowDefaultProject: ['eslint.config.mjs'],
          defaultProject: './tsconfig.eslint.json',
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'simple-import-sort': simpleImportSort,
    },
    rules: {
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
    },
  },
)

import { defineConfig } from 'vitest/config'

// Each package keeps its own config (environment, globals, includes and the
// dist entries its Node tests consume); the aggregate only names it.
function packageProject(dir: string, config = 'vite.config.ts') {
  return {
    extends: `./packages/${dir}/${config}`,
    root: `./packages/${dir}`,
    test: { name: dir },
  }
}

export default defineConfig({
  test: {
    projects: [
      './vitest.app.config.ts',
      './vitest.tooling.config.ts',
      packageProject('luma-color-runtime'),
      packageProject('luma-raw-runtime'),
      packageProject('luma-jpeg-runtime'),
      packageProject('render-engine'),
      packageProject('lmfg-cli'),
      packageProject('lmfg-mcp'),
      packageProject('luma-native-artifacts', 'vitest.config.mjs'),
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: [
        'src/**/*.{ts,tsx}',
        'packages/*/src/**/*.{ts,tsx}',
        'packages/*/worker/**/*.{ts,tsx}',
        'packages/luma-raw-runtime/benchmarks/**/*.ts',
        'packages/luma-raw-runtime/fixtures/scripts/**/*.mjs',
        'scripts/**/*.mjs',
      ],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/coverage/**',
        '**/.claude/**',
        '**/.worktrees/**',
        '**/*.d.ts',
        'src/test/**',
        'tests/browser/**',
        'src/generated-routes.ts',
        '**/*.test.{ts,tsx,js,jsx,mjs}',
        '**/*.spec.{ts,tsx,js,jsx,mjs}',
      ],
    },
  },
})

import { fileURLToPath } from 'node:url'

import { defineProject } from 'vitest/config'

// The repository tooling project: build, CI, deploy, native-runtime and
// quality scripts, the Vite plugins and the root Vite config test, in Node.
export default defineProject({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: {
      // The WebGPU harness validates the color runtime source, never a stale
      // package build, so its fixture test reads the same source.
      '@lumaforge/luma-color-runtime': fileURLToPath(
        new URL('./packages/luma-color-runtime/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    name: 'tooling',
    environment: 'node',
    include: [
      'scripts/**/*.{test,spec}.{ts,js,mjs}',
      'plugins/**/*.{test,spec}.{ts,js,mjs}',
      '*.{test,spec}.{ts,js,mjs}',
    ],
    // Replaces the default exclude, which skips `*.config.*` files and so
    // would hide `vite.config.test.ts`.
    exclude: ['**/node_modules/**', '**/dist/**'],
    globals: false,
  },
})

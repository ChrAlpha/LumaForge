import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: '@lumaforge/luma-native-artifacts',
    environment: 'node',
    globals: false,
    setupFiles: [],
    include: ['*.test.mjs'],
    exclude: ['**/node_modules/**', '**/.cache/**', '**/native/**'],
  },
})

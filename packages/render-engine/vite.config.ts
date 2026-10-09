import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root,
  build: {
    outDir: 'dist',
    emptyOutDir: !process.env.VITEST,
    lib: {
      entry: {
        index: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
        export: fileURLToPath(
          new URL('./src/export/index.ts', import.meta.url),
        ),
        geometry: fileURLToPath(
          new URL('./src/geometry/index.ts', import.meta.url),
        ),
        manifest: fileURLToPath(
          new URL('./src/manifest/index.ts', import.meta.url),
        ),
        policy: fileURLToPath(
          new URL('./src/policy/index.ts', import.meta.url),
        ),
        preview: fileURLToPath(
          new URL('./src/preview/index.ts', import.meta.url),
        ),
      },
      formats: ['es'],
    },
    rollupOptions: {
      // Keep Node built-ins and workspace runtime packages as runtime
      // imports so the bundle doesn't drag in a frozen copy of them.
      external: [/^node:/, /^@lumaforge\//],
      output: {
        chunkFileNames: '[name].js',
        entryFileNames: '[name].js',
      },
    },
    sourcemap: true,
    target: 'es2022',
  },
  test: {
    name: '@lumaforge/render-engine',
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
  },
})

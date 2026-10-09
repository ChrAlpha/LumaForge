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
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: [
        /^node:/,
        /^@lumaforge\//,
        /^@modelcontextprotocol\//,
        'sharp',
        'zod',
      ],
      output: {
        chunkFileNames: '[name].js',
        entryFileNames: '[name].js',
      },
    },
    sourcemap: true,
    target: 'es2022',
  },
  test: {
    name: '@lumaforge/lmfg-mcp',
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
  },
})

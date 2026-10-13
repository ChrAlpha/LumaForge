import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))

function cleanDistExceptNative() {
  const distDir = join(root, 'dist')

  try {
    for (const entry of readdirSync(distDir)) {
      if (entry === 'native') continue

      rmSync(join(distDir, entry), { force: true, recursive: true })
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
}

export default defineConfig({
  root,
  base: './',
  plugins: [
    {
      name: 'luma-jpeg-preserve-native-assets',
      // Build only: the test server must never clear dist, since the native
      // smoke tests load the native assets in `dist/native`.
      apply: 'build',
      buildStart() {
        cleanDistExceptNative()
      },
    },
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: {
        index: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
        node: fileURLToPath(new URL('./src/runtime-node.ts', import.meta.url)),
      },
      formats: ['es'],
    },
    rollupOptions: {
      // Keep Node built-ins and the workspace artifact loader as external
      // imports so the Node entry bundle resolves them at runtime instead
      // of getting Vite's browser-environment stub.
      external: [/^node:/, '@lumaforge/luma-native-artifacts/load-for-node'],
      output: {
        chunkFileNames: '[name].js',
        entryFileNames: '[name].js',
      },
    },
    sourcemap: true,
    target: 'es2022',
  },
  worker: {
    format: 'es',
  },
  test: {
    name: '@lumaforge/luma-jpeg-runtime',
    environment: 'node',
    globals: true,
  },
})

import process from 'node:process'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

import { resolveRenderEnvironments } from './scripts/build/runtime-environment.mjs'

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  define: {
    APP_NAME: JSON.stringify('LumaForge'),
    APP_SITE_URL: JSON.stringify('https://luma.ichr.me'),
    APP_DEPLOY_ENV: JSON.stringify('production'),
    APP_RENDER_ENVIRONMENTS: JSON.stringify(
      resolveRenderEnvironments({ rootDir: process.cwd() }),
    ),
  },
  plugins: [react()],
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('./src', import.meta.url)),
      '@pkg': fileURLToPath(new URL('./package.json', import.meta.url)),
      '@lumaforge/luma-color-runtime/glsl': fileURLToPath(
        new URL('./packages/luma-color-runtime/src/glsl.ts', import.meta.url),
      ),
      '@lumaforge/luma-color-runtime/testing': fileURLToPath(
        new URL(
          './packages/luma-color-runtime/src/testing.ts',
          import.meta.url,
        ),
      ),
      '@lumaforge/luma-color-runtime': fileURLToPath(
        new URL('./packages/luma-color-runtime/src/index.ts', import.meta.url),
      ),
      '@lumaforge/luma-raw-runtime/node': fileURLToPath(
        new URL(
          './packages/luma-raw-runtime/src/runtime-node.ts',
          import.meta.url,
        ),
      ),
      '@lumaforge/luma-jpeg-runtime/node': fileURLToPath(
        new URL(
          './packages/luma-jpeg-runtime/src/runtime-node.ts',
          import.meta.url,
        ),
      ),
      '@lumaforge/luma-raw-runtime': fileURLToPath(
        new URL('./packages/luma-raw-runtime/src/index.ts', import.meta.url),
      ),
      '@lumaforge/luma-jpeg-runtime': fileURLToPath(
        new URL('./packages/luma-jpeg-runtime/src/index.ts', import.meta.url),
      ),
      '@lumaforge/render-engine/export': fileURLToPath(
        new URL(
          './packages/render-engine/src/export/index.ts',
          import.meta.url,
        ),
      ),
      '@lumaforge/render-engine/manifest': fileURLToPath(
        new URL(
          './packages/render-engine/src/manifest/index.ts',
          import.meta.url,
        ),
      ),
      '@lumaforge/render-engine/policy': fileURLToPath(
        new URL(
          './packages/render-engine/src/policy/index.ts',
          import.meta.url,
        ),
      ),
      '@lumaforge/render-engine/preview': fileURLToPath(
        new URL(
          './packages/render-engine/src/preview/index.ts',
          import.meta.url,
        ),
      ),
      '@lumaforge/render-engine': fileURLToPath(
        new URL('./packages/render-engine/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'jsdom',
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.claude/**',
      '**/.worktrees/**',
      'tests/browser/**',
    ],
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: true,
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

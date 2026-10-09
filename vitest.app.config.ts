import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { defineProject } from 'vitest/config'

import { resolveRenderEnvironments } from './scripts/build/runtime-environment.mjs'

// The app test project: `src` tests in jsdom, with the app's source aliases,
// build-time defines and DOM setup. Packages and repository tooling run in
// their own projects and never see these.
export default defineProject({
  root: fileURLToPath(new URL('.', import.meta.url)),
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
  resolve: {
    alias: {
      '@lumaforge/luma-color-runtime/wgsl': fileURLToPath(
        new URL('./packages/luma-color-runtime/src/wgsl.ts', import.meta.url),
      ),
      '~': fileURLToPath(new URL('./src', import.meta.url)),
      '@pkg': fileURLToPath(new URL('./package.json', import.meta.url)),
      '@lumaforge/luma-color-runtime/testing': fileURLToPath(
        new URL(
          './packages/luma-color-runtime/src/testing.ts',
          import.meta.url,
        ),
      ),
      '@lumaforge/luma-color-runtime': fileURLToPath(
        new URL('./packages/luma-color-runtime/src/index.ts', import.meta.url),
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
      '@lumaforge/render-engine/geometry': fileURLToPath(
        new URL(
          './packages/render-engine/src/geometry/index.ts',
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
    name: 'app',
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{ts,tsx,js,jsx,mjs}'],
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: true,
  },
})

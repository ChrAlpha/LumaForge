import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { defineProject } from 'vitest/config'

import { resolveRenderEnvironments } from './scripts/build/runtime-environment.mjs'
import { resolveAppAliases } from './scripts/quality/app-aliases.mjs'

const ROOT = fileURLToPath(new URL('.', import.meta.url))

// The app test project: `src` tests in jsdom, with the app's source aliases,
// build-time defines and DOM setup. Packages and repository tooling run in
// their own projects and never see these.
export default defineProject({
  root: ROOT,
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
    alias: resolveAppAliases(ROOT),
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

import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { routeBuilderPlugin } from 'vite-plugin-route-builder'
import type { Plugin } from 'vitest/config'
import { defineProject } from 'vitest/config'

import { resolveRenderEnvironments } from './scripts/build/runtime-environment.mjs'
import { resolveAppAliases } from './scripts/quality/app-aliases.mjs'

const ROOT = fileURLToPath(new URL('.', import.meta.url))

// The app test project: `src` tests in jsdom, with the app's source aliases,
// build-time defines and DOM setup. Packages and repository tooling run in
// their own projects and never see these.
export default defineProject({
  root: ROOT,
  // Route tests import the gitignored route table, so the project writes it
  // the same way the app's dev server does instead of relying on a copy left
  // by an earlier build. The plugin is typed against the app's Vite while
  // Vitest bundles its own, so the plugin is passed as Vitest's type.
  plugins: [
    routeBuilderPlugin({
      pagePattern: `${ROOT}src/pages/**/*.tsx`,
      outputPath: `${ROOT}src/generated-routes.ts`,
      enableInDev: true,
    }) as unknown as Plugin,
  ],
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

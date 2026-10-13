import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Alias, AliasOptions } from 'vite'
import { createServer, loadConfigFromFile } from 'vite'
import { describe, expect, it } from 'vitest'

import {
  deferRawRouteAppModule,
  deferRawRouteStylesheets,
  injectRawRouteResourceHints,
  resolveRawRouteHtmlOutputPaths,
  selectRawRouteAssets,
} from './scripts/build/raw-route-html'
import {
  APP_ALIASES,
  resolveAppAliases,
} from './scripts/quality/app-aliases.mjs'

async function resolveViteConfig() {
  const result = await loadConfigFromFile(
    {
      command: 'serve',
      mode: 'development',
    },
    'vite.config.ts',
  )
  if (!result) throw new Error('vite.config.ts did not load a config')

  return result.config
}

const ROOT = fileURLToPath(new URL('./', import.meta.url))

async function loadAliases(configFile: string) {
  const result = await loadConfigFromFile(
    { command: 'serve', mode: 'test' },
    configFile,
  )
  return result?.config.resolve?.alias
}

/** Resolves specifiers from an app module through Vite's alias handling. */
async function resolveFromApp(alias: AliasOptions, specifiers: string[]) {
  const server = await createServer({
    configFile: false,
    envFile: false,
    root: ROOT,
    logLevel: 'silent',
    resolve: { alias },
    server: { middlewareMode: true, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  try {
    const importer = resolve(ROOT, 'src/main.tsx')
    const resolved: Record<string, string | null> = {}
    for (const specifier of specifiers) {
      resolved[specifier] =
        (await server.pluginContainer.resolveId(specifier, importer))?.id ??
        null
    }
    return resolved
  } finally {
    await server.close()
  }
}

describe('app aliases', () => {
  it('builds the app through the shared alias list alone', async () => {
    const config = await resolveViteConfig()

    expect(config.resolve?.alias).toEqual(resolveAppAliases(ROOT))
    expect(config.resolve?.tsconfigPaths).toBeFalsy()
  })

  it('tests the app through the same alias list', async () => {
    expect(await loadAliases('vitest.app.config.ts')).toEqual(
      resolveAppAliases(ROOT),
    )
  })

  it('resolves ~/, @pkg and every package entry to source', async () => {
    const alias = (await loadAliases('vite.config.ts')) as Alias[]
    const resolved = await resolveFromApp(alias, [
      '~/lib/seo',
      ...APP_ALIASES.slice(1).map((entry) => entry.find),
    ])

    expect(resolved).toEqual({
      '~/lib/seo': resolve(ROOT, 'src/lib/seo.ts'),
      ...Object.fromEntries(
        APP_ALIASES.slice(1).map((entry) => [
          entry.find,
          resolve(ROOT, entry.path),
        ]),
      ),
    })
  })

  it('refuses a package subpath the app has no alias for', async () => {
    const alias = (await loadAliases('vite.config.ts')) as Alias[]
    const resolved = await resolveFromApp(alias, [
      '@lumaforge/render-engine/missing',
      '@lumaforge/luma-raw-runtime/node',
    ])

    // The package root alias captures them and appends the subpath to its
    // source entry file, so they never reach a dist build: loading fails.
    expect(resolved).toEqual({
      '@lumaforge/render-engine/missing': resolve(
        ROOT,
        'packages/render-engine/src/index.ts/missing',
      ),
      '@lumaforge/luma-raw-runtime/node': resolve(
        ROOT,
        'packages/luma-raw-runtime/src/index.ts/node',
      ),
    })
    for (const id of Object.values(resolved)) {
      expect(existsSync(id!)).toBe(false)
    }
  })
})

describe('vite config', () => {
  it('ignores repo-local agent worktrees in the dev watcher', async () => {
    const config = await resolveViteConfig()

    expect(config.server?.watch?.ignored).toEqual(
      expect.arrayContaining(['**/.worktrees/**', '**/.claude/worktrees/**']),
    )
  })

  it('selects only raw route assets for first-screen resource hints', () => {
    expect(
      selectRawRouteAssets([
        'assets/index-abc.js',
        'assets/index-abc.css',
        'assets/raw-def.js',
        'assets/raw-ghi.css',
        'assets/framer-lazy-feature.js',
      ]),
    ).toEqual({
      scripts: ['/assets/raw-def.js'],
      styles: ['/assets/raw-ghi.css'],
    })
  })

  it('injects raw route resource hints before the app module script', () => {
    const html = [
      '<head>',
      '  <script type="module" crossorigin src="/assets/index-abc.js"></script>',
      '  <link rel="stylesheet" crossorigin href="/assets/index-abc.css">',
      '</head>',
    ].join('\n')

    const result = injectRawRouteResourceHints(html, {
      scripts: ['/assets/raw-def.js'],
      styles: ['/assets/raw-ghi.css'],
    })

    expect(result).toContain(
      '<link rel="modulepreload" crossorigin href="/assets/raw-def.js">',
    )
    expect(result).toContain(
      '<link rel="stylesheet" crossorigin href="/assets/raw-ghi.css">',
    )
    expect(result.indexOf('/assets/raw-def.js')).toBeLessThan(
      result.indexOf('/assets/index-abc.js'),
    )
  })

  it('targets both exact and directory raw route HTML outputs', () => {
    expect(resolveRawRouteHtmlOutputPaths('/dist')).toEqual([
      '/dist/raw.html',
      '/dist/raw/index.html',
    ])
  })

  it('defers raw route stylesheets so the inline boot shell can paint first', () => {
    const result = deferRawRouteStylesheets(
      [
        '<head>',
        '  <link rel="stylesheet" crossorigin href="/assets/index-abc.css">',
        '  <link rel="stylesheet" crossorigin href="/assets/raw-def.css">',
        '</head>',
      ].join('\n'),
    )
    const resultWithoutNoscript = result.replace(
      /<noscript>[\s\S]*?<\/noscript>/g,
      '',
    )

    expect(resultWithoutNoscript).not.toContain(
      '<link rel="stylesheet" crossorigin href="/assets/index-abc.css">',
    )
    expect(resultWithoutNoscript).not.toContain('rel="preload" as="style"')
    expect(result).toContain('<script data-lf-raw-css-loader>')
    expect(result.indexOf('data-lf-raw-post-paint-loader')).toBeLessThan(
      result.indexOf('data-lf-raw-css-loader'),
    )
    expect(result).toContain(
      'const rawCssHrefs = ["/assets/index-abc.css","/assets/raw-def.css"];',
    )
    expect(result).toContain('window.__lfRawAfterFirstPaint(loadRawCss);')
    expect(result).toContain('PerformanceObserver')
    expect(result).toContain('first-contentful-paint')
    expect(result).toContain(
      '<noscript><link rel="stylesheet" crossorigin href="/assets/raw-def.css"></noscript>',
    )
  })

  it('defers the raw route app module while preserving modulepreload', () => {
    const result = deferRawRouteAppModule(
      [
        '<head>',
        '  <script type="module" crossorigin src="/assets/index-abc.js"></script>',
        '</head>',
      ].join('\n'),
    )

    expect(result).not.toContain(
      '<script type="module" crossorigin src="/assets/index-abc.js"></script>',
    )
    expect(result).toContain(
      '<link rel="modulepreload" crossorigin href="/assets/index-abc.js">',
    )
    expect(result).toContain('<script data-lf-raw-app-loader>')
    expect(result.indexOf('data-lf-raw-post-paint-loader')).toBeLessThan(
      result.indexOf('data-lf-raw-app-loader'),
    )
    expect(result).toContain('const rawAppModuleSrc = "/assets/index-abc.js";')
    expect(result).toContain(
      'window.__lfRawAfterFirstPaint(() => import(rawAppModuleSrc));',
    )
    expect(result).toContain('PerformanceObserver')
    expect(result).toContain('first-contentful-paint')
  })

  it('keeps the post-paint gate before every deferred raw loader in build order', () => {
    const result = deferRawRouteAppModule(
      deferRawRouteStylesheets(
        [
          '<head>',
          '  <script type="module" crossorigin src="/assets/index-abc.js"></script>',
          '  <link rel="modulepreload" crossorigin href="/assets/raw-def.js">',
          '  <link rel="stylesheet" crossorigin href="/assets/raw-def.css">',
          '  <link rel="stylesheet" crossorigin href="/assets/index-abc.css">',
          '</head>',
        ].join('\n'),
      ),
    )

    expect(result.indexOf('data-lf-raw-post-paint-loader')).toBeLessThan(
      result.indexOf('data-lf-raw-css-loader'),
    )
    expect(result.indexOf('data-lf-raw-post-paint-loader')).toBeLessThan(
      result.indexOf('data-lf-raw-app-loader'),
    )
    expect(result.match(/data-lf-raw-post-paint-loader/g) ?? []).toHaveLength(1)
  })
})

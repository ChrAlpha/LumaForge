import { describe, expect, it } from 'vitest'

import {
  deferRawRouteAppModule,
  deferRawRouteStylesheets,
  injectRawRouteResourceHints,
  resolveRawRouteHtmlOutputPaths,
  selectRawRouteAssets,
} from './scripts/build/raw-route-html'

describe('vite config', () => {
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

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import reactRefresh from '@vitejs/plugin-react'
import { codeInspectorPlugin } from 'code-inspector-plugin'
import { visualizer } from 'rollup-plugin-visualizer'
import type { Plugin } from 'vite'
import { defineConfig } from 'vite'
import { checker } from 'vite-plugin-checker'
import { routeBuilderPlugin } from 'vite-plugin-route-builder'

import PKG from './package.json'
import { toDataUrl } from './scripts/build/image-data-url'
import {
  deferRawRouteAppModule,
  deferRawRouteStylesheets,
  injectRawRouteResourceHints,
  resolveRawRouteHtmlOutputPaths,
  selectRawRouteAssets,
} from './scripts/build/raw-route-html'
import { resolveRenderEnvironments } from './scripts/build/runtime-environment.mjs'
import {
  assertNativeRuntimeAssets,
  copyNativeRuntimeAssets,
  resolveNativeRuntimeAssets,
} from './scripts/native-runtime/assets.mjs'
import {
  createRobotsTxt,
  createSitemapXml,
  DEFAULT_DEPLOY_ENV,
  DEFAULT_SITE_URL,
  HOME_ROUTE_SEO,
  normalizeSiteUrl,
  RAW_ROUTE_SEO,
  replaceSeoBlock,
  resolveDeployEnvironment,
} from './src/lib/seo'
import { renderLumaForgeOgImage } from './src/pages/(main)/og-image'

const ROOT = fileURLToPath(new URL('./', import.meta.url))
const LUMA_COLOR_RUNTIME_GLSL_SOURCE = resolve(
  ROOT,
  './packages/luma-color-runtime/src/glsl.ts',
)
const LUMA_COLOR_RUNTIME_TESTING_SOURCE = resolve(
  ROOT,
  './packages/luma-color-runtime/src/testing.ts',
)
const LUMA_COLOR_RUNTIME_SOURCE = resolve(
  ROOT,
  './packages/luma-color-runtime/src/index.ts',
)
const LUMA_RAW_RUNTIME_SOURCE = resolve(
  ROOT,
  './packages/luma-raw-runtime/src/index.ts',
)
const LUMA_JPEG_RUNTIME_SOURCE = resolve(
  ROOT,
  './packages/luma-jpeg-runtime/src/index.ts',
)
const RENDER_ENGINE_SOURCE = resolve(
  ROOT,
  './packages/render-engine/src/index.ts',
)
const RENDER_ENGINE_EXPORT_SOURCE = resolve(
  ROOT,
  './packages/render-engine/src/export/index.ts',
)
const RENDER_ENGINE_MANIFEST_SOURCE = resolve(
  ROOT,
  './packages/render-engine/src/manifest/index.ts',
)
const RENDER_ENGINE_POLICY_SOURCE = resolve(
  ROOT,
  './packages/render-engine/src/policy/index.ts',
)
const RENDER_ENGINE_PREVIEW_SOURCE = resolve(
  ROOT,
  './packages/render-engine/src/preview/index.ts',
)
const LUMAFORGE_OG_IMAGE_OUTPUT = 'og-image.png'
const LUMAFORGE_OG_IMAGE_FONT_SOURCE = resolve(
  ROOT,
  './src/assets/fonts/GeistVF.woff2',
)
const LUMAFORGE_OG_IMAGE_HERO_SOURCE = resolve(
  ROOT,
  './public/landing-raw-finish.webp',
)
const LUMAFORGE_OG_IMAGE_LOGO_SOURCE = resolve(ROOT, './public/favicon.png')
const CROSS_ORIGIN_ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

function selectManualChunk(moduleId: string) {
  const id = moduleId.replaceAll('\\', '/')

  if (!id.includes('/node_modules/')) return undefined
  if (id.includes('/react-router/')) return 'vendor-router'
  if (id.includes('/i18next/') || id.includes('/react-i18next/')) {
    return 'vendor-i18n'
  }
  if (id.includes('/@radix-ui/') || id.includes('/radix-ui/')) {
    return 'vendor-radix'
  }
  if (
    id.includes('/motion/') ||
    id.includes('/motion-dom/') ||
    id.includes('/motion-utils/') ||
    id.includes('/framer-motion/')
  ) {
    return 'vendor-motion'
  }
  if (id.includes('/lucide-react/')) return 'vendor-icons'
  if (id.includes('/jotai/') || id.includes('/@tanstack/')) {
    return 'vendor-state'
  }
  if (id.includes('/react') || id.includes('/scheduler/')) {
    return 'vendor-react'
  }

  return 'vendor-misc'
}

function resolveSeoRuntimeOptions(env = process.env) {
  return {
    siteUrl: normalizeSiteUrl(
      env.VITE_SITE_URL?.trim() || env.SITE_URL?.trim() || DEFAULT_SITE_URL,
    ),
    deployEnv: resolveDeployEnvironment(
      env.DEPLOY_ENV?.trim() || DEFAULT_DEPLOY_ENV,
    ),
  }
}

function nativeRuntimeAssetsPlugin(env: NodeJS.ProcessEnv): Plugin {
  function resolveAssetSets() {
    return resolveNativeRuntimeAssets({ rootDir: ROOT, env })
  }

  return {
    name: 'lumaforge-native-runtime-assets',
    configResolved() {
      assertNativeRuntimeAssets(resolveAssetSets())
    },
    writeBundle(options) {
      const outputDir = options.dir
        ? resolve(ROOT, options.dir)
        : resolve(ROOT, 'dist')
      copyNativeRuntimeAssets(resolveAssetSets(), outputDir)
    },
  }
}

function staticSeoArtifactsPlugin(): Plugin {
  return {
    name: 'lumaforge-static-seo-artifacts',
    async writeBundle(options) {
      const outputDir = options.dir
        ? resolve(ROOT, options.dir)
        : resolve(ROOT, 'dist')
      const indexHtmlPath = resolve(outputDir, 'index.html')
      const sourceHtml = readFileSync(indexHtmlPath, 'utf8')
      const seoOptions = resolveSeoRuntimeOptions()
      const ogImage = await renderLumaForgeOgImage({
        fontData: readFileSync(LUMAFORGE_OG_IMAGE_FONT_SOURCE),
        heroImageSrc: toDataUrl(
          'image/webp',
          readFileSync(LUMAFORGE_OG_IMAGE_HERO_SOURCE),
        ),
        logoSrc: toDataUrl(
          'image/png',
          readFileSync(LUMAFORGE_OG_IMAGE_LOGO_SOURCE),
        ),
      })

      writeFileSync(
        indexHtmlPath,
        replaceSeoBlock(sourceHtml, HOME_ROUTE_SEO, seoOptions),
      )

      const rawRouteDir = resolve(outputDir, 'raw')
      mkdirSync(rawRouteDir, { recursive: true })
      const assetFiles = readdirSync(resolve(outputDir, 'assets'), {
        withFileTypes: true,
      })
        .filter((entry) => entry.isFile())
        .map((entry) => `assets/${entry.name}`)
      const rawRouteHtml = injectRawRouteResourceHints(
        replaceSeoBlock(sourceHtml, RAW_ROUTE_SEO, seoOptions),
        selectRawRouteAssets(assetFiles),
      )
      const rawRouteOutputHtml = deferRawRouteAppModule(
        deferRawRouteStylesheets(rawRouteHtml),
      )
      for (const rawRouteHtmlPath of resolveRawRouteHtmlOutputPaths(
        outputDir,
      )) {
        writeFileSync(rawRouteHtmlPath, rawRouteOutputHtml)
      }

      writeFileSync(
        resolve(outputDir, 'robots.txt'),
        createRobotsTxt(seoOptions),
      )
      writeFileSync(
        resolve(outputDir, 'sitemap.xml'),
        createSitemapXml([HOME_ROUTE_SEO, RAW_ROUTE_SEO], seoOptions),
      )
      writeFileSync(resolve(outputDir, LUMAFORGE_OG_IMAGE_OUTPUT), ogImage)
    },
  }
}

const ANALYZE = process.env.ANALYZE === 'true'

export default defineConfig(({ command }) => {
  const seoOptions = resolveSeoRuntimeOptions()
  const nativeRuntimeEnv = { ...process.env }
  if (!nativeRuntimeEnv.LUMAFORGE_NATIVE_RUNTIME_MODE && command === 'serve') {
    nativeRuntimeEnv.LUMAFORGE_NATIVE_RUNTIME_MODE = 'source'
  }

  return {
    server: {
      headers: CROSS_ORIGIN_ISOLATION_HEADERS,
      watch: {
        ignored: ['**/.worktrees/**', '**/.claude/worktrees/**'],
      },
    },
    preview: {
      headers: CROSS_ORIGIN_ISOLATION_HEADERS,
    },
    plugins: [
      ...(ANALYZE
        ? [
            visualizer({
              filename: 'dist/stats.html',
              open: true,
              gzipSize: true,
            }),
          ]
        : []),
      nativeRuntimeAssetsPlugin(nativeRuntimeEnv),
      staticSeoArtifactsPlugin(),
      codeInspectorPlugin({
        bundler: 'vite',
        hotKeys: ['altKey'],
      }),
      reactRefresh(),
      checker({
        typescript: true,
        enableBuild: true,
      }),

      tailwindcss(),
      routeBuilderPlugin({
        pagePattern: `${resolve(ROOT, './src/pages')}/**/*.tsx`,
        outputPath: `${resolve(ROOT, './src/generated-routes.ts')}`,
        enableInDev: true,
      }),
    ],
    build: {
      chunkSizeWarningLimit: 650,
      rolldownOptions: {
        output: {
          manualChunks: selectManualChunk,
        },
        checks: {
          pluginTimings: false,
        },
      },
    },
    resolve: {
      alias: {
        '@lumaforge/luma-color-runtime/glsl': LUMA_COLOR_RUNTIME_GLSL_SOURCE,
        '@lumaforge/luma-color-runtime/testing':
          LUMA_COLOR_RUNTIME_TESTING_SOURCE,
        '@lumaforge/luma-color-runtime': LUMA_COLOR_RUNTIME_SOURCE,
        '@lumaforge/luma-raw-runtime': LUMA_RAW_RUNTIME_SOURCE,
        '@lumaforge/luma-jpeg-runtime': LUMA_JPEG_RUNTIME_SOURCE,
        '@lumaforge/render-engine/export': RENDER_ENGINE_EXPORT_SOURCE,
        '@lumaforge/render-engine/manifest': RENDER_ENGINE_MANIFEST_SOURCE,
        '@lumaforge/render-engine/policy': RENDER_ENGINE_POLICY_SOURCE,
        '@lumaforge/render-engine/preview': RENDER_ENGINE_PREVIEW_SOURCE,
        '@lumaforge/render-engine': RENDER_ENGINE_SOURCE,
      },
      tsconfigPaths: true,
    },
    define: {
      APP_DEV_CWD: JSON.stringify(process.cwd()),
      APP_NAME: JSON.stringify(
        PKG.name === 'lumaforge' ? 'LumaForge' : PKG.name,
      ),
      APP_SITE_URL: JSON.stringify(seoOptions.siteUrl),
      APP_DEPLOY_ENV: JSON.stringify(seoOptions.deployEnv),
      APP_RENDER_ENVIRONMENTS: JSON.stringify(
        resolveRenderEnvironments({ rootDir: process.cwd() }),
      ),
    },
  }
})

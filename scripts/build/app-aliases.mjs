import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The app's source aliases, in match order. Vite, the app test project, and
 * the import-boundary lint rule resolve imports through this one list, and
 * `tsconfig.json` `paths` names the same targets. A string alias also
 * matches every `find/...` specifier, so a package subpath has to precede
 * its package root.
 */
export const APP_ALIASES = Object.freeze([
  { find: '~', path: 'src' },
  { find: '@pkg', path: 'package.json' },
  {
    find: '@lumaforge/luma-color-runtime/wgsl',
    path: 'packages/luma-color-runtime/src/wgsl.ts',
  },
  {
    find: '@lumaforge/luma-color-runtime',
    path: 'packages/luma-color-runtime/src/index.ts',
  },
  {
    find: '@lumaforge/luma-raw-runtime',
    path: 'packages/luma-raw-runtime/src/index.ts',
  },
  {
    find: '@lumaforge/luma-jpeg-runtime',
    path: 'packages/luma-jpeg-runtime/src/index.ts',
  },
  {
    find: '@lumaforge/render-engine/export',
    path: 'packages/render-engine/src/export/index.ts',
  },
  {
    find: '@lumaforge/render-engine/geometry',
    path: 'packages/render-engine/src/geometry/index.ts',
  },
  {
    find: '@lumaforge/render-engine/manifest',
    path: 'packages/render-engine/src/manifest/index.ts',
  },
  {
    find: '@lumaforge/render-engine/policy',
    path: 'packages/render-engine/src/policy/index.ts',
  },
  {
    find: '@lumaforge/render-engine/preview',
    path: 'packages/render-engine/src/preview/index.ts',
  },
  {
    find: '@lumaforge/render-engine',
    path: 'packages/render-engine/src/index.ts',
  },
])

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** The aliases with absolute replacements, for Vite's `resolve.alias`. */
export function resolveAppAliases(rootDir = ROOT) {
  return APP_ALIASES.map(({ find, path }) => ({
    find,
    replacement: resolve(rootDir, path),
  }))
}

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import madge from 'madge'

/**
 * Fails on any import cycle in the app and package sources, and on any import
 * madge cannot resolve, so an unresolved edge never hides a cycle. Workspace
 * packages resolve to their sources through the root tsconfig paths, plus the
 * Node-only entries the browser app never imports. The route table is
 * generated and gitignored, so it is left out whether or not it exists.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

const SOURCE_DIRS = [
  'src',
  'packages/lmfg-cli/src',
  'packages/lmfg-mcp/src',
  'packages/luma-color-runtime/src',
  'packages/luma-jpeg-runtime/src',
  'packages/luma-jpeg-runtime/worker',
  'packages/luma-raw-runtime/src',
  'packages/luma-raw-runtime/worker',
  'packages/render-engine/src',
]

const GENERATED = new Set(['./generated-routes'])

const NODE_ENTRY_PATHS = {
  '@lumaforge/lmfg-cli': ['./packages/lmfg-cli/src/index.ts'],
  '@lumaforge/luma-jpeg-runtime/node': [
    './packages/luma-jpeg-runtime/src/runtime-node.ts',
  ],
  '@lumaforge/luma-native-artifacts/load-for-node': [
    './packages/luma-native-artifacts/load-for-node.mjs',
  ],
  '@lumaforge/luma-raw-runtime/node': [
    './packages/luma-raw-runtime/src/runtime-node.ts',
  ],
}

/**
 * @param {{ root?: string, dirs?: string[] }} [options]
 * @returns {Promise<{ modules: number, cycles: string[][], skipped: string[] }>}
 */
export async function findCycles({ root = ROOT, dirs = SOURCE_DIRS } = {}) {
  const { compilerOptions } = JSON.parse(
    readFileSync(join(root, 'tsconfig.json'), 'utf8'),
  )
  const result = await madge(
    dirs.map((dir) => join(root, dir)),
    {
      baseDir: root,
      fileExtensions: ['ts', 'tsx', 'mjs', 'js'],
      excludeRegExp: [/\.d\.[cm]?ts$/, /^src\/generated-routes\.ts$/],
      tsConfig: {
        compilerOptions: {
          ...compilerOptions,
          allowJs: true,
          baseUrl: root,
          paths: { ...compilerOptions.paths, ...NODE_ENTRY_PATHS },
        },
      },
      dependencyFilter: (dependency) => !dependency.endsWith('.css'),
    },
  )
  return {
    modules: Object.keys(result.obj()).length,
    cycles: result.circular(),
    skipped: result.warnings().skipped.filter((path) => !GENERATED.has(path)),
  }
}

if (import.meta.main) {
  const { modules, cycles, skipped } = await findCycles()
  console.log(`madge: ${modules} modules, ${cycles.length} cycles`)
  for (const cycle of cycles) console.error(`cycle: ${cycle.join(' > ')}`)
  for (const specifier of skipped) console.error(`unresolved: ${specifier}`)
  if (modules === 0) console.error('madge read no modules')
  if (cycles.length > 0 || skipped.length > 0 || modules === 0) {
    process.exitCode = 1
  }
}

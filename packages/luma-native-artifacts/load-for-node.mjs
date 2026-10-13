import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const VALID_KINDS = new Set(['raw', 'jpeg'])
const VALID_RAW_PROFILES = new Set(['desktop', 'low-memory'])

function isPlainObject(value) {
  return typeof value === 'object' && value !== null
}

function resolveArtifactPaths(kind, memoryProfile) {
  if (kind === 'jpeg') {
    return {
      gluePath: 'luma_jpeg.js',
      wasmPath: 'luma_jpeg.wasm',
    }
  }
  return {
    gluePath: `${memoryProfile}/luma_raw.js`,
    wasmPath: `${memoryProfile}/luma_raw.wasm`,
  }
}

// Held in a variable: bundlers rewrite `new URL(<literal>, import.meta.url)`
// into an asset URL, which node:fs cannot read.
const PACKAGED_NATIVE_DIR = './native/'

// Returns the directory as an href string: URL objects from another realm
// (a test DOM's URL, for one) are not accepted by node:fs.
function resolveNativeDirHref(nativeDir) {
  if (nativeDir === undefined) {
    return new URL(PACKAGED_NATIVE_DIR, import.meta.url).href
  }
  const href =
    nativeDir instanceof URL
      ? nativeDir.href
      : typeof nativeDir === 'string' && nativeDir.length > 0
        ? pathToFileURL(nativeDir).href
        : null
  if (href === null) {
    throw new TypeError(
      'loadNativeModuleForNode: nativeDir must be a non-empty path or a URL',
    )
  }
  return href.endsWith('/') ? href : `${href}/`
}

/**
 * Load a LumaForge native module (RAW or JPEG) in Node.js.
 *
 * The Emscripten glue ships with a Node `ENVIRONMENT_IS_NODE` flag but the
 * Node I/O branch is empty (no fs imports, no `readAsync`). This loader
 * sidesteps the gap by reading the `.wasm` bytes with `fs.readFile` and
 * passing them as `Module.wasmBinary`, which short-circuits the glue's
 * `fetch()` / `readAsync` paths.
 *
 * `nativeDir` points at another artifact directory with the same layout as
 * this package's `native/` (for example a fresh native build).
 *
 * @param {{ kind: 'raw' | 'jpeg', memoryProfile?: 'desktop' | 'low-memory', nativeDir?: string | URL }} options
 * @returns {Promise<unknown>} the populated Emscripten Module instance
 */
export async function loadNativeModuleForNode(options) {
  if (!isPlainObject(options)) {
    throw new TypeError(
      'loadNativeModuleForNode: options must be an object with { kind }',
    )
  }
  const { kind, memoryProfile = 'desktop', nativeDir } = options
  if (!VALID_KINDS.has(kind)) {
    throw new TypeError(
      `loadNativeModuleForNode: kind must be "raw" or "jpeg", got ${JSON.stringify(kind)}`,
    )
  }
  if (kind === 'raw' && !VALID_RAW_PROFILES.has(memoryProfile)) {
    throw new TypeError(
      `loadNativeModuleForNode: memoryProfile must be "desktop" or "low-memory", got ${JSON.stringify(memoryProfile)}`,
    )
  }

  const baseHref = resolveNativeDirHref(nativeDir)
  const { gluePath, wasmPath } = resolveArtifactPaths(kind, memoryProfile)
  const glueUrl = new URL(gluePath, baseHref)
  const wasmUrl = new URL(wasmPath, baseHref)

  const wasmBinary = await readFile(wasmUrl)
  const glueModule = await import(glueUrl.href)
  const factory = glueModule.default

  if (typeof factory !== 'function') {
    throw new TypeError(
      `loadNativeModuleForNode: ${gluePath} default export is not a factory function`,
    )
  }

  return factory({ wasmBinary })
}

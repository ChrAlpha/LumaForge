import { LumaRawRuntimeError } from '../src/errors'
import type { LumaRawRuntimeMemoryProfile } from '../src/types'
import type { EmbindModule } from './native-adapter'
import { createNativeFactory } from './native-adapter'
import type { LumaRawNativeFactory } from './native-types'

type NativeModuleFactory = (options?: {
  locateFile?: (path: string) => string
}) => Promise<unknown>

export type LoadNativeFactoryOptions = {
  memoryProfile?: LumaRawRuntimeMemoryProfile
}

function nativeAssetUrl(
  fileName: string,
  memoryProfile: LumaRawRuntimeMemoryProfile,
) {
  const currentUrl = new URL(import.meta.url)
  const pathParts = currentUrl.pathname.split('/').filter(Boolean)
  const inBuiltWorkerAssets =
    pathParts.at(-1)?.startsWith('runtime.worker') &&
    pathParts.at(-2) === 'assets'
  const nativeDir = inBuiltWorkerAssets
    ? `../native/${memoryProfile}/`
    : `../dist/native/${memoryProfile}/`

  return new URL(`${nativeDir}${fileName}`, import.meta.url).href
}

function createMissingNativeAssetsError(cause: unknown) {
  return new LumaRawRuntimeError(
    'RAW_RUNTIME_UNAVAILABLE',
    'Luma RAW native assets are missing or unavailable. Run `pnpm --filter @lumaforge/luma-raw-runtime build:native` before using the Luma RAW runtime.',
    { cause },
  )
}

export async function loadNativeFactory({
  memoryProfile = 'desktop',
}: LoadNativeFactoryOptions = {}): Promise<LumaRawNativeFactory> {
  const moduleUrl = nativeAssetUrl('luma_raw.js', memoryProfile)
  const wasmUrl = nativeAssetUrl('luma_raw.wasm', memoryProfile)
  let moduleImport: { default: NativeModuleFactory }

  try {
    moduleImport = (await import(/* @vite-ignore */ moduleUrl)) as {
      default: NativeModuleFactory
    }
  } catch (error) {
    throw createMissingNativeAssetsError(error)
  }

  let module: unknown
  try {
    module = await moduleImport.default({
      locateFile(path) {
        if (path.endsWith('.wasm')) {
          return wasmUrl
        }

        return path
      },
    })
  } catch (error) {
    throw createMissingNativeAssetsError(error)
  }

  return createNativeFactory(module as EmbindModule)
}

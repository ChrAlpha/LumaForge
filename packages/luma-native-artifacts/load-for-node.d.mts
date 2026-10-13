export type LumaNativeKind = 'raw' | 'jpeg'
export type LumaRawMemoryProfile = 'desktop' | 'low-memory'

export interface LoadNativeModuleForNodeOptions {
  kind: LumaNativeKind
  /** Defaults to 'desktop'. Ignored when kind === 'jpeg'. */
  memoryProfile?: LumaRawMemoryProfile
  /**
   * An artifact directory with the same layout as this package's `native/`
   * (`luma_jpeg.*`, `<memoryProfile>/luma_raw.*`). Defaults to the packaged
   * artifacts.
   */
  nativeDir?: string | URL
}

/**
 * The Emscripten Module instance returned by the glue's default factory.
 * The shape depends on which native module was loaded:
 * - `raw` exposes `LumaRawProcessor` (Embind class)
 * - `jpeg` exposes `LumaJpegEncoder` (Embind class)
 */
export type LumaNativeModuleHandle = Record<string, unknown>

export function loadNativeModuleForNode(
  options: LoadNativeModuleForNodeOptions,
): Promise<LumaNativeModuleHandle>

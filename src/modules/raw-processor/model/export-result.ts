import type {
  ColorGraphIntent,
  LUTColorProfile,
  LUTContractResolution,
  RawRenderExposure,
} from '@lumaforge/luma-color-runtime'
import type { ExportOutputResult } from '@lumaforge/render-engine/export'
import type { RenderManifest } from '@lumaforge/render-engine/manifest'

export type ExportCopyCapability =
  | { mode: 'full-resolution'; label: 'Copy full-resolution image' }
  | { mode: 'hq-preview'; label: 'Copy HQ preview image' }
  | {
      mode: 'preview-size'
      label: 'Copy preview-size image'
      reason: string
    }
  | { mode: 'unavailable'; reason: string }

export type ExportResultKind = 'full-resolution' | 'hq-preview'

export type ExportManifestUnavailableReason =
  | 'lut-unconfirmed'
  | 'lut-unhashed'
  | 'output-unhashed'
  | 'internal'

/** Lifecycle of the sealed manifest for a full-resolution result. */
export type ExportManifestState =
  | { status: 'sealing' }
  | { status: 'ready' }
  | { status: 'unavailable'; reason: ExportManifestUnavailableReason }

/**
 * The LUT contract a result was rendered under, as resolved for the LUT when
 * the request was captured. A confirmed contract keeps the profile fields the
 * color graph derives its effective input and output contracts from; labels
 * and aliases are not part of it.
 */
export type ExportResultLutContract =
  | Readonly<
      { status: 'confirmed' } & Pick<
        LUTColorProfile,
        | 'role'
        | 'inputGamut'
        | 'inputTransfer'
        | 'inputRange'
        | 'outputGamut'
        | 'outputTransfer'
        | 'outputRange'
      >
    >
  | Readonly<{
      status: 'unconfirmed'
      resolution: Exclude<LUTContractResolution['kind'], 'confirmed'>
    }>

/**
 * The LUT table a result was rendered through. The table is named by an
 * in-memory generation: it tells parsed tables apart on this page only, is
 * not a content hash, and is never written anywhere durable.
 */
export type ExportResultLutIdentity = Readonly<{
  inMemoryGeneration: number
  size: number
  domainMin: readonly [number, number, number]
  domainMax: readonly [number, number, number]
  contract: ExportResultLutContract
}>

/**
 * What one export request asked for, fixed by its producer before the result
 * exists: the result kind and attempt, the session and source file, the
 * normalized color intent with its continuous strength, the LUT the look
 * draws, the pinned RAW render exposure, and the committed geometry. View,
 * split, zoom and pan are not part of it. Deeply frozen.
 */
export type ExportResultIdentity = Readonly<{
  resultKind: ExportResultKind
  attemptId: string
  sessionId: string
  source: Readonly<{ name: string; size: number; lastModified: number }>
  colorIntent: Readonly<ColorGraphIntent>
  /** Null when the look draws no LUT. */
  lut: ExportResultLutIdentity | null
  rawRenderExposure: Readonly<RawRenderExposure> | null
  geometry: Readonly<{
    matrix: readonly number[]
    constrainCrop: boolean
  }> | null
  /** Every input above except the result kind and attempt, as one string. */
  inputSignature: string
}>

export type ExportShareCapability =
  | { available: true }
  | { available: false; reason: string }

export type ExportResult = {
  kind?: ExportResultKind
  output: ExportOutputResult
  filename: string
  width: number
  height: number
  size: number
  createdAt: number
  copyCapability: ExportCopyCapability
  /** Sealed render manifest; attached after a full-resolution export completes. */
  manifest?: RenderManifest
  /** Absent for results that never seal a manifest (HQ preview exports). */
  manifestState?: ExportManifestState
  /** The request this result answers, exactly as its producer captured it. */
  identity?: ExportResultIdentity
}

export function createExportResult({
  output,
  kind = 'full-resolution',
  filename = output.filename,
  width,
  height,
  now = () => Date.now(),
  copyCapability,
  manifest,
  manifestState,
  identity,
}: {
  output: ExportOutputResult
  kind?: ExportResultKind
  filename?: string
  width: number
  height: number
  now?: () => number
  copyCapability: ExportCopyCapability
  manifest?: RenderManifest
  manifestState?: ExportManifestState
  identity?: ExportResultIdentity
}): ExportResult {
  const createdAt = now()

  return {
    kind,
    output,
    filename,
    width,
    height,
    size: output.byteLength,
    createdAt,
    copyCapability,
    ...(manifest ? { manifest } : {}),
    ...(manifestState ? { manifestState } : {}),
    ...(identity ? { identity } : {}),
  }
}

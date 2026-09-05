import type {
  ProcessingParams,
  RawRenderExposure,
  SupportedExportColorGraphDescriptor,
} from '@lumaforge/luma-color-runtime'
import { normalizeSelectiveColorParams } from '@lumaforge/luma-color-runtime'
import type {
  LutIdentity,
  PolicyChoice,
  RenderEnvironment,
  RenderManifest,
  RenderParams,
  SourceRawIdentity,
} from '@lumaforge/render-engine/manifest'
import {
  createRenderManifest,
  createStreamingSha256,
  lutIdentityFromProfile,
} from '@lumaforge/render-engine/manifest'

import type { StyleAsset } from '../../model/session'

export type ExportManifestMemoryProfile = 'desktop' | 'low-memory'

/** Build-time runtime versions for the memory profile the export ran with. */
export function resolveExportEnvironment(
  memoryProfile: ExportManifestMemoryProfile,
): RenderEnvironment {
  return APP_RENDER_ENVIRONMENTS[memoryProfile]
}

function hasSelectiveColorShift(params: ProcessingParams): boolean {
  const bands = normalizeSelectiveColorParams(params)
  return Object.values(bands).some(
    (band) => band.hue !== 0 || band.saturation !== 0 || band.lightness !== 0,
  )
}

/**
 * Project the app's `ProcessingParams` onto the manifest `RenderParams`
 * shape used by the CLI (`toManifestRenderParams` there), so both writers
 * describe user intent identically.
 */
export function toManifestRenderParams(
  params: ProcessingParams,
  exposure: RawRenderExposure,
): RenderParams {
  return {
    exposure_ev: params.userExposureEv ?? 0,
    tone_curve: {
      contrast: params.userContrast ?? 0,
      highlights: params.userHighlights ?? 0,
      shadows: params.userShadows ?? 0,
      whites: params.userWhites ?? 0,
      blacks: params.userBlacks ?? 0,
    },
    color_balance: {
      temperature: params.userTemperature ?? 0,
      tint: params.userTint ?? 0,
    },
    saturation: {
      saturation: params.userSaturation ?? 0,
      vibrance: params.userVibrance ?? 0,
    },
    ...(hasSelectiveColorShift(params)
      ? { selective_color: normalizeSelectiveColorParams(params) }
      : {}),
    intensity: params.intensity,
    raw_render_exposure_ev: exposure.ev,
    raw_render_exposure_source: exposure.source,
  }
}

/**
 * LUT identity for the active style: requires the .cube SHA-256 recorded at
 * load time and a confirmed color contract. Returns `null` for built-in looks
 * or when either is missing (the manifest then records `lut: null`, which the
 * caller treats as "manifest unavailable" for custom LUT exports).
 */
export function lutIdentityForStyle(style: StyleAsset | null | undefined): {
  identity: LutIdentity | null
  reason?: string
} {
  if (!style || style.kind !== 'custom') return { identity: null }
  const asset = style.lutAsset
  if (!asset?.sha256) {
    return {
      identity: null,
      reason: 'The LUT file hash was not recorded when it was loaded.',
    }
  }
  if (asset.profileResolution?.kind !== 'confirmed') {
    return {
      identity: null,
      reason: 'The LUT color contract is not confirmed.',
    }
  }
  const result = lutIdentityFromProfile({
    filename: asset.sourceName ?? asset.title ?? style.name,
    sha256: asset.sha256,
    profile: asset.profileResolution.profile,
  })
  return result.identity
    ? { identity: result.identity }
    : { identity: null, reason: result.failure.reason }
}

function readBlobWithFileReader(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => {
      resolve(reader.result as ArrayBuffer)
    })
    reader.addEventListener('error', () => {
      reject(reader.error ?? new Error('Blob read failed.'))
    })
    reader.readAsArrayBuffer(blob)
  })
}

async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') {
    return new Uint8Array(await blob.arrayBuffer())
  }
  // DOM shims (jsdom) expose FileReader but no Blob.arrayBuffer().
  return new Uint8Array(await readBlobWithFileReader(blob))
}

async function* streamChunks(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      if (value) yield value
    }
  } finally {
    reader.releaseLock()
  }
}

async function blobChunks(blob: Blob): Promise<AsyncIterable<Uint8Array>> {
  if (typeof blob.stream === 'function') {
    return streamChunks(blob.stream())
  }
  const bytes = await readBlobBytes(blob)
  return (async function* single() {
    yield bytes
  })()
}

/** Streaming SHA-256 of a Blob or File without holding the whole payload in memory. */
export async function sha256OfBlob(blob: Blob): Promise<string> {
  const hasher = createStreamingSha256()
  for await (const chunk of await blobChunks(blob)) {
    hasher.update(chunk)
  }
  return hasher.digestHex()
}

export type BuildFullResExportManifestInput = {
  graph: SupportedExportColorGraphDescriptor
  params: ProcessingParams
  rawRenderExposure: RawRenderExposure
  source: SourceRawIdentity
  lut: LutIdentity | null
  output: {
    sha256: string
    width: number
    height: number
    /** JPEG quality on the 0..1 scale used by the export job. */
    quality: number
    filename: string
  }
  policy: PolicyChoice
  environment: RenderEnvironment
  producedAt?: Date
}

export function buildFullResExportManifest(
  input: BuildFullResExportManifestInput,
): RenderManifest {
  return createRenderManifest({
    kind: 'export',
    source_raw: input.source,
    lut: input.lut,
    graph: input.graph,
    render_params: toManifestRenderParams(
      input.params,
      input.rawRenderExposure,
    ),
    policy: input.policy,
    environment: input.environment,
    output: {
      width: input.output.width,
      height: input.output.height,
      quality: Math.round(input.output.quality * 100),
      filename: input.output.filename,
      sha256: input.output.sha256,
    },
    parent_manifest_sha256: null,
    produced_at: input.producedAt?.toISOString(),
  })
}

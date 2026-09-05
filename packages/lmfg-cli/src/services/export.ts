import type {
  RawRenderExposure,
  SupportedExportColorGraphDescriptor,
} from '@lumaforge/luma-color-runtime'
import { exposureMultiplierFromEv } from '@lumaforge/luma-color-runtime'
import type { LumaRawExportCapability } from '@lumaforge/luma-raw-runtime'
import type { RenderManifest } from '@lumaforge/render-engine'
import { sha256Hex } from '@lumaforge/render-engine'
import type { FullResolutionExportProgress } from '@lumaforge/render-engine/export'
import {
  createNodeJpegRowSink,
  preserveJpegMetadataBytes,
  runFullResolutionJpegExport,
} from '@lumaforge/render-engine/export'
import { QUICK_PREVIEW_MAX_PIXELS } from '@lumaforge/render-engine/preview'

import { LmfgError } from '../protocol/errors'
import type { LmfgRuntime } from '../runtime/node-runtime'
import type { LoadedSource } from '../runtime/source-loader'
import type { RenderParams } from '../schemas/params'
import {
  buildColorGraph,
  requireSupportedGraph,
  resolveExposure,
} from './color-graph'
import type { ResolvedLut } from './lut'
import { percentToQuality } from './manifest'

export const DEFAULT_EXPORT_STRIP_ROWS = 512

export function assertJpegBytes(bytes: Uint8Array): void {
  const ok =
    bytes.byteLength >= 4 &&
    bytes[0] === 0xFF &&
    bytes[1] === 0xD8 &&
    bytes[bytes.byteLength - 2] === 0xFF &&
    bytes[bytes.byteLength - 1] === 0xD9
  if (!ok) {
    throw new LmfgError('export.refused', {
      message:
        'The export produced an incomplete JPEG stream; refusing to write it.',
      retryable: true,
    })
  }
}

export function exposureFromManifest(
  manifest: RenderManifest,
): RawRenderExposure | null {
  const ev = manifest.render_params.raw_render_exposure_ev
  const source = manifest.render_params.raw_render_exposure_source
  if (typeof ev !== 'number' || !source) return null
  return { ev, multiplier: exposureMultiplierFromEv(ev), source }
}

function requireExportCapability(
  capability: LumaRawExportCapability,
): LumaRawExportCapability {
  if (capability.supported && capability.width > 0 && capability.height > 0)
    return capability
  throw new LmfgError('source.export_unsupported', {
    message: `This RAW cannot be exported at full resolution (${capability.reasons.join(', ') || 'unsupported source'}).`,
    details: {
      reasons: capability.reasons,
      strategy: capability.strategy ?? null,
    },
    suggestedNextActions: ['lmfg inspect --session <id>'],
  })
}

export type ExportRunInput = {
  runtime: LmfgRuntime
  source: LoadedSource
  params: RenderParams
  lut: ResolvedLut | null
  /** Pre-resolved exposure (from a candidate manifest) or `null` to resolve from the quick frame. */
  exposure: RawRenderExposure | null
  quality: number
  preferredRows?: number
  signal?: AbortSignal
  onProgress?: (progress: FullResolutionExportProgress) => void
}

export type ExportRunResult = {
  jpeg: Uint8Array
  sha256: string
  width: number
  height: number
  graph: SupportedExportColorGraphDescriptor
  exposure: RawRenderExposure
  strips: number
  timings: Record<string, number>
}

export async function runFullResolutionExport(
  input: ExportRunInput,
): Promise<ExportRunResult> {
  const timings: Record<string, number> = {}
  const total = performance.now()
  const raw = await input.runtime.raw()
  const jpegRuntime = await input.runtime.jpeg()
  // Resolve the raw-render exposure from a throwaway quick decode first: a
  // quick decode must never share the session used for processed-window
  // export (LibRaw state is not repeatable across the two paths).
  let exposure = input.exposure
  if (!exposure) {
    const exposureStart = performance.now()
    const frame = await raw.decodeQuick(
      input.source.input,
      { maxOutputPixels: QUICK_PREVIEW_MAX_PIXELS },
      input.signal,
    )
    exposure = resolveExposure(input.params, {
      baselineExposure: frame.metadata.baselineExposure,
      frame,
    })
    timings.exposure_ms = performance.now() - exposureStart
  }
  const session = await raw.openSession(
    input.source.input,
    { maxOutputPixels: QUICK_PREVIEW_MAX_PIXELS },
    input.signal,
  )
  try {
    const capability = requireExportCapability(
      await session.probeExportCapability(input.signal),
    )
    const graph = requireSupportedGraph(
      buildColorGraph(input.params, input.lut?.lutData ?? null, exposure),
    )

    let strips = 0
    const exportStart = performance.now()
    await session.beginProcessedWindowExport?.(input.signal)
    let output
    try {
      output = await runFullResolutionJpegExport({
        capability,
        graph,
        readProcessedWindow: session.readProcessedWindow,
        quality: percentToQuality(input.quality),
        preferredRows: input.preferredRows ?? DEFAULT_EXPORT_STRIP_ROWS,
        concurrency: 1,
        jpegSink: createNodeJpegRowSink(jpegRuntime),
        signal: input.signal,
        onProgress: (progress) => {
          strips = progress.totalStrips
          input.onProgress?.(progress)
        },
      })
    } finally {
      await session.endProcessedWindowExport?.().catch(() => undefined)
    }
    timings.export_ms = performance.now() - exportStart
    if (output.kind !== 'bytes') {
      throw new LmfgError('export.refused', {
        message: `Unexpected export output kind "${output.kind}".`,
      })
    }
    const jpeg = preserveJpegMetadataBytes({
      jpeg: output.bytes,
      metadata: session.probe,
      width: capability.width,
      height: capability.height,
    })
    assertJpegBytes(jpeg)
    timings.total_ms = performance.now() - total
    return {
      jpeg,
      sha256: sha256Hex(jpeg),
      width: capability.width,
      height: capability.height,
      graph,
      exposure,
      strips,
      timings,
    }
  } finally {
    session.dispose()
  }
}

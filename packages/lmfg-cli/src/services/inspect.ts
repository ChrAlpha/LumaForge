import type {
  LumaEmbeddedPreview,
  LumaRawExportCapability,
} from '@lumaforge/luma-raw-runtime'
import { QUICK_PREVIEW_MAX_PIXELS } from '@lumaforge/render-engine/preview'

import type { LmfgRuntime } from '../runtime/node-runtime'
import type { LoadedSource } from '../runtime/source-loader'
import { parseRenderParams } from '../schemas/params'
import type { InspectResult } from '../schemas/results'
import { writeFileAtomic } from '../workspace/atomic-fs'
import { toFileUri } from '../workspace/paths'
import { resolveExposure } from './color-graph'

export type InspectInput = {
  runtime: LmfgRuntime
  source: LoadedSource
  sessionId: string | null
  embeddedPreviewPath: string | null
  signal?: AbortSignal
}

function nullable<T>(value: T | undefined): T | null {
  return value === undefined ? null : value
}

export function decodedDimensions(
  capability: LumaRawExportCapability,
  probe: { width?: number; height?: number },
): { width: number; height: number } {
  if (capability.width > 0 && capability.height > 0) {
    return { width: capability.width, height: capability.height }
  }
  return { width: probe.width ?? 0, height: probe.height ?? 0 }
}

export async function inspectSource(
  input: InspectInput,
): Promise<InspectResult> {
  const timings: Record<string, number> = {}
  const started = performance.now()
  const raw = await input.runtime.raw()
  const session = await raw.openSession(
    input.source.input,
    { maxOutputPixels: QUICK_PREVIEW_MAX_PIXELS },
    input.signal,
  )
  try {
    const probe = session.probe
    timings.open_ms = performance.now() - started

    let embedded: LumaEmbeddedPreview | null = null
    const embeddedStart = performance.now()
    try {
      embedded = await session.extractEmbeddedPreview(input.signal)
    } catch {
      embedded = null
    }
    timings.embedded_preview_ms = performance.now() - embeddedStart

    const capabilityStart = performance.now()
    const capability = await session.probeExportCapability(input.signal)
    timings.export_capability_ms = performance.now() - capabilityStart

    const decodeStart = performance.now()
    const frame = await session.decodeQuick(
      { maxOutputPixels: QUICK_PREVIEW_MAX_PIXELS },
      input.signal,
    )
    timings.quick_decode_ms = performance.now() - decodeStart
    const exposure = resolveExposure(parseRenderParams({}), {
      baselineExposure: probe.baselineExposure,
      frame: { data: frame.data, width: frame.width, height: frame.height },
    })

    let embeddedUri: string | null = null
    if (embedded && input.embeddedPreviewPath) {
      await writeFileAtomic(input.embeddedPreviewPath, embedded.data)
      embeddedUri = toFileUri(input.embeddedPreviewPath)
    }

    timings.total_ms = performance.now() - started
    return {
      session_id: input.sessionId,
      source: {
        path: input.source.absolutePath,
        filename: input.source.filename,
        byte_size: input.source.byteSize,
        sha256: input.source.sha256,
      },
      metadata: {
        make: nullable(probe.make),
        model: nullable(probe.model),
        lens: nullable(probe.lens),
        iso: nullable(probe.iso),
        aperture: nullable(probe.aperture),
        focal_length: nullable(probe.focalLength),
        shutter: nullable(probe.shutter),
        timestamp: nullable(probe.timestamp),
        orientation: nullable(probe.orientation),
        width: nullable(probe.width),
        height: nullable(probe.height),
        raw_width: nullable(probe.rawWidth),
        raw_height: nullable(probe.rawHeight),
        baseline_exposure: nullable(probe.baselineExposure),
        support_level: probe.supportLevel,
      },
      decoded_dimensions: decodedDimensions(capability, probe),
      embedded_preview: embedded
        ? {
            width: embedded.width,
            height: embedded.height,
            mime_type: embedded.mimeType,
            byte_size: embedded.data.byteLength,
            uri: embeddedUri,
          }
        : null,
      export_capability: {
        supported: capability.supported,
        strategy: capability.strategy ?? null,
        width: capability.width,
        height: capability.height,
        reasons: [...capability.reasons],
      },
      raw_render_exposure: exposure,
      timings_ms: timings,
    }
  } finally {
    session.dispose()
  }
}

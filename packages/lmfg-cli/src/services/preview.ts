import type {
  RawRenderExposure,
  SupportedExportColorGraphDescriptor,
} from '@lumaforge/luma-color-runtime'
import type { LumaJpegNodeRuntime } from '@lumaforge/luma-jpeg-runtime/node'
import type {
  LumaRawDecodeSession,
  LumaRawProbe,
} from '@lumaforge/luma-raw-runtime'
import { sha256Hex } from '@lumaforge/render-engine'
import {
  BOUNDED_HQ_PREVIEW_MAX_PIXELS,
  encodePreviewFrameToJpeg,
  QUICK_PREVIEW_MAX_PIXELS,
  renderCpuPreviewFrame,
} from '@lumaforge/render-engine/preview'

import type { LmfgRuntime } from '../runtime/node-runtime'
import type { LoadedSource } from '../runtime/source-loader'
import type { RenderParams } from '../schemas/params'
import {
  buildColorGraph,
  requireSupportedGraph,
  resolveExposure,
} from './color-graph'
import type { ResolvedLut } from './lut'

export type DecodedFrame = {
  data: Uint16Array
  width: number
  height: number
  decode: 'quick' | 'bounded-hq'
}

export function clampMaxPixels(maxPixels: number | undefined): number {
  if (!maxPixels || !Number.isFinite(maxPixels) || maxPixels <= 0)
    return QUICK_PREVIEW_MAX_PIXELS
  return Math.min(Math.floor(maxPixels), BOUNDED_HQ_PREVIEW_MAX_PIXELS)
}

export async function decodeFrame(
  session: LumaRawDecodeSession,
  maxPixels: number,
  signal?: AbortSignal,
): Promise<DecodedFrame> {
  if (maxPixels <= QUICK_PREVIEW_MAX_PIXELS) {
    const frame = await session.decodeQuick(
      { maxOutputPixels: maxPixels },
      signal,
    )
    return {
      data: frame.data,
      width: frame.width,
      height: frame.height,
      decode: 'quick',
    }
  }
  const frame = await session.decodeBoundedHq(
    { maxOutputPixels: maxPixels },
    signal,
  )
  return {
    data: frame.data,
    width: frame.width,
    height: frame.height,
    decode: 'bounded-hq',
  }
}

export type RenderedFrame = {
  rgba: Uint8ClampedArray
  width: number
  height: number
  jpeg: Uint8Array
  sha256: string
  timings: { render_ms: number; encode_ms: number }
}

export async function renderFrameToJpeg(input: {
  frame: Pick<DecodedFrame, 'data' | 'width' | 'height'>
  graph: SupportedExportColorGraphDescriptor
  jpegRuntime: LumaJpegNodeRuntime
  quality: number
}): Promise<RenderedFrame> {
  const renderStart = performance.now()
  const rgba = renderCpuPreviewFrame({
    data: input.frame.data,
    width: input.frame.width,
    height: input.frame.height,
    graph: input.graph,
  })
  const render_ms = performance.now() - renderStart
  const encodeStart = performance.now()
  const jpeg = (await encodePreviewFrameToJpeg(
    (options) => input.jpegRuntime.createEncoder(options),
    {
      rgba,
      width: input.frame.width,
      height: input.frame.height,
      quality: input.quality,
    },
  )) as Uint8Array
  return {
    rgba,
    width: input.frame.width,
    height: input.frame.height,
    jpeg,
    sha256: sha256Hex(jpeg),
    timings: { render_ms, encode_ms: performance.now() - encodeStart },
  }
}

export type PreviewRenderInput = {
  runtime: LmfgRuntime
  source: LoadedSource
  params: RenderParams
  lut: ResolvedLut | null
  maxPixels: number
  quality: number
  /** Pre-resolved exposure (replays); resolved from params + frame when omitted. */
  exposure?: RawRenderExposure
  signal?: AbortSignal
}

export type PreviewRenderResult = {
  probe: LumaRawProbe
  frame: DecodedFrame
  exposure: RawRenderExposure
  graph: SupportedExportColorGraphDescriptor
  rendered: RenderedFrame
  timings: Record<string, number>
}

export async function renderPreview(
  input: PreviewRenderInput,
): Promise<PreviewRenderResult> {
  const timings: Record<string, number> = {}
  const total = performance.now()
  const raw = await input.runtime.raw()
  const maxPixels = clampMaxPixels(input.maxPixels)
  const session = await raw.openSession(
    input.source.input,
    { maxOutputPixels: Math.min(maxPixels, QUICK_PREVIEW_MAX_PIXELS) },
    input.signal,
  )
  try {
    const decodeStart = performance.now()
    const frame = await decodeFrame(session, maxPixels, input.signal)
    timings.decode_ms = performance.now() - decodeStart
    const exposure =
      input.exposure ??
      resolveExposure(input.params, {
        baselineExposure: session.probe.baselineExposure,
        frame,
      })
    const graph = requireSupportedGraph(
      buildColorGraph(input.params, input.lut?.lutData ?? null, exposure),
    )
    const rendered = await renderFrameToJpeg({
      frame,
      graph,
      jpegRuntime: await input.runtime.jpeg(),
      quality: input.quality,
    })
    timings.render_ms = rendered.timings.render_ms
    timings.encode_ms = rendered.timings.encode_ms
    timings.total_ms = performance.now() - total
    return { probe: session.probe, frame, exposure, graph, rendered, timings }
  } finally {
    session.dispose()
  }
}

import type {
  RawRenderExposure,
  SupportedExportColorGraphDescriptor,
} from '@lumaforge/luma-color-runtime'
import type { LumaJpegNodeRuntime } from '@lumaforge/luma-jpeg-runtime/node'
import type { LumaRawDecodeSession } from '@lumaforge/luma-raw-runtime'
import type { RenderEnvironment } from '@lumaforge/render-engine'
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
import type { PreviewResult, SessionRecord } from '../schemas/results'
import { writeFileAtomic, writeJsonAtomic } from '../workspace/atomic-fs'
import { formatPreviewId } from '../workspace/ids'
import { toFileUri, workspacePaths } from '../workspace/paths'
import type { SessionStore } from '../workspace/session-store'
import {
  buildColorGraph,
  requireSupportedGraph,
  resolveExposure,
} from './color-graph'
import { decodedDimensions } from './inspect'
import type { ResolvedLut } from './lut'
import {
  buildRenderManifest,
  percentToQuality,
  toSourceIdentity,
} from './manifest'

/** The row band the engine's CPU preview renders a frame in. */
export const PREVIEW_ROW_SLICE = 32

export type DecodedFrame = {
  data: Uint16Array
  width: number
  height: number
  sourceDimensions: { width: number; height: number }
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
  const sourceDimensions = decodedDimensions(
    await session.probeExportCapability(signal),
    session.probe,
  )
  const decode = maxPixels <= QUICK_PREVIEW_MAX_PIXELS ? 'quick' : 'bounded-hq'
  const options = { maxOutputPixels: maxPixels }
  const frame =
    decode === 'quick'
      ? await session.decodeQuick(options, signal)
      : await session.decodeBoundedHq(options, signal)
  return {
    data: frame.data,
    width: frame.width,
    height: frame.height,
    sourceDimensions,
    decode,
  }
}

/**
 * Resolves the raw-render exposure for params rendered from one session.
 *
 * Automatic exposure is measured on the standard quick frame
 * (`QUICK_PREVIEW_MAX_PIXELS`), the frame export measures on, so one source
 * resolves one auto EV whatever the output size or candidate. The frame is
 * decoded on the session at most once, and not at all when the rendered frame
 * already is the standard quick frame, when the params pin an explicit EV
 * (zero included), or when the source carries a DNG baseline exposure.
 * The extra decode is timed as `exposure_ms`.
 */
export function createExposureResolver(input: {
  session: LumaRawDecodeSession
  frame: DecodedFrame
  maxPixels: number
  timings: Record<string, number>
  signal?: AbortSignal
}): (params: RenderParams) => Promise<RawRenderExposure> {
  const baselineExposure = input.session.probe.baselineExposure
  let auto: Promise<RawRenderExposure> | null = null
  const measureAuto = async (params: RenderParams) => {
    if (
      input.frame.decode === 'quick' &&
      input.maxPixels === QUICK_PREVIEW_MAX_PIXELS
    ) {
      return resolveExposure(params, { baselineExposure, frame: input.frame })
    }
    const start = performance.now()
    const frame = await input.session.decodeQuick(
      { maxOutputPixels: QUICK_PREVIEW_MAX_PIXELS },
      input.signal,
    )
    input.timings.exposure_ms = performance.now() - start
    return resolveExposure(params, { baselineExposure, frame })
  }
  return async (params) => {
    // An explicit EV and a DNG baseline exposure both win over image
    // statistics, so neither needs a frame.
    if (
      params.raw_render_exposure !== 'auto' ||
      Number.isFinite(baselineExposure)
    ) {
      return resolveExposure(params, { baselineExposure, frame: null })
    }
    auto ??= measureAuto(params)
    return auto
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
  /**
   * Pre-resolved exposure (replays); resolved from params and the standard
   * quick frame when omitted.
   */
  exposure?: RawRenderExposure
  signal?: AbortSignal
}

export type PreviewRenderResult = {
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
      (await createExposureResolver({
        session,
        frame,
        maxPixels,
        timings,
        signal: input.signal,
      })(input.params))
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
    return { frame, exposure, graph, rendered, timings }
  } finally {
    session.dispose()
  }
}

export type PreviewPublishInput = Omit<
  PreviewRenderInput,
  'exposure' | 'quality'
> & {
  store: SessionStore
  record: SessionRecord
  environment: RenderEnvironment
  /** JPEG quality as an integer percentage. */
  quality: number
}

/**
 * Renders one preview and publishes the JPEG and its manifest into the
 * session under the next preview id.
 */
export async function publishPreview(
  input: PreviewPublishInput,
): Promise<PreviewResult> {
  const { record, source, lut, params } = input
  const result = await renderPreview({
    runtime: input.runtime,
    source,
    params,
    lut,
    maxPixels: input.maxPixels,
    quality: percentToQuality(input.quality),
    signal: input.signal,
  })
  const previewId = formatPreviewId(
    await input.store.allocate(record.id, 'previews'),
  )
  const root = input.store.root
  const outputPath = workspacePaths.previewFile(root, record.id, previewId)
  const manifestPath = workspacePaths.previewManifestFile(
    root,
    record.id,
    previewId,
  )
  const manifest = buildRenderManifest({
    kind: 'preview',
    source: toSourceIdentity(source, result.frame.sourceDimensions),
    lut: lut?.identity ?? null,
    graph: result.graph,
    params,
    exposure: result.exposure,
    policy: {
      kind:
        result.frame.decode === 'quick'
          ? 'preview-quick'
          : 'preview-bounded-hq',
      row_slice: PREVIEW_ROW_SLICE,
      concurrency: 1,
      max_pixels: input.maxPixels,
    },
    environment: input.environment,
    output: {
      width: result.frame.width,
      height: result.frame.height,
      quality: input.quality,
      filename: `${previewId}.jpg`,
      sha256: result.rendered.sha256,
    },
    parentManifestSha256: null,
  })
  await writeFileAtomic(outputPath, result.rendered.jpeg)
  await writeJsonAtomic(manifestPath, manifest)
  return {
    session_id: record.id,
    preview_id: previewId,
    output: {
      uri: toFileUri(outputPath),
      path: outputPath,
      width: result.frame.width,
      height: result.frame.height,
      byte_size: result.rendered.jpeg.byteLength,
      sha256: result.rendered.sha256,
      quality: input.quality,
    },
    manifest_uri: toFileUri(manifestPath),
    manifest_sha256: manifest.manifest_sha256,
    decode: result.frame.decode,
    raw_render_exposure: result.exposure,
    color_graph_fingerprint: manifest.color_graph.fingerprint,
    timings_ms: result.timings,
  }
}

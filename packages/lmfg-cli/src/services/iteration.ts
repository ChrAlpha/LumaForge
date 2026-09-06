import type { RawRenderExposure } from '@lumaforge/luma-color-runtime'
import type { RenderEnvironment } from '@lumaforge/render-engine'
import {
  encodePreviewFrameToJpeg,
  QUICK_PREVIEW_MAX_PIXELS,
} from '@lumaforge/render-engine/preview'

import type { Output } from '../protocol/output'
import type { LmfgRuntime } from '../runtime/node-runtime'
import type { LoadedSource } from '../runtime/source-loader'
import { resolveCandidateWorkerScript } from '../runtime/versions'
import type { ContactSheetOptions, NormalizedPlan } from '../schemas/plan'
import type {
  CandidateSummary,
  IterationResult,
  SessionRecord,
} from '../schemas/results'
import { formatIterationId } from '../workspace/ids'
import type { IterationStore } from '../workspace/iteration-store'
import { toFileUri } from '../workspace/paths'
import type { SessionStore } from '../workspace/session-store'
import type { CandidateTask, ConcurrencyRequest } from './candidate-pool'
import { renderCandidates, resolveConcurrency } from './candidate-pool'
import {
  buildColorGraph,
  requireSupportedGraph,
  resolveExposure,
} from './color-graph'
import type { SheetTile } from './contact-sheet'
import { buildContactSheet, fitTileSize } from './contact-sheet'
import type { ResolvedLut } from './lut'
import { resolveLutForParams } from './lut'
import {
  buildRenderManifest,
  percentToQuality,
  toSourceIdentity,
} from './manifest'
import { clampMaxPixels, decodeFrame } from './preview'
import { captureResourceUsage } from './resource'

export type IterationRunInput = {
  runtime: LmfgRuntime
  source: LoadedSource
  record: SessionRecord
  store: SessionStore
  iterationStore: IterationStore
  environment: RenderEnvironment
  output: Output
  cwd: string
  signal?: AbortSignal
  plan: NormalizedPlan
  options: {
    maxPixels: number
    quality: number
    contactSheet: boolean
    sheetOptions: ContactSheetOptions | null
    concurrency: ConcurrencyRequest
  }
}

const DEFAULT_TILE_WIDTH = 320
const DEFAULT_GAP = 4

export async function runIteration(
  input: IterationRunInput,
): Promise<IterationResult> {
  const timings: Record<string, number> = {}
  const total = performance.now()
  const { plan, record, output } = input

  // Fail closed before touching the RAW: every candidate LUT contract must resolve.
  const lutCache = new Map<string, ResolvedLut | null>()
  const luts: Array<ResolvedLut | null> = []
  for (const candidate of plan.candidates) {
    const key = candidate.params.lut
      ? JSON.stringify(candidate.params.lut)
      : 'none'
    if (!lutCache.has(key)) {
      lutCache.set(
        key,
        await resolveLutForParams(candidate.params.lut, input.cwd),
      )
    }
    luts.push(lutCache.get(key) ?? null)
  }

  const sheetOptions = input.options.contactSheet
    ? {
        cols:
          input.options.sheetOptions?.cols ??
          Math.ceil(Math.sqrt(plan.candidates.length)),
        tile_width:
          input.options.sheetOptions?.tile_width ?? DEFAULT_TILE_WIDTH,
        gap: input.options.sheetOptions?.gap ?? DEFAULT_GAP,
      }
    : null
  const iterationId = formatIterationId(
    await input.store.allocate(record.id, 'iterations'),
  )
  const iterationDir = await input.iterationStore.create({
    schema: 'lmfg.iteration.v1',
    id: iterationId,
    session_id: record.id,
    created_at: new Date().toISOString(),
    kind: plan.kind,
    base: plan.base,
    candidates: plan.candidates.map((candidate) => ({
      id: candidate.id,
      tag: candidate.tag,
      params: candidate.params,
    })),
    options: {
      max_pixels: input.options.maxPixels,
      quality: input.options.quality,
      contact_sheet: sheetOptions,
    },
  })

  const emit = async (event: Record<string, unknown> & { event: string }) => {
    output.event(event)
    await input.iterationStore.appendEvent(iterationId, event)
  }
  await emit({
    event: 'started',
    command: `render.${plan.kind}`,
    session_id: record.id,
    iteration_id: iterationId,
    total: plan.candidates.length,
  })

  const raw = await input.runtime.raw()
  const jpeg = await input.runtime.jpeg()
  const maxPixels = clampMaxPixels(input.options.maxPixels)
  const session = await raw.openSession(
    input.source.input,
    { maxOutputPixels: Math.min(maxPixels, QUICK_PREVIEW_MAX_PIXELS) },
    input.signal,
  )
  try {
    const decodeStart = performance.now()
    const frame = await decodeFrame(session, maxPixels, input.signal)
    timings.decode_ms = performance.now() - decodeStart
    const sourceIdentity = toSourceIdentity(
      input.source,
      frame.sourceDimensions,
    )

    const exposures: RawRenderExposure[] = []
    const renderParams: CandidateTask[] = plan.candidates.map(
      (candidate, index) => {
        const exposure = resolveExposure(candidate.params, {
          baselineExposure: session.probe.baselineExposure,
          frame,
        })
        exposures.push(exposure)
        const graph = requireSupportedGraph(
          buildColorGraph(
            candidate.params,
            luts[index]?.lutData ?? null,
            exposure,
          ),
        )
        return {
          graph,
          quality: percentToQuality(input.options.quality),
        }
      },
    )

    const tileSize = fitTileSize(
      frame.width,
      frame.height,
      sheetOptions?.tile_width ?? DEFAULT_TILE_WIDTH,
    )
    const tiles: SheetTile[] = []
    const summaries: CandidateSummary[] = []
    const renderStart = performance.now()
    const pool = renderCandidates({
      frame,
      tasks: renderParams,
      tile: tileSize,
      concurrency: resolveConcurrency({
        requested: input.options.concurrency,
        candidates: renderParams.length,
        memoryProfile: input.runtime.memoryProfile,
      }),
      workerScript: resolveCandidateWorkerScript(),
      createEncoder: (options) => jpeg.createEncoder(options),
      signal: input.signal,
    })
    for await (const result of pool.results) {
      const candidate = plan.candidates[result.index]
      const bytes = result.jpeg
      const { sha256, metrics } = result
      const tile: SheetTile = {
        id: candidate.id,
        rgba: result.tile.rgba,
        width: result.tile.width,
        height: result.tile.height,
      }
      tiles[result.index] = tile
      const manifest = buildRenderManifest({
        kind: 'candidate',
        source: sourceIdentity,
        lut: luts[result.index]?.identity ?? null,
        graph: renderParams[result.index].graph,
        params: candidate.params,
        exposure: exposures[result.index],
        policy: {
          kind: 'candidate',
          row_slice: 32,
          concurrency: pool.concurrency,
          max_pixels: maxPixels,
        },
        environment: input.environment,
        output: {
          width: result.width,
          height: result.height,
          quality: input.options.quality,
          filename: 'preview.jpg',
          sha256,
        },
        parentManifestSha256: null,
      })
      const paths = await input.iterationStore.writeCandidate(
        iterationId,
        candidate.id,
        {
          previewJpeg: bytes,
          manifest,
          metrics,
          tile,
          params: candidate.params,
        },
      )
      const summary: CandidateSummary = {
        id: candidate.id,
        index: result.index,
        tag: candidate.tag,
        preview_uri: toFileUri(paths.preview),
        manifest_uri: toFileUri(paths.manifest),
        manifest_sha256: manifest.manifest_sha256,
        metrics_uri: toFileUri(paths.metrics),
        width: result.width,
        height: result.height,
        byte_size: bytes.byteLength,
        sha256,
      }
      summaries[result.index] = summary
      await emit({
        event: 'candidate.ready',
        candidate_id: candidate.id,
        index: result.index + 1,
        total: plan.candidates.length,
        preview_uri: summary.preview_uri,
        manifest_sha256: manifest.manifest_sha256,
      })
    }
    timings.render_ms = performance.now() - renderStart

    let contactSheet: IterationResult['contact_sheet'] = null
    if (sheetOptions) {
      const sheetStart = performance.now()
      const built = buildContactSheet({
        tiles,
        cols: sheetOptions.cols,
        gap: sheetOptions.gap,
      })
      const sheetJpeg = (await encodePreviewFrameToJpeg(
        (options) => jpeg.createEncoder(options),
        {
          rgba: built.sheet.rgba,
          width: built.sheet.width,
          height: built.sheet.height,
          quality: 0.85,
        },
      )) as Uint8Array
      const written = await input.iterationStore.writeContactSheet(
        iterationId,
        {
          jpeg: sheetJpeg,
          map: {
            schema: 'lmfg.contact-sheet-map.v1',
            iteration_id: iterationId,
            cols: built.cols,
            rows: built.rows,
            tile_width: built.tileWidth,
            tile_height: built.tileHeight,
            gap: built.gap,
            width: built.sheet.width,
            height: built.sheet.height,
            tiles: built.map,
          },
        },
      )
      contactSheet = {
        uri: toFileUri(written.sheet),
        map_uri: toFileUri(written.map),
        width: built.sheet.width,
        height: built.sheet.height,
        cols: built.cols,
        rows: built.rows,
        tile_width: built.tileWidth,
        tile_height: built.tileHeight,
      }
      timings.contact_sheet_ms = performance.now() - sheetStart
      await emit({
        event: 'artifact.ready',
        role: 'contact-sheet',
        uri: contactSheet.uri,
        map_uri: contactSheet.map_uri,
      })
    }

    timings.total_ms = performance.now() - total
    await emit({
      event: 'iteration.completed',
      iteration_id: iterationId,
      candidate_count: summaries.length,
    })
    return {
      session_id: record.id,
      iteration_id: iterationId,
      iteration_dir: iterationDir,
      kind: plan.kind,
      candidate_count: summaries.length,
      candidates: summaries,
      contact_sheet: contactSheet,
      decode: frame.decode,
      raw_render_exposure: exposures[0],
      concurrency: pool.concurrency,
      timings_ms: timings,
      resource: captureResourceUsage(),
    }
  } finally {
    session.dispose()
  }
}

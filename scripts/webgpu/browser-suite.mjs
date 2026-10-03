import {
  LIMITS,
  makeImage,
  pixelDiff,
  readCanvas,
  readPresentedCanvas,
  scenarios,
  toDisplayBytes,
} from './fixtures.mjs'
import { runPerformance } from './performance.mjs'

// Params the authoritative color graph consumes. View mode and compare split
// are presentation-only and are composed separately below.
const GRAPH_PARAM_KEYS = [
  'styleKind',
  'intensity',
  'builtinPreset',
  'userExposureEv',
  'userContrast',
  'userHighlights',
  'userShadows',
  'userWhites',
  'userBlacks',
  'userTemperature',
  'userTint',
  'userSaturation',
  'userVibrance',
  'selectiveColor',
]

export async function runAcceptance({ iterations, unfilterable }) {
  const { TRANSFER_FUNCTIONS, resolveExportColorGraph } =
    await import('@lumaforge/luma-color-runtime')
  const { renderCpuPreviewFrame } =
    await import('/packages/render-engine/src/preview/preview-render.ts')
  const { WebGPUProcessingPipeline } =
    await import('/src/lib/webgpu/pipeline.ts')
  const adapter = await navigator.gpu?.requestAdapter()
  if (!adapter) throw new Error('WEBGPU_ADAPTER_UNAVAILABLE')
  const info = adapter.info
  const report = {
    adapter: {
      vendor: info.vendor,
      architecture: info.architecture,
      device: info.device,
      description: info.description,
      isFallbackAdapter: info.isFallbackAdapter,
    },
    reference:
      'renderCpuPreviewFrame(resolveExportColorGraph(params)): the TS row-band executor behind full-resolution export, lmfg, and the CPU preview',
    limits: LIMITS,
    tests: [],
    performance: {},
  }
  window.__webgpuValidationReport = report
  const add = (name, passed, evidence) =>
    report.tests.push({ name, passed, ...evidence })
  const check = (name, actual, expected, limits, extra = {}) => {
    const diff = pixelDiff(actual, expected)
    add(
      name,
      diff.nonfinite === 0 &&
        diff.max <= limits.max &&
        diff.mean <= limits.mean,
      { diff, ...extra },
    )
    return diff
  }
  const PRESENTED = { max: LIMITS.maxByteError, mean: LIMITS.meanByteError }
  const REFERENCE = {
    max: LIMITS.referenceMaxByteError,
    mean: LIMITS.referenceMeanByteError,
  }

  const renderReference = (fixture, params, lut, variant) => {
    if (fixture.layout !== 'rgb-u16')
      throw new Error('REFERENCE_REQUIRES_LINEAR_PROPHOTO_INPUT')
    const rawRenderExposure = {
      ev: fixture.renderExposureEv,
      multiplier: fixture.renderExposureMultiplier,
      source: 'user',
    }
    const input =
      variant === 'technical-base'
        ? {
            styleKind: 'none',
            intensity: 0,
            builtinPreset: null,
            lut: null,
            rawRenderExposure,
          }
        : {
            ...Object.fromEntries(
              GRAPH_PARAM_KEYS.map((key) => [key, params[key]]),
            ),
            lut: lut ?? null,
            rawRenderExposure,
          }
    const graph = resolveExportColorGraph(input)
    if (!graph.supported)
      throw new Error(`REFERENCE_GRAPH_UNSUPPORTED: ${graph.reason}`)
    return renderCpuPreviewFrame({
      data: fixture.data,
      width: fixture.width,
      height: fixture.height,
      graph,
    })
  }
  const exportRefusal = (params, lut) => {
    const graph = resolveExportColorGraph({
      ...Object.fromEntries(GRAPH_PARAM_KEYS.map((key) => [key, params[key]])),
      lut: lut ?? null,
    })
    return graph.supported ? null : graph.message
  }
  // Compose the reference the same way the preview presents view modes: the
  // technical base on the left of the split, the edited image on the right.
  const referenceFrame = (fixture, params, lut) => {
    const viewMode = params.viewMode ?? 'processed'
    if (viewMode === 'original')
      return renderReference(fixture, params, lut, 'technical-base')
    const edited = renderReference(fixture, params, lut, 'edited')
    if (viewMode !== 'compare') return edited
    const base = renderReference(fixture, params, lut, 'technical-base')
    const split = Math.min(Math.max(params.compareSplit ?? 0.5, 0), 1)
    const frame = new Uint8ClampedArray(edited)
    for (let y = 0; y < fixture.height; y++)
      for (let x = 0; x < fixture.width; x++) {
        if ((x + 0.5) / fixture.width >= split) continue
        const offset = (y * fixture.width + x) * 4
        frame.set(base.subarray(offset, offset + 4), offset)
      }
    return frame
  }

  let canvasSequence = 0
  const createPipeline = async (width, height) => {
    const canvas = document.createElement('canvas')
    canvas.dataset.validationId = String(canvasSequence++)
    canvas.width = width
    canvas.height = height
    document.body.append(canvas)
    const pipeline = new WebGPUProcessingPipeline(canvas)
    try {
      await pipeline.initialize()
    } catch (error) {
      pipeline.dispose()
      canvas.remove()
      throw error
    }
    pipeline.onLost((error) =>
      add('webgpu-device-loss', false, { error: String(error) }),
    )
    return {
      pipeline,
      canvas,
      dispose() {
        pipeline.dispose()
        canvas.remove()
      },
    }
  }
  const surface = await createPipeline(97, 65)
  const gpu = surface.pipeline
  const neutral = {
    ...gpu.getParams(),
    viewMode: 'processed',
    styleKind: 'none',
    intensity: 1,
    selectiveColor: undefined,
  }
  const reset = (fixture, params = {}) => {
    gpu.clearLUT()
    gpu.uploadImage(fixture)
    gpu.setParams({ ...neutral, ...params })
    return { ...neutral, ...params }
  }
  const render = async () => {
    gpu.render()
    await gpu.waitForGpu()
  }
  const readProcessedBytes = async () => {
    const pixels = await gpu.readProcessedPixelsAsync()
    if (!pixels) throw new Error('PROCESSED_PIXELS_MISSING')
    return toDisplayBytes(pixels)
  }
  try {
    report.capabilities = gpu.getCapabilities()
    add(
      'requested-lut-filtering-mode',
      !unfilterable || !report.capabilities.float32Filterable,
      {
        unfilterableRequested: unfilterable,
        float32FilteringEnabled: report.capabilities.float32Filterable,
      },
    )
    for (const integer of [false, true]) {
      const format = integer ? 'u16' : 'float'
      const fixture = makeImage(integer)
      for (const scenario of scenarios(Object.keys(TRANSFER_FUNCTIONS))) {
        const name = `${format}/${scenario.name}`
        try {
          const params = reset(fixture, scenario.params)
          if (scenario.lut) gpu.uploadLUT(scenario.lut)
          await render()
          const processed = await readProcessedBytes()
          // Presentation must show exactly what the process pass produced.
          check(
            `${name}/presented`,
            await readPresentedCanvas(surface.canvas),
            processed,
            PRESENTED,
          )
          // The linear ProPhoto RAW path must agree with the export executor.
          // The display-sRGB float path feeds embedded/quick previews only, and
          // built-in styles and some LUT output contracts are refused by export
          // (it fails closed); those have no export counterpart to match.
          const exportable = integer && exportRefusal(params, scenario.lut) === null
          if (exportable)
            check(
              `${name}/reference`,
              processed,
              referenceFrame(fixture, params, scenario.lut),
              REFERENCE,
            )
          else if (integer)
            add(`${name}/reference`, true, {
              skipped: exportRefusal(params, scenario.lut),
            })
        } catch (error) {
          add(name, false, { error: String(error), stack: error.stack })
          if (
            /PIPELINE_UNAVAILABLE|DEVICE_LOST|Instance reference/.test(
              String(error),
            )
          )
            throw error
        }
      }
      const snapshotParams = {
        userExposureEv: 0.35,
        userTemperature: 30,
        userSaturation: 20,
        viewMode: 'compare',
        compareSplit: 0.27,
      }
      try {
        const params = reset(fixture, snapshotParams)
        await render()
        const presentedBefore = await readPresentedCanvas(surface.canvas)
        const full = readCanvas(
          await gpu.renderToHiddenCanvas({ width: 97, height: 65 }),
        )
        // Snapshots export the edited image, never the compare composite.
        if (integer)
          check(
            `${format}/snapshot-full`,
            full,
            referenceFrame(fixture, { ...params, viewMode: 'processed' }),
            REFERENCE,
            { stats: gpu.getLastExportStats() },
          )
        const resized = await gpu.renderToHiddenCanvas({
          width: 43,
          height: 29,
        })
        add(
          `${format}/snapshot-resized-dimensions`,
          resized.width === 43 && resized.height === 29,
          { width: resized.width, height: resized.height },
        )
        await render()
        check(
          `${format}/compare-restored-after-snapshot`,
          await readPresentedCanvas(surface.canvas),
          presentedBefore,
          PRESENTED,
        )
      } catch (error) {
        add(`${format}/snapshot`, false, {
          error: String(error),
          stack: error.stack,
        })
      }
    }
    const tiledFixture = makeImage(true, 513, 289)
    const tiledParams = reset(tiledFixture, {
      userSaturation: 35,
      userShadows: 25,
    })
    try {
      const actual = await gpu.renderToHiddenCanvas({
        width: tiledFixture.width,
        height: tiledFixture.height,
        exportOptions: { memoryBudgetBytes: 256 * 256 * 32 },
      })
      const stats = gpu.getLastExportStats()
      check(
        'u16/snapshot-tiled',
        readCanvas(actual),
        referenceFrame(tiledFixture, tiledParams),
        REFERENCE,
        { stats },
      )
      add(
        'snapshot-tiled-strategy',
        stats.strategy === 'tiled' && stats.tileCount > 1,
        { stats },
      )
    } catch (error) {
      add('snapshot-tiled', false, { error: String(error), stack: error.stack })
    }
    gpu.clearImage()
    add('clear-image-dimensions', gpu.getInputDimensions().width === 0, {})
    add(
      'clear-image-readback',
      (await gpu.readProcessedPixelsAsync()) === null,
      {},
    )
    let clearedExportError
    try {
      await gpu.renderToHiddenCanvas({ width: 16, height: 16 })
    } catch (caught) {
      clearedExportError = String(caught)
    }
    add(
      'clear-image-export-refused',
      clearedExportError?.includes('EXPORT_SOURCE_MISSING') === true,
      { error: clearedExportError },
    )
    const reuploadFixture = makeImage(true)
    const reuploadParams = reset(reuploadFixture, { userExposureEv: -0.2 })
    await render()
    check(
      'clear-and-reupload',
      await readProcessedBytes(),
      referenceFrame(reuploadFixture, reuploadParams),
      REFERENCE,
    )

    const burstFixture = makeImage(true)
    const burstBase = reset(burstFixture)
    await render()
    const beforeBurst = gpu.getResourceStats()
    let latestTone
    for (let index = 0; index < 200; index++) {
      latestTone = {
        userExposureEv: Math.sin(index * 0.123) * 1.2,
        userContrast: (index % 61) - 30,
      }
      gpu.setParams(latestTone)
      gpu.render()
    }
    await gpu.waitForGpu()
    const afterBurst = gpu.getResourceStats()
    check(
      'tone-edit-burst-latest-state',
      await readProcessedBytes(),
      referenceFrame(burstFixture, { ...burstBase, ...latestTone }),
      REFERENCE,
      { edits: 200, latestTone },
    )
    add(
      'tone-edit-burst-bounded-frames',
      afterBurst.frames?.maxInFlight <= 2 &&
        afterBurst.frames?.inFlight === 0 &&
        afterBurst.frames.coalesced > beforeBurst.frames.coalesced,
      { before: beforeBurst.frames, after: afterBurst.frames },
    )
    add(
      'tone-edit-burst-resource-reuse',
      beforeBurst.textureAllocations === afterBurst.textureAllocations &&
        beforeBurst.uploadedBytes === afterBurst.uploadedBytes &&
        beforeBurst.estimatedBytes === afterBurst.estimatedBytes,
      { before: beforeBurst, after: afterBurst },
    )

    for (const action of ['clear', 'replace']) {
      reset(makeImage(true))
      await render()
      gpu.setParams({ userExposureEv: 0.6 })
      gpu.render()
      const pending = gpu.readProcessedPixelsAsync().then(
        (pixels) => ({ resolved: true, length: pixels?.length }),
        (error) => ({ resolved: false, error: String(error) }),
      )
      if (action === 'clear') gpu.clearImage()
      else gpu.uploadImage(makeImage(true, 83, 57))
      const outcome = await pending
      add(
        `pending-readback-${action}-cancelled`,
        !outcome.resolved && outcome.error?.includes('GPU_READBACK_CANCELLED'),
        { outcome },
      )
    }

    const survivorFixture = makeImage(true)
    const survivorParams = reset(survivorFixture, { userExposureEv: 0.25 })
    await render()
    const victimCanvas = document.createElement('canvas')
    victimCanvas.width = 97
    victimCanvas.height = 65
    const victim = new WebGPUProcessingPipeline(victimCanvas)
    try {
      // The surviving pipeline retains another device lease throughout this disposal.
      await victim.initialize()
      victim.uploadImage(makeImage(true))
      victim.setParams(neutral)
      victim.render()
      await victim.waitForGpu()
      const idle = victim.getResourceStats()
      const pending = victim
        .renderToHiddenCanvas({ width: 97, height: 65 })
        .then(
          () => ({ resolved: true }),
          (error) => ({ resolved: false, error: String(error) }),
        )
      const allocated = victim.getResourceStats()
      victim.dispose()
      const disposed = victim.getResourceStats()
      const outcome = await pending
      const settled = victim.getResourceStats()
      add(
        'pending-snapshot-disposal',
        allocated.estimatedBytes > idle.estimatedBytes &&
          !outcome.resolved &&
          /GPU_READBACK_CANCELLED|AbortError/i.test(outcome.error ?? '') &&
          disposed.estimatedBytes === 0 &&
          settled.estimatedBytes === 0,
        { idle, allocated, disposed, settled, outcome },
      )
      gpu.setParams({ userExposureEv: -0.35 })
      await render()
      check(
        'snapshot-disposal-preserves-other-pipeline',
        await readProcessedBytes(),
        referenceFrame(survivorFixture, {
          ...survivorParams,
          userExposureEv: -0.35,
        }),
        REFERENCE,
      )
    } finally {
      victim.dispose()
    }
  } finally {
    surface.dispose()
  }

  report.performance = await runPerformance({
    createPipeline,
    neutral,
    add,
    iterations,
    info,
    reference: (fixture, params) => referenceFrame(fixture, params),
    readProcessedBytes: async (pipeline) => {
      const pixels = await pipeline.readProcessedPixelsAsync()
      if (!pixels) throw new Error('PROCESSED_PIXELS_MISSING')
      return toDisplayBytes(pixels)
    },
    check: (name, actual, expected) => check(name, actual, expected, REFERENCE),
  })

  return report
}

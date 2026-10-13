import {
  ADJUSTED_USER_COLOR,
  base64ToBytes,
  LIMITS,
  makeImage,
  makeLut,
  pixelDiff,
  readCanvas,
  readPresentedCanvas,
  scenarios,
  subsampleRgb,
  toDisplayBytes,
} from './fixtures.mjs'
import { runPerformance } from './performance.mjs'

export async function runAcceptance({ iterations, unfilterable, goldens }) {
  const {
    COLOR_GRAPH_INTENT_KEYS,
    TRANSFER_FUNCTIONS,
    resolveExportColorGraph,
  } = await import('@lumaforge/luma-color-runtime')
  // Params the authoritative color graph consumes. The view mode only selects
  // which of the two frames below the preview presents.
  const graphParams = (params) =>
    Object.fromEntries(COLOR_GRAPH_INTENT_KEYS.map((key) => [key, params[key]]))
  const { renderCpuPreviewFrame } =
    await import('../../packages/render-engine/src/preview/preview-render.ts')
  const { WebGPUProcessingPipeline } =
    await import('../../src/lib/webgpu/pipeline.ts')
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
    goldens: goldens?.source ?? null,
    limits: LIMITS,
    tests: [],
    // Scenarios with neither an export counterpart nor a WebGL golden.
    uncovered: [],
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
  const GOLDEN = { max: LIMITS.goldenMaxByteError, mean: LIMITS.goldenMeanByteError }
  const checkGolden = (name, processed, width, height) => {
    const frame = goldens?.frames?.[name]
    if (!frame) return false
    const actual = subsampleRgb(processed, width, height, goldens.stride)
    const diff = pixelDiff(actual, base64ToBytes(frame), 3)
    add(
      `${name}/webgl-golden`,
      diff.nonfinite === 0 && diff.max <= GOLDEN.max && diff.mean <= GOLDEN.mean,
      { diff },
    )
    return true
  }

  const NO_LOOK = { styleKind: 'none', builtinPreset: null, intensity: 0 }
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
        ? { ...NO_LOOK, lut: null, rawRenderExposure }
        : variant === 'stripped'
          ? // The look removed; user color and RAW render exposure kept.
            { ...graphParams(params), ...NO_LOOK, lut: null, rawRenderExposure }
          : {
              ...graphParams(params),
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
      ...graphParams(params),
      lut: lut ?? null,
    })
    return graph.supported ? null : graph.message
  }
  // The preview presents either the technical base or the edited image.
  const referenceFrame = (fixture, params, lut) =>
    renderReference(
      fixture,
      params,
      lut,
      params.output === 'technical-original' ? 'technical-base' : 'edited',
    )

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
    output: 'processed',
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
    const fixture = makeImage()
    for (const scenario of scenarios(Object.keys(TRANSFER_FUNCTIONS))) {
      const name = `u16/${scenario.name}`
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
        const refusal = exportRefusal(params, scenario.lut)
        if (scenario.exportRefused) {
          // Export keeps refusing the custom LUT the preview leaves out.
          add(`${name}/export-refused`, refusal !== null, { refusal })
          // The preview drops only the look: it must equal the same scene
          // drawn with no look, and the TS executor's graph with the look
          // stripped.
          reset(fixture, { ...params, ...NO_LOOK })
          await render()
          check(
            `${name}/stripped-preview`,
            processed,
            await readProcessedBytes(),
            PRESENTED,
          )
          check(
            `${name}/stripped-reference`,
            processed,
            renderReference(fixture, params, null, 'stripped'),
            REFERENCE,
          )
        } else if (refusal === null)
          // The linear ProPhoto RAW path must agree with the export executor.
          check(
            `${name}/reference`,
            processed,
            referenceFrame(fixture, params, scenario.lut),
            REFERENCE,
          )
        // Built-in styles have no TS executor; they hold to goldens.
        else if (!checkGolden(name, processed, fixture.width, fixture.height))
          report.uncovered.push({ name, reason: refusal })
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
      output: 'technical-original',
    }
    try {
      const params = reset(fixture, snapshotParams)
      await render()
      const presentedBefore = await readPresentedCanvas(surface.canvas)
      const full = readCanvas(
        await gpu.renderToHiddenCanvas({ width: 97, height: 65 }),
      )
      // Snapshots export the edited image whichever output is presented.
      check(
        'u16/snapshot-full',
        full,
        referenceFrame(fixture, { ...params, output: 'processed' }),
        REFERENCE,
        { plan: gpu.getLastSnapshotPlan() },
      )
      const resized = await gpu.renderToHiddenCanvas({
        width: 43,
        height: 29,
      })
      add(
        'u16/snapshot-resized-dimensions',
        resized.width === 43 && resized.height === 29,
        { width: resized.width, height: resized.height },
      )
      await render()
      check(
        'u16/presented-restored-after-snapshot',
        await readPresentedCanvas(surface.canvas),
        presentedBefore,
        PRESENTED,
      )
    } catch (error) {
      add('u16/snapshot', false, {
        error: String(error),
        stack: error.stack,
      })
    }
    // A failed LUT upload leaves the pipeline without a LUT: the custom
    // selection then draws no look over the adjusted image.
    const failedLutFixture = makeImage()
    const failedLutParams = reset(failedLutFixture, {
      ...ADJUSTED_USER_COLOR,
      styleKind: 'custom',
      intensity: 0.66,
    })
    gpu.uploadLUT(makeLut())
    const brokenLut = makeLut()
    brokenLut.data = brokenLut.data.subarray(3)
    let lutUploadError
    try {
      gpu.uploadLUT(brokenLut)
    } catch (caught) {
      lutUploadError = String(caught)
    }
    add(
      'lut-upload-failure-refused',
      lutUploadError?.includes('GPU_LUT_LAYOUT_INVALID') === true,
      { error: lutUploadError },
    )
    await render()
    check(
      'lut-upload-failure-stripped-reference',
      await readProcessedBytes(),
      renderReference(failedLutFixture, failedLutParams, null, 'stripped'),
      REFERENCE,
    )
    add('lut-upload-failure-dropped-lut', gpu.getLutData() === null, {})
    await gpu.waitForGpu()

    const tiledFixture = makeImage(513, 289)
    const tiledParams = reset(tiledFixture, {
      userSaturation: 35,
      userShadows: 25,
    })
    try {
      const actual = await gpu.renderToHiddenCanvas({
        width: tiledFixture.width,
        height: tiledFixture.height,
        budgetBytes: 256 * 256 * 32,
      })
      const plan = gpu.getLastSnapshotPlan()
      check(
        'u16/snapshot-tiled',
        readCanvas(actual),
        referenceFrame(tiledFixture, tiledParams),
        REFERENCE,
        { plan },
      )
      add(
        'snapshot-tiled-strategy',
        plan.strategy === 'tiled' && plan.tileCount > 1,
        { plan },
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
    const reuploadFixture = makeImage()
    const reuploadParams = reset(reuploadFixture, { userExposureEv: -0.2 })
    await render()
    check(
      'clear-and-reupload',
      await readProcessedBytes(),
      referenceFrame(reuploadFixture, reuploadParams),
      REFERENCE,
    )

    const burstFixture = makeImage()
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
      reset(makeImage())
      await render()
      gpu.setParams({ userExposureEv: 0.6 })
      gpu.render()
      const pending = gpu.readProcessedPixelsAsync().then(
        (pixels) => ({ resolved: true, length: pixels?.length }),
        (error) => ({ resolved: false, error: String(error) }),
      )
      if (action === 'clear') gpu.clearImage()
      else gpu.uploadImage(makeImage(83, 57))
      const outcome = await pending
      add(
        `pending-readback-${action}-cancelled`,
        !outcome.resolved && outcome.error?.includes('GPU_READBACK_CANCELLED'),
        { outcome },
      )
    }

    const survivorFixture = makeImage()
    const survivorParams = reset(survivorFixture, { userExposureEv: 0.25 })
    await render()
    const victimCanvas = document.createElement('canvas')
    victimCanvas.width = 97
    victimCanvas.height = 65
    const victim = new WebGPUProcessingPipeline(victimCanvas)
    try {
      // The surviving pipeline retains another device lease throughout this disposal.
      await victim.initialize()
      victim.uploadImage(makeImage())
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

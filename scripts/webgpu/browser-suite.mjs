import {
  LIMITS,
  makeImage,
  pixelDiff,
  readCanvas,
  readPresentedCanvas,
  scenarios,
} from './fixtures.mjs'
import { runPerformance } from './performance.mjs'

export async function runAcceptance({ iterations, unfilterable }) {
  const { TRANSFER_FUNCTIONS } = await import('@lumaforge/luma-color-runtime')
  const { WebGPUProcessingPipeline } =
    await import('/src/lib/webgpu/pipeline.ts')
  const { RawProcessingPipeline } =
    await import('/src/lib/gl/webgl-pipeline.ts')
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
    limits: LIMITS,
    tests: [],
    performance: {},
  }
  window.__webgpuValidationReport = report
  const add = (name, passed, evidence) =>
    report.tests.push({ name, passed, ...evidence })
  const byteCheck = (name, actual, expected, extra = {}) => {
    const diff = pixelDiff(actual, expected)
    add(
      name,
      diff.nonfinite === 0 &&
        diff.max <= LIMITS.maxByteError &&
        diff.mean <= LIMITS.meanByteError,
      { diff, ...extra },
    )
  }
  let canvasSequence = 0
  const makePair = async (width, height) => {
    const glCanvas = document.createElement('canvas')
    const gpuCanvas = document.createElement('canvas')
    for (const canvas of [glCanvas, gpuCanvas]) {
      canvas.dataset.validationId = String(canvasSequence++)
      canvas.width = width
      canvas.height = height
      document.body.append(canvas)
    }
    const gl = new RawProcessingPipeline(glCanvas)
    const gpu = new WebGPUProcessingPipeline(gpuCanvas)
    try {
      await gl.initialize()
      await gpu.initialize()
    } catch (error) {
      gl.dispose({ releaseContext: true })
      gpu.dispose()
      throw error
    }
    gpu.onLost((error) =>
      add('webgpu-device-loss', false, { error: String(error) }),
    )
    return {
      gl,
      gpu,
      glCanvas,
      gpuCanvas,
      dispose() {
        gl.dispose({ releaseContext: true })
        gpu.dispose()
        glCanvas.remove()
        gpuCanvas.remove()
      },
    }
  }
  const pair = await makePair(97, 65)
  const neutral = {
    ...pair.gl.getParams(),
    viewMode: 'processed',
    styleKind: 'none',
    intensity: 1,
    selectiveColor: undefined,
  }
  const reset = (fixture, params = {}) => {
    for (const pipeline of [pair.gl, pair.gpu]) {
      pipeline.clearLUT()
      pipeline.uploadImage(fixture)
      pipeline.setParams({ ...neutral, ...params })
    }
  }
  const render = async () => {
    pair.gl.render({ waitForGpu: true })
    pair.gpu.render({ waitForGpu: false })
    await pair.gpu.waitForGpu()
  }
  try {
    report.capabilities = {
      webgl: pair.gl.getCapabilities(),
      webgpu: pair.gpu.getCapabilities(),
    }
    add(
      'requested-lut-filtering-mode',
      !unfilterable || !report.capabilities.webgpu.floatTexturesLinear,
      {
        unfilterableRequested: unfilterable,
        float32FilteringEnabled: report.capabilities.webgpu.floatTexturesLinear,
      },
    )
    for (const integer of [false, true]) {
      const fixture = makeImage(integer)
      for (const scenario of scenarios(Object.keys(TRANSFER_FUNCTIONS))) {
        const name = `${integer ? 'u16' : 'float'}/${scenario.name}`
        try {
          reset(fixture, scenario.params)
          if (scenario.lut) {
            pair.gl.uploadLUT(scenario.lut)
            pair.gpu.uploadLUT(scenario.lut)
          }
          await render()
          // Validate the presented image through compositor screenshots.
          // Snapshot tests independently validate durable pixel output.
          byteCheck(
            `${name}/visible`,
            await readPresentedCanvas(pair.gpuCanvas),
            await readPresentedCanvas(pair.glCanvas),
          )
          const glPixels = pair.gl.readProcessedPixels()
          const gpuPixels = await pair.gpu.readProcessedPixelsAsync()
          if (!glPixels || !gpuPixels)
            throw new Error('PROCESSED_PIXELS_MISSING')
          const diff = pixelDiff(gpuPixels, glPixels)
          add(
            `${name}/processed`,
            diff.nonfinite === 0 && diff.max <= LIMITS.maxFloatError,
            { diff },
          )
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
      for (const [label, width, height] of [
        ['full', 97, 65],
        ['resized', 43, 29],
      ]) {
        reset(fixture, {
          userExposureEv: 0.35,
          styleKind: 'builtin',
          builtinPreset: 'warm',
          intensity: 0.8,
          viewMode: 'compare',
          compareSplit: 0.27,
        })
        try {
          const actual = await pair.gpu.renderToHiddenCanvas({ width, height })
          const expected = await pair.gl.renderToHiddenCanvas({ width, height })
          byteCheck(
            `${integer ? 'u16' : 'float'}/snapshot-${label}`,
            readCanvas(actual),
            readCanvas(expected),
            {
              gpuStats: pair.gpu.getLastExportStats(),
              glStats: pair.gl.getLastExportStats(),
            },
          )
          await render()
          byteCheck(
            `${integer ? 'u16' : 'float'}/compare-restored-${label}`,
            await readPresentedCanvas(pair.gpuCanvas),
            await readPresentedCanvas(pair.glCanvas),
          )
        } catch (error) {
          add(`snapshot-${label}`, false, {
            error: String(error),
            stack: error.stack,
          })
        }
      }
    }
    const fixture = makeImage(true, 513, 289)
    reset(fixture, { userSaturation: 35, userShadows: 25 })
    const exportOptions = { memoryBudgetBytes: 256 * 256 * 32 }
    try {
      const actual = await pair.gpu.renderToHiddenCanvas({
        width: fixture.width,
        height: fixture.height,
        exportOptions,
      })
      const expected = await pair.gl.renderToHiddenCanvas({
        width: fixture.width,
        height: fixture.height,
        exportOptions,
      })
      const gpuStats = pair.gpu.getLastExportStats()
      const glStats = pair.gl.getLastExportStats()
      byteCheck(
        'u16/snapshot-tiled',
        readCanvas(actual),
        readCanvas(expected),
        { gpuStats, glStats },
      )
      add(
        'snapshot-tiled-strategy',
        gpuStats.strategy === 'tiled' &&
          glStats.strategy === 'tiled' &&
          gpuStats.tileCount > 1,
        { gpuStats, glStats },
      )
    } catch (error) {
      add('snapshot-tiled', false, { error: String(error), stack: error.stack })
    }
    for (const pipeline of [pair.gl, pair.gpu]) pipeline.clearImage()
    add(
      'clear-image-dimensions',
      pair.gpu.getInputDimensions().width === 0 &&
        pair.gl.getInputDimensions().width === 0,
      {},
    )
    const cleared = await pair.gpu.readProcessedPixelsAsync()
    add('clear-image-readback', cleared === null, {})
    for (const [name, pipeline] of [
      ['webgl', pair.gl],
      ['webgpu', pair.gpu],
    ]) {
      let error
      try {
        await pipeline.renderToHiddenCanvas({ width: 16, height: 16 })
      } catch (caught) {
        error = String(caught)
      }
      add(
        `${name}/clear-image-export-refused`,
        error?.includes('EXPORT_SOURCE_MISSING') === true,
        { error },
      )
    }
    reset(makeImage(false), { userExposureEv: -0.2 })
    await render()
    byteCheck(
      'clear-and-reupload',
      await readPresentedCanvas(pair.gpuCanvas),
      await readPresentedCanvas(pair.glCanvas),
    )

    reset(makeImage(false))
    await render()
    const beforeBurst = pair.gpu.getResourceStats()
    let latestTone
    for (let index = 0; index < 200; index++) {
      latestTone = {
        userExposureEv: Math.sin(index * 0.123) * 1.2,
        userContrast: (index % 61) - 30,
      }
      pair.gpu.setParams(latestTone)
      pair.gpu.render({ waitForGpu: false })
    }
    pair.gl.setParams(latestTone)
    pair.gl.render({ waitForGpu: true })
    await pair.gpu.waitForGpu()
    const burstPixels = await pair.gpu.readProcessedPixelsAsync()
    if (!burstPixels) throw new Error('BURST_READBACK_MISSING')
    const burstDiff = pixelDiff(burstPixels, pair.gl.readProcessedPixels())
    const afterBurst = pair.gpu.getResourceStats()
    add(
      'tone-edit-burst-latest-state',
      burstDiff.nonfinite === 0 && burstDiff.max <= LIMITS.maxFloatError,
      {
        edits: 200,
        latestTone,
        diff: burstDiff,
      },
    )
    add(
      'tone-edit-burst-bounded-frames',
      afterBurst.frames?.maxInFlight <= 2 &&
        afterBurst.frames?.inFlight === 0 &&
        afterBurst.frames.coalesced > beforeBurst.frames.coalesced,
      {
        before: beforeBurst.frames,
        after: afterBurst.frames,
      },
    )
    add(
      'tone-edit-burst-resource-reuse',
      beforeBurst.textureAllocations === afterBurst.textureAllocations &&
        beforeBurst.uploadedBytes === afterBurst.uploadedBytes &&
        beforeBurst.estimatedBytes === afterBurst.estimatedBytes,
      {
        before: beforeBurst,
        after: afterBurst,
      },
    )

    for (const action of ['clear', 'replace']) {
      reset(makeImage(false))
      await render()
      pair.gpu.setParams({ userExposureEv: 0.6 })
      pair.gpu.render({ waitForGpu: false })
      const pending = pair.gpu.readProcessedPixelsAsync().then(
        (pixels) => ({ resolved: true, length: pixels?.length }),
        (error) => ({ resolved: false, error: String(error) }),
      )
      if (action === 'clear') pair.gpu.clearImage()
      else pair.gpu.uploadImage(makeImage(true, 83, 57))
      const outcome = await pending
      add(
        `pending-readback-${action}-cancelled`,
        !outcome.resolved && outcome.error?.includes('GPU_READBACK_CANCELLED'),
        { outcome },
      )
    }

    reset(makeImage(false), { userExposureEv: 0.25 })
    await render()
    const victimCanvas = document.createElement('canvas')
    victimCanvas.width = 97
    victimCanvas.height = 65
    const victim = new WebGPUProcessingPipeline(victimCanvas)
    try {
      // The main pair retains another lease throughout disposal of this instance.
      await victim.initialize()
      victim.uploadImage(makeImage(false))
      victim.setParams(neutral)
      victim.render({ waitForGpu: false })
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
        {
          idle,
          allocated,
          disposed,
          settled,
          outcome,
        },
      )
      pair.gpu.setParams({ userExposureEv: -0.35 })
      pair.gl.setParams({ userExposureEv: -0.35 })
      await render()
      const actual = await pair.gpu.readProcessedPixelsAsync()
      const diff = pixelDiff(actual, pair.gl.readProcessedPixels())
      add(
        'snapshot-disposal-preserves-other-pipeline',
        diff.nonfinite === 0 &&
          diff.max <= LIMITS.maxFloatError &&
          actual.some((value) => value > 0.05 && value < 0.95),
        { diff },
      )
    } finally {
      victim.dispose()
    }
  } finally {
    pair.dispose()
  }

  report.performance = await runPerformance(
    makePair,
    neutral,
    add,
    iterations,
    info,
  )

  return report
}

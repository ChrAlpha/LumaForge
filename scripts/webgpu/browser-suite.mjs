import {
  LIMITS,
  makeImage,
  pixelDiff,
  readCanvas,
  readPresentedCanvas,
  scenarios,
} from './fixtures.mjs'
import { runPerformance } from './performance.mjs'

export async function runAcceptance({ iterations }) {
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
    for (const integer of [false, true]) {
      const fixture = makeImage(integer)
      for (const scenario of scenarios()) {
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

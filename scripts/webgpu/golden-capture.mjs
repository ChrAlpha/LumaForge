import {
  bytesToBase64,
  GOLDEN_STRIDE,
  isGoldenScenario,
  makeImage,
  scenarios,
  subsampleRgb,
  toDisplayBytes,
} from './fixtures.mjs'

// Runs only against a checkout that still ships the WebGL2 renderer
// (e9ccf140 or earlier on feat/webgpu-migration). It records the WebGL output
// for scenarios that have no TS export counterpart.
export async function captureGoldens() {
  const { TRANSFER_FUNCTIONS } = await import('@lumaforge/luma-color-runtime')
  const { RawProcessingPipeline } =
    await import('/src/lib/gl/webgl-pipeline.ts')
  const width = 97
  const height = 65
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  document.body.append(canvas)
  const pipeline = new RawProcessingPipeline(canvas)
  await pipeline.initialize()
  const capabilities = pipeline.getCapabilities()
  const neutral = {
    ...pipeline.getParams(),
    viewMode: 'processed',
    styleKind: 'none',
    intensity: 1,
    selectiveColor: undefined,
  }
  const frames = {}
  try {
    for (const integer of [false, true]) {
      const fixture = makeImage(integer, width, height)
      for (const scenario of scenarios(Object.keys(TRANSFER_FUNCTIONS))) {
        const name = `${integer ? 'u16' : 'float'}/${scenario.name}`
        if (!isGoldenScenario(name)) continue
        pipeline.clearLUT()
        pipeline.uploadImage(fixture)
        pipeline.setParams({ ...neutral, ...scenario.params })
        if (scenario.lut) pipeline.uploadLUT(scenario.lut)
        pipeline.render({ waitForGpu: true })
        const pixels = pipeline.readProcessedPixels()
        if (!pixels) throw new Error(`GOLDEN_PIXELS_MISSING: ${name}`)
        frames[name] = bytesToBase64(
          subsampleRgb(toDisplayBytes(pixels), width, height),
        )
      }
    }
  } finally {
    pipeline.dispose({ releaseContext: true })
    canvas.remove()
  }
  return {
    renderer: 'webgl2',
    capabilities,
    stride: GOLDEN_STRIDE,
    width,
    height,
    frames,
  }
}

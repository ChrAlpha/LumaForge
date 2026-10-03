import { distribution, makeImage } from './fixtures.mjs'

export async function runPerformance({
  createPipeline,
  neutral,
  add,
  iterations,
  info,
  reference,
  readProcessedBytes,
  check,
}) {
  const surface = await createPipeline(1024, 768)
  const gpu = surface.pipeline
  try {
    const fixture = makeImage(true, 1024, 768)
    const base = { ...neutral, userTemperature: 25, userVibrance: 30 }
    gpu.uploadImage(fixture)
    gpu.setParams(base)
    let params = base
    for (let index = 0; index < 5; index++) {
      params = { ...params, userExposureEv: index / 100 }
      gpu.setParams(params)
      gpu.render({ waitForGpu: false })
      await gpu.waitForGpu()
    }
    const preflight = await readProcessedBytes(gpu)
    if (!preflight.some((value) => value > 12 && value < 243))
      throw new Error('PERFORMANCE_PIXELS_BLANK')
    const preflightDiff = check(
      'performance-preflight-pixels',
      preflight,
      reference(fixture, params),
    )
    if (preflightDiff.nonfinite > 0) throw new Error('PERFORMANCE_PIXELS_DIFFER')
    const resourcesBefore = gpu.getResourceStats()
    const timings = { submit: [], complete: [] }
    for (let index = 0; index < iterations; index++) {
      params = {
        ...params,
        userExposureEv: Math.sin(index * 0.3) * 0.5,
        userContrast: index % 25,
      }
      gpu.setParams(params)
      const start = performance.now()
      gpu.render({ waitForGpu: false })
      const submitted = performance.now()
      await gpu.waitForGpu()
      timings.submit.push(submitted - start)
      timings.complete.push(performance.now() - start)
    }
    check(
      'performance-final-pixels',
      await readProcessedBytes(gpu),
      reference(fixture, params),
    )
    const resourcesAfter = gpu.getResourceStats()
    add(
      'edit-resources-stable',
      resourcesBefore.textureAllocations === resourcesAfter.textureAllocations &&
        resourcesBefore.uploadedBytes === resourcesAfter.uploadedBytes,
      { before: resourcesBefore, after: resourcesAfter },
    )
    gpu.uploadImage(makeImage(true, 1024, 768))
    const reupload = gpu.getResourceStats()
    add(
      'same-size-upload-reuses-textures',
      reupload.textureAllocations === resourcesAfter.textureAllocations,
      { before: resourcesAfter, after: reupload },
    )
    gpu.render({ waitForGpu: false })
    await gpu.waitForGpu()
    const steady = gpu.getResourceStats()
    gpu.render({ waitForGpu: false })
    await gpu.waitForGpu()
    const unchanged = gpu.getResourceStats()
    add(
      'unchanged-render-skips-processing',
      steady.processDraws === unchanged.processDraws &&
        steady.uniformUploads === unchanged.uniformUploads,
      { before: steady, after: unchanged },
    )
    return {
      width: 1024,
      height: 768,
      warmups: 5,
      iterations,
      clock: 'performance.now',
      unit: 'milliseconds',
      completion: 'queue.onSubmittedWorkDone',
      software:
        info.isFallbackAdapter ||
        /swiftshader|software|llvmpipe/i.test(
          `${info.architecture} ${info.description}`,
        ),
      webgpu: {
        submit: distribution(timings.submit),
        complete: distribution(timings.complete),
      },
    }
  } finally {
    surface.dispose()
  }
}

import { distribution, LIMITS, makeImage, pixelDiff } from './fixtures.mjs'

export async function runPerformance(makePair, neutral, add, iterations, info) {
  const performancePair = await makePair(1024, 768)
  try {
    const fixture = makeImage(true, 1024, 768)
    for (const pipeline of [performancePair.gl, performancePair.gpu]) {
      pipeline.uploadImage(fixture)
      pipeline.setParams({
        ...neutral,
        styleKind: 'builtin',
        builtinPreset: 'warm',
      })
    }
    const glContext = performancePair.glCanvas.getContext('webgl2')
    const finish = async (name) => {
      if (name === 'webgpu') return performancePair.gpu.waitForGpu()
      if (glContext.isContextLost())
        throw new Error('PERFORMANCE_WEBGL_CONTEXT_LOST')
      glContext.finish()
      const error = glContext.getError()
      if (error !== glContext.NO_ERROR)
        throw new Error(`PERFORMANCE_WEBGL_ERROR: ${error}`)
    }
    for (let index = 0; index < 5; index++)
      for (const [name, pipeline] of [
        ['webgl', performancePair.gl],
        ['webgpu', performancePair.gpu],
      ]) {
        pipeline.setParams({ userExposureEv: index / 100 })
        pipeline.render({ waitForGpu: false })
        await finish(name)
      }
    const glPixels = performancePair.gl.readProcessedPixels()
    const gpuPixels = await performancePair.gpu.readProcessedPixelsAsync()
    if (
      !glPixels ||
      !gpuPixels ||
      !glPixels.some((value) => value > 0.05 && value < 0.95)
    )
      throw new Error('PERFORMANCE_PIXELS_MISSING_OR_BLANK')
    const preflight = pixelDiff(gpuPixels, glPixels)
    add(
      'performance-preflight-pixels',
      preflight.max <= LIMITS.maxFloatError && preflight.nonfinite === 0,
      { diff: preflight },
    )
    if (preflight.max > LIMITS.maxFloatError || preflight.nonfinite > 0)
      throw new Error('PERFORMANCE_PIXELS_DIFFER')
    const resourcesBefore = performancePair.gpu.getResourceStats()
    const timings = {
      webgl: { submit: [], complete: [] },
      webgpu: { submit: [], complete: [] },
    }
    // Alternate order to reduce bias from consistently running one backend first.
    for (let index = 0; index < iterations; index++) {
      const order = index % 2 ? ['webgpu', 'webgl'] : ['webgl', 'webgpu']
      for (const name of order) {
        const pipeline =
          name === 'webgpu' ? performancePair.gpu : performancePair.gl
        pipeline.setParams({
          userExposureEv: Math.sin(index * 0.3) * 0.5,
          userContrast: index % 25,
        })
        const start = performance.now()
        pipeline.render({ waitForGpu: false })
        const submitted = performance.now()
        await finish(name)
        timings[name].submit.push(submitted - start)
        timings[name].complete.push(performance.now() - start)
      }
    }
    const resourcesAfter = performancePair.gpu.getResourceStats()
    add(
      'edit-resources-stable',
      resourcesBefore.textureAllocations ===
        resourcesAfter.textureAllocations &&
        resourcesBefore.uploadedBytes === resourcesAfter.uploadedBytes,
      { before: resourcesBefore, after: resourcesAfter },
    )
    performancePair.gpu.uploadImage(makeImage(true, 1024, 768))
    const reupload = performancePair.gpu.getResourceStats()
    add(
      'same-size-upload-reuses-textures',
      reupload.textureAllocations === resourcesAfter.textureAllocations,
      { before: resourcesAfter, after: reupload },
    )
    performancePair.gpu.render({ waitForGpu: false })
    await finish('webgpu')
    const steady = performancePair.gpu.getResourceStats()
    performancePair.gpu.render({ waitForGpu: false })
    await finish('webgpu')
    const unchanged = performancePair.gpu.getResourceStats()
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
      completion: 'queue.onSubmittedWorkDone for WebGPU; gl.finish for WebGL',
      software:
        info.isFallbackAdapter ||
        /swiftshader|software|llvmpipe/i.test(
          `${info.architecture} ${info.description}`,
        ),
      webgl: {
        submit: distribution(timings.webgl.submit),
        complete: distribution(timings.webgl.complete),
      },
      webgpu: {
        submit: distribution(timings.webgpu.submit),
        complete: distribution(timings.webgpu.complete),
      },
    }
  } finally {
    performancePair.dispose()
  }
}

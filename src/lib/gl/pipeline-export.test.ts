import type { LUTData, ProcessingParams } from '@lumaforge/luma-color-runtime'
import { getLUTColorProfile } from '@lumaforge/luma-color-runtime'
import {
  LUT_ROLE_UNIFORMS,
  LUT_TRANSFER_UNIFORMS,
} from '@lumaforge/luma-color-runtime/glsl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RawUploadInput } from './pipeline'
import { RawProcessingPipeline } from './webgl-pipeline'

const contextMock = vi.hoisted(() => {
  const capabilities = {
    webgl2: true,
    maxTextureSize: 4096,
    max3DTextureSize: 256,
    floatTextures: true,
    floatTexturesLinear: true,
    halfFloatTextures: true,
    halfFloatTexturesLinear: true,
    colorBufferFloat: true,
    colorBufferHalfFloat: true,
    maxVertexUniformVectors: 1024,
    maxFragmentUniformVectors: 1024,
    maxVaryingVectors: 64,
    fragmentHighFloatPrecision: 23,
    fragmentHighFloatRangeMin: 127,
    fragmentHighFloatRangeMax: 127,
    toneHighPrecision: true,
    rendererInfo: 'Mock Renderer',
    vendorInfo: 'Mock Vendor',
  }

  const gl = {
    TEXTURE_2D: 3553,
    TEXTURE_3D: 32879,
    TEXTURE0: 33984,
    TEXTURE1: 33985,
    TEXTURE2: 33986,
    TEXTURE_MIN_FILTER: 10241,
    TEXTURE_MAG_FILTER: 10240,
    TEXTURE_WRAP_S: 10242,
    TEXTURE_WRAP_T: 10243,
    TEXTURE_WRAP_R: 32882,
    NEAREST: 9728,
    LINEAR: 9729,
    CLAMP_TO_EDGE: 33071,
    RGB8: 32849,
    RGB: 6407,
    RGBA: 6408,
    RGBA16F: 34842,
    RGBA32F: 34836,
    RGB16UI: 36215,
    RGB_INTEGER: 36248,
    UNSIGNED_BYTE: 5121,
    UNSIGNED_SHORT: 5123,
    HALF_FLOAT: 5131,
    FLOAT: 5126,
    FRAMEBUFFER: 36160,
    TRIANGLE_STRIP: 5,
    createTexture: vi.fn(() => ({})),
    bindTexture: vi.fn(),
    texParameteri: vi.fn(),
    texImage2D: vi.fn(),
    texImage3D: vi.fn(),
    texSubImage2D: vi.fn(),
    pixelStorei: vi.fn(),
    deleteTexture: vi.fn(),
    deleteFramebuffer: vi.fn(),
    deleteProgram: vi.fn(),
    deleteVertexArray: vi.fn(),
    deleteBuffer: vi.fn(),
    getUniformLocation: vi.fn((_program, name: string) => name),
    bindFramebuffer: vi.fn(),
    viewport: vi.fn(),
    useProgram: vi.fn(),
    activeTexture: vi.fn(),
    uniform1i: vi.fn(),
    uniform1f: vi.fn(),
    uniform2f: vi.fn(),
    uniform3f: vi.fn(),
    uniform3fv: vi.fn(),
    uniformMatrix3fv: vi.fn(),
    bindVertexArray: vi.fn(),
    drawArrays: vi.fn(),
    flush: vi.fn(),
    finish: vi.fn(),
    readPixels: vi.fn(),
    getExtension: vi.fn((name: string) =>
      name === 'WEBGL_lose_context' ? { loseContext: vi.fn() } : null,
    ),
  }
  const create3DTexture = vi.fn<() => WebGLTexture | null>(
    () => ({}) as WebGLTexture,
  )

  return {
    capabilities,
    create3DTexture,
    gl,
    reset() {
      for (const value of Object.values(gl)) {
        if (vi.isMockFunction(value)) value.mockClear()
      }
      create3DTexture.mockReset()
      create3DTexture.mockReturnValue({} as WebGLTexture)
      capabilities.maxTextureSize = 4096
    },
  }
})

vi.mock('./context', () => ({
  createWebGL2Context: vi.fn(() => contextMock.gl),
  detectCapabilities: vi.fn(() => contextMock.capabilities),
  selectProcessingTextureFormat: vi.fn((capabilities) =>
    capabilities.colorBufferHalfFloat && capabilities.halfFloatTexturesLinear
      ? { precision: 'rgba16f', warnings: [] }
      : {
          precision: 'rgba8',
          warnings: [
            {
              code: 'LOW_PRECISION_RENDER_TARGET',
              message:
                'High-quality GPU rendering is unavailable on this device; preview and export may show smoother tonal steps less accurately.',
            },
          ],
        },
  ),
  getProcessingTextureFormatWarnings: vi.fn((precision) =>
    precision === 'rgba8'
      ? [
          {
            code: 'LOW_PRECISION_RENDER_TARGET',
            message:
              'High-quality GPU rendering is unavailable on this device; preview and export may show smoother tonal steps less accurately.',
          },
        ]
      : [],
  ),
  getRecommendedTextureFormat: vi.fn((gl) => ({
    internalFormat: gl.RGBA32F,
    format: gl.RGBA,
    type: gl.FLOAT,
  })),
  createProgram: vi.fn(() => ({})),
  createFullscreenQuad: vi.fn(() => ({ vao: {}, vbo: {} })),
  createTextureFromData: vi.fn(() => ({})),
  createRgb16UiTextureFromData: vi.fn(() => ({})),
  create3DTexture: contextMock.create3DTexture,
  createFramebuffer: vi.fn(() => ({
    framebuffer: {},
    texture: {},
    textureFormat: { precision: 'rgba16f' },
  })),
}))

function createRawInput(width: number, height: number): RawUploadInput {
  return {
    data: new Uint16Array(width * height * 3),
    width,
    height,
    layout: 'rgb-u16',
    colorSpace: 'linear-prophoto-rgb',
    renderExposureEv: 0,
    renderExposureMultiplier: 1,
  }
}

function createLUTData(profileId = 'sony-sgamut3cine-slog3'): LUTData {
  const profile = getLUTColorProfile(profileId)
  if (!profile) throw new Error(`Missing profile ${profileId}`)

  return {
    size: 2,
    data: new Float32Array(2 * 2 * 2 * 3),
    domainMin: [0, 0, 0],
    domainMax: [1, 1, 1],
    inputProfile: 'display-srgb',
    profileResolution: {
      kind: 'confirmed',
      profile: {
        ...profile,
        outputGamut: profile.inputGamut,
        outputTransfer: profile.inputTransfer,
        outputRange: 'full',
      },
      confidence: 'user',
    },
  }
}

async function createSourcePipeline(input: RawUploadInput) {
  const pipeline = new RawProcessingPipeline(document.createElement('canvas'))
  await pipeline.initialize()
  pipeline.uploadImage(input)
  return pipeline
}

describe('rawProcessingPipeline export rendering', () => {
  let drawImage: ReturnType<typeof vi.fn>

  beforeEach(() => {
    contextMock.reset()
    drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((
      type: string,
    ) => {
      if (type === '2d') {
        return { drawImage } as unknown as CanvasRenderingContext2D
      }

      return null
    }) as HTMLCanvasElement['getContext'])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('preserves selected LUT profile resolution and processing params in hidden export renders', async () => {
    const pipeline = await createSourcePipeline(createRawInput(2, 2))
    const lutData = createLUTData()
    const params: ProcessingParams = {
      userExposureEv: 0,
      userContrast: 0,
      userHighlights: 0,
      userShadows: 0,
      userWhites: 0,
      userBlacks: 0,
      userTemperature: 0,
      userTint: 0,
      userSaturation: 0,
      userVibrance: 0,
      intensity: 0.42,
      viewMode: 'compare',
      compareSplit: 0.82,
      styleKind: 'custom',
      builtinPreset: null,
    }
    const exportSafeParams: ProcessingParams = {
      ...params,
      viewMode: 'processed',
      compareSplit: 0.5,
    }

    pipeline.uploadLUT(lutData)
    pipeline.setParams(params)

    const uploadLUTSpy = vi.spyOn(RawProcessingPipeline.prototype, 'uploadLUT')
    const setParamsSpy = vi.spyOn(RawProcessingPipeline.prototype, 'setParams')

    await pipeline.renderToHiddenCanvas({ width: 2, height: 2 })

    expect(uploadLUTSpy).toHaveBeenCalledWith(lutData)
    expect(setParamsSpy).toHaveBeenCalledWith(exportSafeParams)
    expect(contextMock.gl.uniform1i).toHaveBeenCalledWith(
      'u_lutInputTransfer',
      LUT_TRANSFER_UNIFORMS['s-log3'],
    )
    expect(contextMock.gl.uniform1f).toHaveBeenCalledWith('u_lutSize', 2)
    expect(contextMock.gl.uniform1i).toHaveBeenCalledWith(
      'u_lutRole',
      LUT_ROLE_UNIFORMS['scene-creative'],
    )
    expect(contextMock.gl.uniform1i).not.toHaveBeenCalledWith(
      'u_lutRole',
      LUT_ROLE_UNIFORMS['display-look'],
    )
  })

  it.each(['compare', 'original'] as const)(
    'forces processed view params for hidden full-frame export when preview is %s',
    async (viewMode) => {
      const pipeline = await createSourcePipeline(createRawInput(2, 2))
      const params: ProcessingParams = {
        userExposureEv: 0,
        userContrast: 0,
        userHighlights: 0,
        userShadows: 0,
        userWhites: 0,
        userBlacks: 0,
        userTemperature: 0,
        userTint: 0,
        userSaturation: 0,
        userVibrance: 0,
        intensity: 0.35,
        viewMode,
        compareSplit: 0.91,
        styleKind: 'builtin',
        builtinPreset: 'cinematic',
      }
      pipeline.setParams(params)
      const setParamsSpy = vi.spyOn(
        RawProcessingPipeline.prototype,
        'setParams',
      )

      await pipeline.renderToHiddenCanvas({ width: 2, height: 2 })

      expect(setParamsSpy).toHaveBeenCalledWith({
        userExposureEv: 0,
        userContrast: 0,
        userHighlights: 0,
        userShadows: 0,
        userWhites: 0,
        userBlacks: 0,
        userTemperature: 0,
        userTint: 0,
        userSaturation: 0,
        userVibrance: 0,
        intensity: 0.35,
        viewMode: 'processed',
        compareSplit: 0.5,
        styleKind: 'builtin',
        builtinPreset: 'cinematic',
      })
    },
  )

  it('reports transform-path and LUT upload telemetry in preview stats', async () => {
    const pipeline = await createSourcePipeline(createRawInput(2, 2))
    pipeline.uploadLUT(createLUTData('sony-sgamut3cine-slog3'))
    pipeline.setParams({
      intensity: 0.75,
      viewMode: 'processed',
      styleKind: 'custom',
      builtinPreset: null,
    })

    const stats = pipeline.render()

    expect(stats.inputFormat).toBe('uint16-rgb')
    expect(stats.transformPath).toBe('scene-creative-lut')
    expect(stats.lutRole).toBe('scene-creative')
    expect(stats.lutInputTransfer).toBe('s-log3')
    expect(stats.lutOutputTransfer).toBe('s-log3')
    expect(stats.lutSize).toBe(2)
    expect(stats.lutUploadTime).toBeGreaterThanOrEqual(0)
    expect(stats.processTargetPrecision).toBe('rgba16f')
    expect(stats.capabilityWarnings).toEqual([])
  })

  it('fails LUT upload when the GPU texture cannot be created', async () => {
    const pipeline = await createSourcePipeline(createRawInput(2, 2))
    contextMock.create3DTexture.mockReturnValueOnce(null)

    expect(() =>
      pipeline.uploadLUT(createLUTData('sony-sgamut3cine-slog3')),
    ).toThrow('Failed to create LUT texture')

    pipeline.setParams({
      intensity: 0.75,
      viewMode: 'processed',
      styleKind: 'custom',
      builtinPreset: null,
    })
    expect(pipeline.render().transformPath).toBe('no-lut')
  })

  it('disposes the hidden full-frame pipeline after export render', async () => {
    const pipeline = await createSourcePipeline(createRawInput(2, 2))
    const disposeSpy = vi.spyOn(RawProcessingPipeline.prototype, 'dispose')

    await pipeline.renderToHiddenCanvas({ width: 2, height: 2 })

    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })

  it('disposes the hidden full-frame pipeline after render failure', async () => {
    const pipeline = await createSourcePipeline(createRawInput(2, 2))
    const disposeSpy = vi.spyOn(RawProcessingPipeline.prototype, 'dispose')
    const renderSpy = vi
      .spyOn(RawProcessingPipeline.prototype, 'render')
      .mockImplementationOnce(() => {
        throw new Error('EXPORT_RENDER_FAILED')
      })

    await expect(
      pipeline.renderToHiddenCanvas({ width: 2, height: 2 }),
    ).rejects.toThrow('EXPORT_RENDER_FAILED')

    expect(renderSpy).toHaveBeenCalledTimes(1)
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })

  it('updates export telemetry for a failed hidden render attempt', async () => {
    const pipeline = await createSourcePipeline(createRawInput(2, 2))

    await pipeline.renderToHiddenCanvas({ width: 2, height: 2 })
    expect(pipeline.getLastExportStats()).toMatchObject({
      strategy: 'full-frame',
      width: 2,
      height: 2,
    })

    vi.spyOn(RawProcessingPipeline.prototype, 'render').mockImplementationOnce(
      () => {
        throw new Error('EXPORT_RENDER_FAILED')
      },
    )

    await expect(
      pipeline.renderToHiddenCanvas({ width: 2, height: 2 }),
    ).rejects.toThrow('EXPORT_RENDER_FAILED')

    expect(pipeline.getLastExportStats()).toMatchObject({
      strategy: 'fail',
      width: 2,
      height: 2,
      tileCount: 1,
      reason: 'render-failure',
      failureCode: 'EXPORT_RENDER_FAILED',
      inputFormat: 'uint16-rgb',
      transformPath: 'no-lut',
    })
    expect(pipeline.getLastExportStats()?.renderTime).toBeGreaterThanOrEqual(0)
    expect(pipeline.getLastExportStats()?.totalTime).toBeGreaterThanOrEqual(0)
  })

  it('renders oversized exports in cropped tiles and stitches them into one output canvas', async () => {
    contextMock.capabilities.maxTextureSize = 1024
    const pipeline = await createSourcePipeline(createRawInput(1500, 900))
    pipeline.setParams({
      intensity: 1,
      viewMode: 'processed',
      styleKind: 'none',
      builtinPreset: null,
    })

    const uploadImageSpy = vi.spyOn(
      RawProcessingPipeline.prototype,
      'uploadImage',
    )

    const canvas = await pipeline.renderToHiddenCanvas({
      width: 1500,
      height: 900,
    })

    expect(canvas.width).toBe(1500)
    expect(canvas.height).toBe(900)
    expect(drawImage).toHaveBeenCalledTimes(2)
    expect(uploadImageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1024, height: 900 }),
    )
    expect(uploadImageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ width: 476, height: 900 }),
    )
  })

  it('forces processed view params for tiled hidden export when preview is original', async () => {
    contextMock.capabilities.maxTextureSize = 1024
    const pipeline = await createSourcePipeline(createRawInput(1500, 900))
    pipeline.setParams({
      intensity: 0.6,
      viewMode: 'original',
      compareSplit: 0.12,
      styleKind: 'builtin',
      builtinPreset: 'warm',
    })
    const setParamsSpy = vi.spyOn(RawProcessingPipeline.prototype, 'setParams')

    await pipeline.renderToHiddenCanvas({
      width: 1500,
      height: 900,
    })

    expect(setParamsSpy).toHaveBeenCalledWith({
      userExposureEv: 0,
      userContrast: 0,
      userHighlights: 0,
      userShadows: 0,
      userWhites: 0,
      userBlacks: 0,
      userTemperature: 0,
      userTint: 0,
      userSaturation: 0,
      userVibrance: 0,
      intensity: 0.6,
      viewMode: 'processed',
      compareSplit: 0.5,
      styleKind: 'builtin',
      builtinPreset: 'warm',
    })
  })

  it('records export planning and tile render telemetry', async () => {
    contextMock.capabilities.maxTextureSize = 1024
    const pipeline = await createSourcePipeline(createRawInput(1500, 900))

    await pipeline.renderToHiddenCanvas({
      width: 1500,
      height: 900,
    })

    expect(pipeline.getLastExportStats()).toMatchObject({
      strategy: 'tiled',
      width: 1500,
      height: 900,
      tileCount: 2,
      inputFormat: 'uint16-rgb',
      transformPath: 'no-lut',
      processTargetPrecision: 'rgba16f',
    })
    expect(pipeline.getLastExportStats()?.planningTime).toBeGreaterThanOrEqual(
      0,
    )
    expect(pipeline.getLastExportStats()?.renderTime).toBeGreaterThanOrEqual(0)
    expect(pipeline.getLastExportStats()?.totalTime).toBeGreaterThanOrEqual(0)
  })

  it('reuses one hidden pipeline for every tile in an oversized export', async () => {
    contextMock.capabilities.maxTextureSize = 1024
    const pipeline = await createSourcePipeline(createRawInput(1500, 900))
    const initializeSpy = vi.spyOn(
      RawProcessingPipeline.prototype,
      'initialize',
    )
    const disposeSpy = vi.spyOn(RawProcessingPipeline.prototype, 'dispose')

    await pipeline.renderToHiddenCanvas({
      width: 1500,
      height: 900,
    })

    expect(drawImage).toHaveBeenCalledTimes(2)
    expect(initializeSpy).toHaveBeenCalledTimes(1)
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })

  it('preserves retryable export fit errors from planning failures', async () => {
    const pipeline = await createSourcePipeline(createRawInput(1500, 900))

    await expect(
      pipeline.renderToHiddenCanvas({
        width: 1500,
        height: 900,
        exportOptions: {
          maxCanvasSize: 1024,
          maxCanvasPixels: 1024 * 1024,
          memoryBudgetBytes: 768 * 1024 * 1024,
        },
      }),
    ).rejects.toMatchObject({
      code: 'EXPORT_CANVAS_LIMIT_EXCEEDED',
      retryable: true,
      width: 1500,
      height: 900,
    })
  })

  it('uses caller-provided planning options instead of static defaults', async () => {
    contextMock.capabilities.maxTextureSize = 4096
    const pipeline = await createSourcePipeline(createRawInput(1500, 900))

    const canvas = await pipeline.renderToHiddenCanvas({
      width: 1500,
      height: 900,
      exportOptions: {
        maxCanvasSize: 4096,
        maxCanvasPixels: 2_000_000,
        memoryBudgetBytes: 16 * 1024 * 1024,
      },
    })

    expect(canvas.width).toBe(1500)
    expect(canvas.height).toBe(900)
    expect(drawImage).toHaveBeenCalledTimes(6)
  })
})

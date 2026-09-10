/**
 * RAW image processing pipeline using WebGL2.
 * Handles the complete flow from decoded RAW data to display/export.
 */

import type {
  BuiltinStylePreset,
  LumaColorSelectiveColorParams,
  LUTColorProfile,
  LUTContractResolution,
  LUTData,
  LUTRole,
  ProcessingParams,
  TransferFunctionId,
} from '@lumaforge/luma-color-runtime'
import {
  CHROMA_CLAMP_HIGH,
  CHROMA_CLAMP_LOW,
  getLinearProPhotoToGamutMatrix,
  getLUTOutputToTargetMatrix,
  LUT_SIZE as SELECTIVE_COLOR_LUT_SIZE,
  mat3Identity,
  mat3ToGLSL,
  normalizeSelectiveColorParams,
  resolveColorBalanceParams,
  resolveExportColorGraph,
  resolveSelectiveColorParams,
  resolveToneParams,
} from '@lumaforge/luma-color-runtime'
import {
  LUT_RANGE_UNIFORMS,
  LUT_ROLE_UNIFORMS,
  LUT_TRANSFER_UNIFORMS,
} from '@lumaforge/luma-color-runtime/glsl'

import type {
  PipelineCapabilityWarning,
  ProcessTargetPrecision,
  WebGLCapabilities,
} from './context'
import {
  create3DTexture,
  createFramebuffer,
  createFullscreenQuad,
  createProgram,
  createRgb16UiTextureFromData,
  createTextureFromData,
  createWebGL2Context,
  detectCapabilities,
  getProcessingTextureFormatWarnings,
  getRecommendedTextureFormat,
  selectProcessingTextureFormat,
} from './context'
import type { ExportRenderOptions } from './export'
import {
  createExportTiles,
  cropRawUploadInput,
  ExportRenderError,
  planExportRenderTarget,
} from './export'
import {
  PREVIEW_OUTPUT_SHADER,
  PROCESS_FRAGMENT_SHADER_FLOAT,
  PROCESS_FRAGMENT_SHADER_U16,
  VERTEX_SHADER,
} from './shaders'

export type {
  BuiltinStylePreset,
  LUTContractResolution,
  LUTData,
  LUTInputProfile,
  ProcessingParams,
} from '@lumaforge/luma-color-runtime'
export {
  LUT_RANGE_UNIFORMS,
  LUT_ROLE_UNIFORMS,
  LUT_TRANSFER_UNIFORMS,
} from '@lumaforge/luma-color-runtime/glsl'

export interface PipelineStats {
  uploadTime: number
  lutUploadTime: number
  processTime: number
  totalTime: number
  inputSize: { width: number; height: number }
  previewSize: { width: number; height: number }
  inputFormat: RawUploadInputFormat
  transformPath: PipelineTransformPath
  lutRole: LUTRole | null
  lutInputTransfer: TransferFunctionId | null
  lutOutputTransfer: TransferFunctionId | null
  lutSize: number | null
  processTargetPrecision: ProcessTargetPrecision
  capabilityWarnings: PipelineCapabilityWarning[]
}

export interface RenderOptions {
  waitForGpu?: boolean
}

export type RawUploadInput =
  | {
      data: Float32Array
      width: number
      height: number
      layout: 'rgba-float32'
      colorSpace: 'display-srgb-preview'
    }
  | {
      data: Uint16Array
      width: number
      height: number
      layout: 'rgb-u16'
      colorSpace: 'linear-prophoto-rgb'
      renderExposureEv: number
      renderExposureMultiplier: number
    }

export type RawUploadInputFormat = 'float-rgba' | 'uint16-rgb'

export type PipelineTransformPath =
  | 'no-lut'
  | 'builtin-style'
  | 'display-lut'
  | 'scene-creative-lut'
  | 'combined-output-lut'
  | 'technical-output-lut'
  | 'disabled-lut'

export interface PipelineTelemetrySnapshot {
  inputFormat: RawUploadInputFormat
  transformPath: PipelineTransformPath
  lutRole: LUTRole | null
  lutInputTransfer: TransferFunctionId | null
  lutOutputTransfer: TransferFunctionId | null
  lutSize: number | null
  processTargetPrecision: ProcessTargetPrecision
  capabilityWarnings: PipelineCapabilityWarning[]
}

export interface ExportRenderStats extends PipelineTelemetrySnapshot {
  strategy: 'full-frame' | 'tiled' | 'fail'
  width: number
  height: number
  tileCount: number
  planningTime: number
  renderTime: number
  totalTime: number
  reason?:
    | 'texture-limit'
    | 'memory-budget'
    | 'canvas-limit'
    | 'gpu-limit'
    | 'render-failure'
  failureCode?: string
  failureMessage?: string
  retryable?: boolean
}

export function describeRawUploadInput(input: RawUploadInput): {
  inputFormat: RawUploadInputFormat
  channelCount: 3 | 4
  bytesPerPixel: 6 | 16
} {
  if (input.layout === 'rgb-u16') {
    return {
      inputFormat: 'uint16-rgb',
      channelCount: 3,
      bytesPerPixel: 6,
    }
  }

  return {
    inputFormat: 'float-rgba',
    channelCount: 4,
    bytesPerPixel: 16,
  }
}

// Returns true when at least one band scalar is non-zero. The shader bypass
// uses this to skip the OKLab roundtrip and keep WebGL bit-identical with the
// CPU export's neutral path (which itself bypasses applySelectiveColorRow
// when bands are all-neutral, because the F32 OKLab round-trip can flip
// 8-bit byte boundaries on otherwise-unchanged pixels).
function isSelectiveColorActive(
  bands: LumaColorSelectiveColorParams['selectiveColor'] | null | undefined,
): boolean {
  if (!bands) return false
  const normalized = normalizeSelectiveColorParams({ selectiveColor: bands })
  for (const band of Object.values(normalized)) {
    if (band.hue !== 0 || band.saturation !== 0 || band.lightness !== 0) {
      return true
    }
  }
  return false
}

function getExportFailureCode(error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code
  }

  if (error instanceof Error) {
    return error.message || error.name
  }

  return String(error)
}

function getExportFailureMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

const DEFAULT_PARAMS: ProcessingParams = {
  intensity: 0.7,
  viewMode: 'compare',
  compareSplit: 0.5,
  styleKind: 'none',
  builtinPreset: null,
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
}

const VIEW_MODE_UNIFORMS: Record<ProcessingParams['viewMode'], number> = {
  processed: 0,
  original: 1,
  compare: 2,
}

function toExportProcessingParams(params: ProcessingParams): ProcessingParams {
  return {
    ...params,
    viewMode: 'processed',
    compareSplit: 0.5,
  }
}

const STYLE_KIND_UNIFORMS: Record<ProcessingParams['styleKind'], number> = {
  none: 0,
  builtin: 1,
  custom: 2,
}

const BUILTIN_PRESET_UNIFORMS: Record<BuiltinStylePreset, number> = {
  neutral: 0,
  warm: 1,
  cool: 2,
  'film-soft': 3,
  'film-contrast': 4,
  cinematic: 5,
  fade: 6,
  mono: 7,
}

export interface LUTPipelineProfileUniforms {
  inputToLutGamut: Float32Array
  lutOutputToDisplayGamut: Float32Array
  lutInputTransfer: number
  lutOutputTransfer: number
  lutRole: number
  lutInputRange: number
  lutOutputRange: number
}

const DISPLAY_TARGET_GAMUT = 'srgb-rec709'

const DISPLAY_PROFILE_UNIFORMS: LUTPipelineProfileUniforms = {
  inputToLutGamut: mat3ToGLSL(mat3Identity()),
  lutOutputToDisplayGamut: mat3ToGLSL(mat3Identity()),
  lutInputTransfer: LUT_TRANSFER_UNIFORMS.srgb,
  lutOutputTransfer: LUT_TRANSFER_UNIFORMS.srgb,
  lutRole: LUT_ROLE_UNIFORMS['display-look'],
  lutInputRange: LUT_RANGE_UNIFORMS.full,
  lutOutputRange: LUT_RANGE_UNIFORMS.full,
}

export function isLUTProfileRenderable(
  profileResolution?: LUTContractResolution | null,
): boolean {
  if (!profileResolution || profileResolution.kind !== 'confirmed') {
    return false
  }

  const { profile } = profileResolution
  if (profile.role === 'display-look') {
    return true
  }

  return Boolean(
    profile.outputGamut &&
    profile.outputTransfer &&
    profile.outputRange &&
    profile.outputRange !== 'unknown',
  )
}

function resolveLUTOutputTransfer(
  profile: LUTColorProfile,
): TransferFunctionId | undefined {
  if (profile.outputTransfer) return profile.outputTransfer

  if (profile.role === 'display-look') return profile.inputTransfer

  return undefined
}

export function resolveLUTPipelineProfileUniforms(
  profileResolution?: LUTContractResolution | null,
): LUTPipelineProfileUniforms {
  if (
    !isLUTProfileRenderable(profileResolution) ||
    profileResolution?.kind !== 'confirmed'
  ) {
    return DISPLAY_PROFILE_UNIFORMS
  }

  const { profile } = profileResolution
  if (profile.role === 'display-look') {
    return {
      ...DISPLAY_PROFILE_UNIFORMS,
      lutInputTransfer:
        LUT_TRANSFER_UNIFORMS[profile.inputTransfer] ??
        DISPLAY_PROFILE_UNIFORMS.lutInputTransfer,
      lutOutputTransfer:
        LUT_TRANSFER_UNIFORMS[
          profile.outputTransfer ?? profile.inputTransfer
        ] ?? DISPLAY_PROFILE_UNIFORMS.lutOutputTransfer,
      lutInputRange: LUT_RANGE_UNIFORMS[profile.inputRange],
      lutOutputRange: LUT_RANGE_UNIFORMS[profile.outputRange ?? 'full'],
    }
  }

  const outputGamut = profile.outputGamut!
  const outputTransfer = resolveLUTOutputTransfer(profile)
  const lutOutputToDisplayGamut =
    outputGamut === DISPLAY_TARGET_GAMUT
      ? mat3Identity()
      : getLUTOutputToTargetMatrix(outputGamut, DISPLAY_TARGET_GAMUT)

  return {
    inputToLutGamut: mat3ToGLSL(
      getLinearProPhotoToGamutMatrix(profile.inputGamut),
    ),
    lutOutputToDisplayGamut: mat3ToGLSL(lutOutputToDisplayGamut),
    lutInputTransfer: LUT_TRANSFER_UNIFORMS[profile.inputTransfer],
    lutOutputTransfer: LUT_TRANSFER_UNIFORMS[outputTransfer!],
    lutRole: LUT_ROLE_UNIFORMS[profile.role],
    lutInputRange: LUT_RANGE_UNIFORMS[profile.inputRange],
    lutOutputRange: LUT_RANGE_UNIFORMS[profile.outputRange!],
  }
}

/**
 * WebGL2-based RAW processing pipeline.
 */
export class RawProcessingPipeline {
  private gl: WebGL2RenderingContext
  private canvas: HTMLCanvasElement
  private capabilities: WebGLCapabilities

  // Shader programs
  private processProgramFloat: WebGLProgram | null = null
  private processProgramU16: WebGLProgram | null = null
  private outputProgram: WebGLProgram | null = null

  // Geometry
  private fullscreenQuad: {
    vao: WebGLVertexArrayObject
    vbo: WebGLBuffer
  } | null = null

  // Textures
  private inputTexture: WebGLTexture | null = null
  private lutTexture: WebGLTexture | null = null
  private fallbackLutTexture: WebGLTexture | null = null
  private processedTexture: WebGLTexture | null = null
  private selectiveColorTexture: WebGLTexture | null = null

  // Selective-color LUT bake state
  private selectiveColorBuffer: Float32Array | null = null
  private lastBakedSelectiveBands:
    | LumaColorSelectiveColorParams['selectiveColor']
    | null
    | undefined = undefined
  // Mirrors row-band-processor's neutral bypass: when every band is neutral,
  // the shader skips the OKLab roundtrip so WebGL preview stays byte-exact
  // with the CPU export's `selectiveColorNeutralBypass` branch.
  private lastSelectiveColorActive = false

  // Framebuffers
  private processFBO: WebGLFramebuffer | null = null

  // State
  private inputWidth = 0
  private inputHeight = 0
  private inputUpload: RawUploadInput | null = null
  private inputFormat: RawUploadInputFormat = 'float-rgba'
  private rawRenderExposureMultiplier = 1
  private params: ProcessingParams = { ...DEFAULT_PARAMS }
  private lutData: LUTData | null = null
  private lastImageUploadTime = 0
  private lastLutUploadTime = 0
  private processTargetPrecision: ProcessTargetPrecision = 'rgba16f'
  private capabilityWarnings: PipelineCapabilityWarning[] = []
  private lastExportStats: ExportRenderStats | null = null
  private isInitialized = false

  // Uniforms locations cache
  private outputUniforms: Record<string, WebGLUniformLocation | null> = {}

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const gl = createWebGL2Context(canvas)
    if (!gl) {
      throw new Error('WebGL2 is not supported on this device')
    }
    this.gl = gl
    this.capabilities = detectCapabilities(gl)
    const textureSelection = selectProcessingTextureFormat(this.capabilities)
    this.processTargetPrecision = textureSelection.precision
    this.capabilityWarnings = textureSelection.warnings
  }

  /**
   * Initialize the pipeline (compile shaders, create buffers).
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return

    const { gl } = this

    // Create shader programs
    this.processProgramFloat = createProgram(
      gl,
      VERTEX_SHADER,
      PROCESS_FRAGMENT_SHADER_FLOAT,
    )
    this.processProgramU16 = createProgram(
      gl,
      VERTEX_SHADER,
      PROCESS_FRAGMENT_SHADER_U16,
    )
    this.outputProgram = createProgram(gl, VERTEX_SHADER, PREVIEW_OUTPUT_SHADER)

    if (
      !this.processProgramFloat ||
      !this.processProgramU16 ||
      !this.outputProgram
    ) {
      throw new Error('Failed to create shader programs')
    }

    // Cache uniform locations
    this.cacheOutputUniforms()

    // Create fullscreen quad
    this.fullscreenQuad = createFullscreenQuad(gl)
    if (!this.fullscreenQuad) {
      throw new Error('Failed to create fullscreen quad')
    }

    this.fallbackLutTexture = this.createFallbackLutTexture()
    if (!this.fallbackLutTexture) {
      throw new Error('Failed to create fallback LUT texture')
    }

    // The selective-color LUT is a 256x1 RGBA16F texture with NEAREST
    // filtering. Shader-side `sampleSelectiveColorLut` does its own bilinear
    // hue-interpolation via `texelFetch`, so we deliberately disable hardware
    // filtering to keep CPU/GPU bit-parity. The pooled buffer is sized for one
    // baked LUT (4 channels x 256 texels) and reused across param changes.
    this.selectiveColorTexture = this.createSelectiveColorLutTexture()
    if (!this.selectiveColorTexture) {
      throw new Error('Failed to create selective-color LUT texture')
    }
    this.selectiveColorBuffer = new Float32Array(4 * SELECTIVE_COLOR_LUT_SIZE)

    this.isInitialized = true
  }

  private createSelectiveColorLutTexture(): WebGLTexture | null {
    const { gl } = this
    const texture = gl.createTexture()
    if (!texture) return null

    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    // Initial neutral fill: hueShift=0, satMul=1, lightAdd=0, padding=0.
    const neutral = new Float32Array(4 * SELECTIVE_COLOR_LUT_SIZE)
    for (let i = 0; i < SELECTIVE_COLOR_LUT_SIZE; i++) {
      neutral[4 * i + 1] = 1
    }
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA16F,
      SELECTIVE_COLOR_LUT_SIZE,
      1,
      0,
      gl.RGBA,
      gl.FLOAT,
      neutral,
    )
    gl.bindTexture(gl.TEXTURE_2D, null)

    return texture
  }

  private createFallbackLutTexture(): WebGLTexture | null {
    const { gl } = this
    const texture = gl.createTexture()
    if (!texture) return null

    gl.bindTexture(gl.TEXTURE_3D, texture)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
    gl.texImage3D(
      gl.TEXTURE_3D,
      0,
      gl.RGB8,
      1,
      1,
      1,
      0,
      gl.RGB,
      gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0]),
    )
    gl.bindTexture(gl.TEXTURE_3D, null)

    return texture
  }

  private getProcessUniforms(
    program: WebGLProgram,
  ): Record<string, WebGLUniformLocation | null> {
    const { gl } = this

    return {
      u_inputTexture: gl.getUniformLocation(program, 'u_inputTexture'),
      u_lutTexture: gl.getUniformLocation(program, 'u_lutTexture'),
      u_useLut: gl.getUniformLocation(program, 'u_useLut'),
      u_lutSize: gl.getUniformLocation(program, 'u_lutSize'),
      u_lutDomainMin: gl.getUniformLocation(program, 'u_lutDomainMin'),
      u_lutDomainMax: gl.getUniformLocation(program, 'u_lutDomainMax'),
      u_intensity: gl.getUniformLocation(program, 'u_intensity'),
      u_rawRenderExposureMultiplier: gl.getUniformLocation(
        program,
        'u_rawRenderExposureMultiplier',
      ),
      u_userColorBalanceGain: gl.getUniformLocation(
        program,
        'u_userColorBalanceGain',
      ),
      u_userExposureMultiplier: gl.getUniformLocation(
        program,
        'u_userExposureMultiplier',
      ),
      u_userContrastAmount: gl.getUniformLocation(
        program,
        'u_userContrastAmount',
      ),
      u_userContrastFactor: gl.getUniformLocation(
        program,
        'u_userContrastFactor',
      ),
      u_userHighlights: gl.getUniformLocation(program, 'u_userHighlights'),
      u_userShadows: gl.getUniformLocation(program, 'u_userShadows'),
      u_userWhites: gl.getUniformLocation(program, 'u_userWhites'),
      u_userBlacks: gl.getUniformLocation(program, 'u_userBlacks'),
      u_viewMode: gl.getUniformLocation(program, 'u_viewMode'),
      u_compareSplit: gl.getUniformLocation(program, 'u_compareSplit'),
      u_styleKind: gl.getUniformLocation(program, 'u_styleKind'),
      u_builtinPreset: gl.getUniformLocation(program, 'u_builtinPreset'),
      u_inputToLutGamut: gl.getUniformLocation(program, 'u_inputToLutGamut'),
      u_lutOutputToDisplayGamut: gl.getUniformLocation(
        program,
        'u_lutOutputToDisplayGamut',
      ),
      u_lutInputTransfer: gl.getUniformLocation(program, 'u_lutInputTransfer'),
      u_lutOutputTransfer: gl.getUniformLocation(
        program,
        'u_lutOutputTransfer',
      ),
      u_lutRole: gl.getUniformLocation(program, 'u_lutRole'),
      u_lutInputRange: gl.getUniformLocation(program, 'u_lutInputRange'),
      u_lutOutputRange: gl.getUniformLocation(program, 'u_lutOutputRange'),
      u_selectiveColorLUT: gl.getUniformLocation(
        program,
        'u_selectiveColorLUT',
      ),
      u_selectiveColorChromaClamp: gl.getUniformLocation(
        program,
        'u_selectiveColorChromaClamp',
      ),
      u_selectiveColorActive: gl.getUniformLocation(
        program,
        'u_selectiveColorActive',
      ),
      u_userSaturation: gl.getUniformLocation(program, 'u_userSaturation'),
      u_userVibrance: gl.getUniformLocation(program, 'u_userVibrance'),
    }
  }

  private cacheOutputUniforms(): void {
    const { gl } = this
    const program = this.outputProgram!

    this.outputUniforms = {
      u_inputTexture: gl.getUniformLocation(program, 'u_inputTexture'),
    }
  }

  /**
   * Upload decoded RAW image data to GPU.
   * @param input - Decoded RAW data and its GPU upload layout.
   */
  uploadImage(input: RawUploadInput): void {
    const startTime = performance.now()
    const { gl } = this

    this.inputUpload = input
    this.inputFormat = describeRawUploadInput(input).inputFormat
    const rawRenderExposureMultiplier =
      input.colorSpace === 'linear-prophoto-rgb'
        ? input.renderExposureMultiplier
        : 1
    this.rawRenderExposureMultiplier =
      typeof rawRenderExposureMultiplier === 'number' &&
      Number.isFinite(rawRenderExposureMultiplier)
        ? rawRenderExposureMultiplier
        : 1

    // Delete old texture
    if (this.inputTexture) {
      gl.deleteTexture(this.inputTexture)
    }

    if (input.layout === 'rgb-u16') {
      this.inputTexture = createRgb16UiTextureFromData(
        gl,
        input.width,
        input.height,
        input.data,
      )
    } else {
      const { internalFormat, format, type } = getRecommendedTextureFormat(gl)
      this.inputTexture = createTextureFromData(
        gl,
        input.width,
        input.height,
        input.data,
        {
          internalFormat,
          format,
          type,
        },
      )
    }

    if (!this.inputTexture) {
      throw new Error('Failed to create input texture')
    }

    this.inputWidth = input.width
    this.inputHeight = input.height

    // Recreate processing framebuffer at new size
    this.recreateProcessFBO(input.width, input.height)
    this.lastImageUploadTime = performance.now() - startTime
  }

  /**
   * Clear uploaded image state so render/export cannot reuse stale pixels.
   */
  clearImage(): void {
    const { gl } = this

    if (this.inputTexture) {
      gl.deleteTexture(this.inputTexture)
      this.inputTexture = null
    }
    if (this.processFBO) {
      gl.deleteFramebuffer(this.processFBO)
      this.processFBO = null
    }
    if (this.processedTexture) {
      gl.deleteTexture(this.processedTexture)
      this.processedTexture = null
    }

    this.inputUpload = null
    this.inputFormat = 'float-rgba'
    this.rawRenderExposureMultiplier = 1
    this.inputWidth = 0
    this.inputHeight = 0
    this.lastImageUploadTime = 0
  }

  private recreateProcessFBO(width: number, height: number): void {
    const { gl } = this

    // Delete old FBO
    if (this.processFBO) {
      gl.deleteFramebuffer(this.processFBO)
      this.processFBO = null
    }
    if (this.processedTexture) {
      gl.deleteTexture(this.processedTexture)
      this.processedTexture = null
    }

    const result = createFramebuffer(gl, width, height)
    if (result) {
      this.processFBO = result.framebuffer
      this.processedTexture = result.texture
      this.processTargetPrecision =
        result.textureFormat?.precision ?? this.processTargetPrecision
      this.capabilityWarnings = getProcessingTextureFormatWarnings(
        this.processTargetPrecision,
      )
    }
  }

  /**
   * Upload a 3D LUT.
   */
  uploadLUT(lut: LUTData): void {
    const startTime = performance.now()
    const { gl } = this

    // Delete old LUT texture
    if (this.lutTexture) {
      gl.deleteTexture(this.lutTexture)
    }

    this.lutTexture = create3DTexture(gl, lut.size, lut.data)
    if (!this.lutTexture) {
      this.lutData = null
      this.lastLutUploadTime = performance.now() - startTime
      throw new Error('Failed to create LUT texture')
    }

    this.lutData = lut
    this.lastLutUploadTime = performance.now() - startTime
  }

  /**
   * Clear LUT.
   */
  clearLUT(): void {
    const { gl } = this
    if (this.lutTexture) {
      gl.deleteTexture(this.lutTexture)
      this.lutTexture = null
    }
    this.lutData = null
    this.lastLutUploadTime = 0
  }

  /**
   * Set processing parameters.
   */
  setParams(params: Partial<ProcessingParams>): void {
    this.params = { ...this.params, ...params }
  }

  /**
   * Get current processing parameters.
   */
  getParams(): ProcessingParams {
    return { ...this.params }
  }

  /**
   * Process the image and render to canvas.
   */
  render(options: RenderOptions = {}): PipelineStats {
    const startTime = performance.now()
    const { gl, canvas } = this
    const waitForGpu = options.waitForGpu ?? true

    if (!this.isInitialized || !this.inputTexture) {
      return {
        uploadTime: this.lastImageUploadTime,
        lutUploadTime: this.lastLutUploadTime,
        processTime: 0,
        totalTime: 0,
        inputSize: { width: 0, height: 0 },
        previewSize: { width: canvas.width, height: canvas.height },
        ...this.getTelemetrySnapshot(),
      }
    }

    const processStart = performance.now()

    // Pass 1: Process image to FBO
    this.renderProcessPass()

    // Pass 2: Output to canvas with tone mapping
    this.renderOutputPass()

    if (waitForGpu) {
      gl.finish()
    } else {
      gl.flush()
    }
    const processTime = performance.now() - processStart

    return {
      uploadTime: this.lastImageUploadTime,
      lutUploadTime: this.lastLutUploadTime,
      processTime,
      totalTime: performance.now() - startTime,
      inputSize: { width: this.inputWidth, height: this.inputHeight },
      previewSize: { width: canvas.width, height: canvas.height },
      ...this.getTelemetrySnapshot(),
    }
  }

  private getTelemetrySnapshot(): PipelineTelemetrySnapshot {
    const exportGraph = resolveExportColorGraph({
      styleKind: this.params.styleKind,
      intensity: this.params.intensity,
      builtinPreset: this.params.builtinPreset,
      lut: this.lutData,
      userExposureEv: this.params.userExposureEv,
      userContrast: this.params.userContrast,
      userHighlights: this.params.userHighlights,
      userShadows: this.params.userShadows,
      userWhites: this.params.userWhites,
      userBlacks: this.params.userBlacks,
      userTemperature: this.params.userTemperature,
      userTint: this.params.userTint,
      userSaturation: this.params.userSaturation,
      userVibrance: this.params.userVibrance,
      selectiveColor: this.params.selectiveColor,
    })
    const resolvedProfile = exportGraph.supported
      ? exportGraph.lutProfile
      : null
    const outputTransfer = resolvedProfile
      ? resolveLUTOutputTransfer(resolvedProfile)
      : null

    return {
      inputFormat: this.inputFormat,
      transformPath: this.getTransformPath(),
      lutRole: resolvedProfile?.role ?? null,
      lutInputTransfer: resolvedProfile?.inputTransfer ?? null,
      lutOutputTransfer: outputTransfer ?? null,
      lutSize: this.lutData?.size ?? null,
      processTargetPrecision: this.processTargetPrecision,
      capabilityWarnings: this.capabilityWarnings.map((warning) => ({
        ...warning,
      })),
    }
  }

  private getTransformPath(): PipelineTransformPath {
    if (this.params.styleKind === 'builtin') {
      return 'builtin-style'
    }
    if (this.params.styleKind !== 'custom' || !this.lutData) {
      return 'no-lut'
    }
    if (!this.lutTexture) {
      return 'no-lut'
    }
    if (!isLUTProfileRenderable(this.lutData.profileResolution)) {
      return 'disabled-lut'
    }

    const profileResolution = this.lutData.profileResolution
    if (profileResolution.kind !== 'confirmed') {
      return 'display-lut'
    }

    switch (profileResolution.profile.role) {
      case 'display-look':
        return 'display-lut'
      case 'scene-creative':
        return 'scene-creative-lut'
      case 'combined-look-output':
        return 'combined-output-lut'
      case 'technical-output':
        return 'technical-output-lut'
    }
  }

  private bindSelectiveColorPass(
    processUniforms: Record<string, WebGLUniformLocation | null>,
  ): void {
    const { gl } = this
    const texture = this.selectiveColorTexture
    const buffer = this.selectiveColorBuffer
    if (!texture || !buffer) return

    const bands = this.params.selectiveColor
    if (bands !== this.lastBakedSelectiveBands) {
      // resolveSelectiveColorParams writes into the pooled buffer; passing it
      // as the out-buffer keeps the hot path allocation-free. The function
      // accepts a Partial here so undefined `bands` bakes a neutral LUT.
      const partial: Partial<LumaColorSelectiveColorParams> = bands
        ? { selectiveColor: bands }
        : {}
      resolveSelectiveColorParams(partial, buffer)

      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        SELECTIVE_COLOR_LUT_SIZE,
        1,
        gl.RGBA,
        gl.FLOAT,
        buffer,
      )
      this.lastBakedSelectiveBands = bands
      this.lastSelectiveColorActive = isSelectiveColorActive(bands)
    } else {
      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_2D, texture)
    }

    gl.uniform1i(processUniforms.u_selectiveColorLUT, 2)
    gl.uniform2f(
      processUniforms.u_selectiveColorChromaClamp,
      CHROMA_CLAMP_LOW,
      CHROMA_CLAMP_HIGH,
    )
    gl.uniform1i(
      processUniforms.u_selectiveColorActive,
      this.lastSelectiveColorActive ? 1 : 0,
    )
  }

  private renderProcessPass(): void {
    const {
      gl,
      processProgramFloat,
      processProgramU16,
      processFBO,
      inputWidth,
      inputHeight,
      inputTexture,
      lutTexture,
      fallbackLutTexture,
      lutData,
      fullscreenQuad,
      params,
      inputFormat,
    } = this
    const processProgram =
      inputFormat === 'uint16-rgb' ? processProgramU16 : processProgramFloat

    if (!processProgram) {
      throw new Error('PROCESS_PROGRAM_MISSING')
    }
    const processUniforms = this.getProcessUniforms(processProgram)

    // Bind FBO
    gl.bindFramebuffer(gl.FRAMEBUFFER, processFBO)
    gl.viewport(0, 0, inputWidth, inputHeight)

    gl.useProgram(processProgram)

    // Bind input texture
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, inputTexture)
    gl.uniform1i(processUniforms.u_inputTexture, 0)

    // Bind LUT texture
    gl.activeTexture(gl.TEXTURE1)
    const useRenderableLut = Boolean(
      lutTexture &&
      lutData &&
      isLUTProfileRenderable(lutData.profileResolution),
    )

    gl.bindTexture(
      gl.TEXTURE_3D,
      useRenderableLut ? lutTexture : fallbackLutTexture,
    )
    gl.uniform1i(processUniforms.u_lutTexture, 1)
    if (useRenderableLut && lutData) {
      gl.uniform1i(processUniforms.u_useLut, 1)
      gl.uniform1f(processUniforms.u_lutSize, Math.max(1, lutData.size))
      gl.uniform3fv(processUniforms.u_lutDomainMin, lutData.domainMin)
      gl.uniform3fv(processUniforms.u_lutDomainMax, lutData.domainMax)
    } else {
      gl.uniform1i(processUniforms.u_useLut, 0)
      gl.uniform1f(processUniforms.u_lutSize, 1)
      gl.uniform3fv(processUniforms.u_lutDomainMin, [0, 0, 0])
      gl.uniform3fv(processUniforms.u_lutDomainMax, [1, 1, 1])
    }

    // Selective-color LUT lives on texture unit 2. Re-bake only on reference
    // change of the params.selectiveColor record so steady-state preview avoids
    // a redundant 1KB upload + sin/cos pass per frame.
    this.bindSelectiveColorPass(processUniforms)

    gl.uniform1f(processUniforms.u_intensity, params.intensity)
    gl.uniform1i(
      processUniforms.u_viewMode,
      VIEW_MODE_UNIFORMS[params.viewMode],
    )
    gl.uniform1f(
      processUniforms.u_compareSplit,
      Math.min(1, Math.max(0, params.compareSplit)),
    )
    gl.uniform1f(
      processUniforms.u_rawRenderExposureMultiplier,
      this.rawRenderExposureMultiplier,
    )
    const tone = resolveToneParams({
      userExposureEv: params.userExposureEv,
      userContrast: params.userContrast,
      userHighlights: params.userHighlights,
      userShadows: params.userShadows,
      userWhites: params.userWhites,
      userBlacks: params.userBlacks,
    })
    const colorBalance = resolveColorBalanceParams({
      userTemperature: params.userTemperature,
      userTint: params.userTint,
    })
    gl.uniform3f(
      processUniforms.u_userColorBalanceGain,
      colorBalance.gain[0],
      colorBalance.gain[1],
      colorBalance.gain[2],
    )
    gl.uniform1f(
      processUniforms.u_userExposureMultiplier,
      tone.userExposureMultiplier,
    )
    gl.uniform1f(processUniforms.u_userContrastAmount, tone.userContrast)
    gl.uniform1f(processUniforms.u_userContrastFactor, tone.userContrastFactor)
    gl.uniform1f(processUniforms.u_userHighlights, tone.userHighlights)
    gl.uniform1f(processUniforms.u_userShadows, tone.userShadows)
    gl.uniform1f(processUniforms.u_userWhites, tone.userWhites)
    gl.uniform1f(processUniforms.u_userBlacks, tone.userBlacks)
    gl.uniform1f(processUniforms.u_userSaturation, params.userSaturation)
    gl.uniform1f(processUniforms.u_userVibrance, params.userVibrance)
    gl.uniform1i(
      processUniforms.u_styleKind,
      STYLE_KIND_UNIFORMS[params.styleKind],
    )
    gl.uniform1i(
      processUniforms.u_builtinPreset,
      params.builtinPreset ? BUILTIN_PRESET_UNIFORMS[params.builtinPreset] : 0,
    )
    const lutProfileUniforms = resolveLUTPipelineProfileUniforms(
      lutData?.profileResolution,
    )
    gl.uniformMatrix3fv(
      processUniforms.u_inputToLutGamut,
      false,
      lutProfileUniforms.inputToLutGamut,
    )
    gl.uniformMatrix3fv(
      processUniforms.u_lutOutputToDisplayGamut,
      false,
      lutProfileUniforms.lutOutputToDisplayGamut,
    )
    gl.uniform1i(
      processUniforms.u_lutInputTransfer,
      lutProfileUniforms.lutInputTransfer,
    )
    gl.uniform1i(
      processUniforms.u_lutOutputTransfer,
      lutProfileUniforms.lutOutputTransfer,
    )
    gl.uniform1i(processUniforms.u_lutRole, lutProfileUniforms.lutRole)
    gl.uniform1i(
      processUniforms.u_lutInputRange,
      lutProfileUniforms.lutInputRange,
    )
    gl.uniform1i(
      processUniforms.u_lutOutputRange,
      lutProfileUniforms.lutOutputRange,
    )

    // Draw
    gl.bindVertexArray(fullscreenQuad!.vao)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindVertexArray(null)
  }

  private renderOutputPass(): void {
    const {
      gl,
      outputProgram,
      canvas,
      processedTexture,
      outputUniforms,
      fullscreenQuad,
    } = this

    // Bind default framebuffer (canvas)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, canvas.width, canvas.height)

    gl.useProgram(outputProgram)

    // Bind processed texture
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, processedTexture)
    gl.uniform1i(outputUniforms.u_inputTexture, 0)

    // Draw
    gl.bindVertexArray(fullscreenQuad!.vao)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindVertexArray(null)
  }

  /**
   * Read pixels from the processed image for export.
   */
  readProcessedPixels(): Float32Array | null {
    const { gl, processFBO, inputWidth, inputHeight } = this

    if (!processFBO || !inputWidth || !inputHeight) {
      return null
    }

    // Bind FBO
    gl.bindFramebuffer(gl.FRAMEBUFFER, processFBO)

    // Read pixels
    const pixels = new Float32Array(inputWidth * inputHeight * 4)
    gl.readPixels(0, 0, inputWidth, inputHeight, gl.RGBA, gl.FLOAT, pixels)

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)

    return pixels
  }

  async renderToHiddenCanvas({
    width,
    height,
    exportOptions,
  }: {
    width: number
    height: number
    exportOptions?: ExportRenderOptions
  }) {
    if (!this.inputUpload) {
      throw new Error('EXPORT_SOURCE_MISSING')
    }

    const totalStart = performance.now()
    const planningStart = performance.now()
    const plan = planExportRenderTarget({
      width,
      height,
      maxTextureSize: this.capabilities.maxTextureSize,
      ...exportOptions,
    })
    const planningTime = performance.now() - planningStart

    if (plan.strategy === 'fail') {
      this.lastExportStats = {
        ...this.getTelemetrySnapshot(),
        strategy: 'fail',
        width: plan.width,
        height: plan.height,
        tileCount: 0,
        planningTime,
        renderTime: 0,
        totalTime: performance.now() - totalStart,
        reason: plan.reason,
        retryable: plan.retryable,
      }
      throw ExportRenderError.fromFailedPlan(plan)
    }

    const renderStart = performance.now()
    let outputCanvas: HTMLCanvasElement
    try {
      outputCanvas =
        plan.strategy === 'tiled'
          ? await this.renderTiledHiddenCanvas(plan)
          : await this.renderFullFrameHiddenCanvas(width, height)
    } catch (error) {
      const renderTime = performance.now() - renderStart
      this.lastExportStats = {
        ...this.getTelemetrySnapshot(),
        strategy: 'fail',
        width: plan.width,
        height: plan.height,
        tileCount:
          plan.strategy === 'tiled' ? createExportTiles(plan).length : 1,
        planningTime,
        renderTime,
        totalTime: performance.now() - totalStart,
        reason: 'render-failure',
        failureCode: getExportFailureCode(error),
        failureMessage: getExportFailureMessage(error),
        retryable: false,
      }
      throw error
    }
    const renderTime = performance.now() - renderStart

    this.lastExportStats = {
      ...this.getTelemetrySnapshot(),
      strategy: plan.strategy,
      width: plan.width,
      height: plan.height,
      tileCount: plan.strategy === 'tiled' ? createExportTiles(plan).length : 1,
      planningTime,
      renderTime,
      totalTime: performance.now() - totalStart,
      reason: plan.strategy === 'tiled' ? plan.reason : undefined,
    }

    return outputCanvas
  }

  getLastExportStats(): ExportRenderStats | null {
    return this.lastExportStats
  }

  private async renderFullFrameHiddenCanvas(
    width: number,
    height: number,
  ): Promise<HTMLCanvasElement> {
    const inputUpload = this.inputUpload
    if (!inputUpload) {
      throw new Error('EXPORT_SOURCE_MISSING')
    }

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const outputCanvas = document.createElement('canvas')
    outputCanvas.width = width
    outputCanvas.height = height
    const outputContext = outputCanvas.getContext('2d')
    if (!outputContext) {
      throw new Error('EXPORT_CANVAS_CONTEXT_MISSING')
    }

    const pipeline = new RawProcessingPipeline(canvas)
    try {
      await pipeline.initialize()
      pipeline.uploadImage(inputUpload)
      if (this.lutData) {
        pipeline.uploadLUT(this.lutData)
      }
      pipeline.setParams(toExportProcessingParams(this.params))
      pipeline.render()
      outputContext.drawImage(canvas, 0, 0, width, height)
    } finally {
      pipeline.dispose({ releaseContext: true })
    }

    return outputCanvas
  }

  private async renderTiledHiddenCanvas(
    plan: Extract<
      ReturnType<typeof planExportRenderTarget>,
      { strategy: 'tiled' }
    >,
  ): Promise<HTMLCanvasElement> {
    if (
      !this.inputUpload ||
      this.inputUpload.width !== plan.width ||
      this.inputUpload.height !== plan.height
    ) {
      throw new Error('EXPORT_TILED_REQUIRES_SOURCE_SIZE')
    }

    const canvas = document.createElement('canvas')
    canvas.width = plan.width
    canvas.height = plan.height

    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('EXPORT_CANVAS_CONTEXT_MISSING')
    }

    const tileCanvas = document.createElement('canvas')
    tileCanvas.width = plan.tileWidth
    tileCanvas.height = plan.tileHeight

    const pipeline = new RawProcessingPipeline(tileCanvas)
    try {
      await pipeline.initialize()
      if (this.lutData) {
        pipeline.uploadLUT(this.lutData)
      }
      pipeline.setParams(toExportProcessingParams(this.params))

      for (const tile of createExportTiles(plan)) {
        pipeline.resize(tile.width, tile.height)
        pipeline.uploadImage(cropRawUploadInput(this.inputUpload, tile))
        pipeline.render()

        context.drawImage(
          tileCanvas,
          0,
          0,
          tile.width,
          tile.height,
          tile.x,
          tile.y,
          tile.width,
          tile.height,
        )
      }
    } finally {
      pipeline.dispose({ releaseContext: true })
    }

    return canvas
  }

  /**
   * Resize the canvas.
   */
  resize(width: number, height: number): void {
    this.canvas.width = width
    this.canvas.height = height
  }

  /**
   * Get WebGL capabilities.
   */
  getCapabilities(): WebGLCapabilities {
    return this.capabilities
  }

  /**
   * Get input image dimensions.
   */
  getInputDimensions(): { width: number; height: number } {
    return { width: this.inputWidth, height: this.inputHeight }
  }

  /**
   * Dispose all resources.
   */
  dispose({
    releaseContext = false,
  }: {
    releaseContext?: boolean
  } = {}): void {
    const {
      gl,
      inputTexture,
      lutTexture,
      fallbackLutTexture,
      processedTexture,
      selectiveColorTexture,
      processFBO,
      processProgramFloat,
      processProgramU16,
      outputProgram,
      fullscreenQuad,
    } = this

    // Delete textures
    if (inputTexture) gl.deleteTexture(inputTexture)
    if (lutTexture) gl.deleteTexture(lutTexture)
    if (fallbackLutTexture) gl.deleteTexture(fallbackLutTexture)
    if (processedTexture) gl.deleteTexture(processedTexture)
    if (selectiveColorTexture) gl.deleteTexture(selectiveColorTexture)

    // Delete framebuffers
    if (processFBO) gl.deleteFramebuffer(processFBO)

    // Delete programs
    if (processProgramFloat) gl.deleteProgram(processProgramFloat)
    if (processProgramU16) gl.deleteProgram(processProgramU16)
    if (outputProgram) gl.deleteProgram(outputProgram)

    // Delete geometry
    if (fullscreenQuad) {
      gl.deleteVertexArray(fullscreenQuad.vao)
      gl.deleteBuffer(fullscreenQuad.vbo)
    }

    this.inputTexture = null
    this.lutTexture = null
    this.fallbackLutTexture = null
    this.processedTexture = null
    this.selectiveColorTexture = null
    this.selectiveColorBuffer = null
    this.lastBakedSelectiveBands = undefined
    this.lastSelectiveColorActive = false
    this.processFBO = null
    this.processProgramFloat = null
    this.processProgramU16 = null
    this.outputProgram = null
    this.fullscreenQuad = null

    if (releaseContext) {
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }

    this.isInitialized = false
  }
}

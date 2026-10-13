export type LumaRawRuntimeMemoryProfile = 'desktop' | 'low-memory'

export type LumaRawSupportLevel = 'official' | 'experimental' | 'unsupported'

export type LumaRawTimings = {
  readFile?: number
  copyToWasm?: number
  librawOpen?: number
  openBuffer?: number
  metadata?: number
  thumbnail?: number
  unpack?: number
  total: number
}

export type LumaRawHeapStats = {
  before?: number
  after?: number
  peak?: number
}

export type LumaRawQuickOptions = {
  maxOutputPixels?: number
}

export type LumaRawBoundedHqOptions = {
  maxOutputPixels: number
}

export type LumaRawCfaPattern =
  | 'rggb'
  | 'bggr'
  | 'grbg'
  | 'gbrg'
  | 'x-trans'
  | 'unsupported'

export type LumaRawCfaInfo = {
  pattern: LumaRawCfaPattern
  xPhase: 0 | 1 | 2 | 3 | 4 | 5
  yPhase: 0 | 1 | 2 | 3 | 4 | 5
}

export type LumaRawSensorLayout =
  | 'bayer'
  | 'x-trans'
  | 'foveon'
  | 'monochrome'
  | 'rgb-like'
  | 'unknown'

export type LumaRawFullResInputStrategy = 'libraw-processed-window'

export type LumaRawWindowRect = {
  x: number
  y: number
  width: number
  height: number
}

export type LumaRawExportUnsupportedReason =
  | 'unsupported-sensor-layout'
  | 'missing-visible-crop'
  | 'missing-levels'
  | 'missing-camera-white-balance'
  | 'missing-camera-to-output-color'
  | 'processed-window-unavailable'
  | 'unsupported-source'
  | 'unsupported-cfa'
  | 'missing-dimensions'
  | 'unsupported-orientation'
  | 'missing-color-transform'
  | 'missing-export-facts'

export type LumaRawVisibleCrop = {
  x: number
  y: number
  width: number
  height: number
}

export type LumaRawExportOrientation = {
  code: number
  supported: boolean
  outputWidth?: number
  outputHeight?: number
}

export type LumaRawExportColorFacts = {
  workingSpace: 'linear-prophoto-rgb'
  librawOutputColor: 'prophoto'
  gamma: 'linear'
  cameraWhiteBalanceAppliedByRuntime: boolean
  cameraMatrixAppliedByRuntime: boolean
  whiteBalance?: [number, number, number, number]
  cameraToWorkingRgb?: [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ]
}

export type LumaRawExportSensorFacts = {
  layout: LumaRawSensorLayout
  cfa?: LumaRawCfaInfo
}

export type LumaRawExportWindowFacts = {
  librawProcessed: boolean
}

export type LumaRawExportCapability = {
  supported: boolean
  strategy?: LumaRawFullResInputStrategy
  width: number
  height: number
  rawWidth: number
  rawHeight: number
  visibleCrop?: LumaRawVisibleCrop
  blackLevel: number
  whiteLevel: number
  orientation?: LumaRawExportOrientation
  color?: LumaRawExportColorFacts
  sensor: LumaRawExportSensorFacts
  windows: LumaRawExportWindowFacts
  reasons: LumaRawExportUnsupportedReason[]
}

export type LumaRawProcessedWindowRequest = {
  outputRect: LumaRawWindowRect
  halo: { left: number; top: number; right: number; bottom: number }
}

export type LumaRawProcessedWindowTimings = {
  setup?: number
  open?: number
  unpack?: number
  process?: number
  outputCopy?: number
  orientation?: number
  total: number
}

export type LumaRawProcessedWindow = {
  rect: LumaRawWindowRect
  workingSpace: 'linear-prophoto-rgb'
  data: Uint16Array
  width: number
  height: number
  stride: number
  normalized: false
  orientationApplied: true
  colorApplied: true
  warnings: string[]
  timings?: LumaRawProcessedWindowTimings
}

export type LumaRawMetadata = {
  width?: number
  height?: number
  rawWidth?: number
  rawHeight?: number
  make?: string
  model?: string
  lens?: string
  iso?: number
  aperture?: number
  focalLength?: number
  shutter?: number
  timestamp?: number
  orientation?: number
  blackLevel?: number
  whiteLevel?: number
  dataMaximum?: number
  perChannelBlack?: [number, number, number, number]
  blackStat?: [number, number, number, number, number, number, number, number]
  baselineExposure?: number
  thumbnail?: {
    width: number
    height: number
    format: 'jpeg' | 'bitmap' | 'unknown'
  }
  supportLevel: LumaRawSupportLevel
}

export type LumaRawRuntimeInfo = {
  runtime: 'luma'
  version: string
  crossOriginIsolated: boolean
  memoryProfile: LumaRawRuntimeMemoryProfile
}

export type LumaRawProbe = LumaRawMetadata & {
  jobId: string
  timings: LumaRawTimings
}

export type LumaRawSessionInfo = {
  sessionId: string
  probe: LumaRawProbe
  timings: LumaRawTimings
  heap?: LumaRawHeapStats
}

// Camera calibration payload carried across the worker boundary by
// `applyCalibrationToSession`. The matrix follows DNG `ColorMatrix1/2`
// convention (XYZ -> CameraRGB), row-major length 9, matching LibRaw's
// `imgdata.color.cam_xyz` direction. `toneCurveLut`, when present, is the
// DNG tone curve pre-baked to a 1D LUT in linear working space (>=4096
// entries) — Phase 1 forwards it but does NOT apply the LUT yet.
export type LumaRawCameraCalibrationProfile = {
  profileId: string
  profileName: string
  xyzToCamera: Float32Array
  toneCurveLut?: Float32Array
}

export type LumaRawFrame = {
  jobId: string
  sessionId: string
  source: 'quick' | 'bounded-hq'
  width: number
  height: number
  data: Uint16Array
  layout: 'rgb'
  bitDepth: 16
  colorSpace: 'linear-prophoto-rgb'
  orientation: number
  blackLevel?: number
  whiteLevel?: number
  metadata: LumaRawMetadata
  timings: LumaRawTimings
  heap?: LumaRawHeapStats
}

export type LumaEmbeddedPreview = {
  jobId: string
  sessionId: string
  source: 'embedded'
  width: number
  height: number
  data: Uint8Array
  mimeType: 'image/jpeg' | 'image/png' | 'application/octet-stream'
  colorSpace: 'display-srgb-preview'
  orientation: number
  timings: LumaRawTimings
  heap?: LumaRawHeapStats
}

export type LumaRawDecodeSession = LumaRawSessionInfo & {
  extractEmbeddedPreview: (
    signal?: AbortSignal,
  ) => Promise<LumaEmbeddedPreview | null>
  decodeQuick: (
    options?: LumaRawQuickOptions,
    signal?: AbortSignal,
  ) => Promise<LumaRawFrame>
  decodeBoundedHq: (
    options: LumaRawBoundedHqOptions,
    signal?: AbortSignal,
  ) => Promise<LumaRawFrame>
  probeExportCapability: (
    signal?: AbortSignal,
  ) => Promise<LumaRawExportCapability>
  readProcessedWindow: (
    request: LumaRawProcessedWindowRequest,
    signal?: AbortSignal,
  ) => Promise<LumaRawProcessedWindow>
  applyCalibration: (
    profile: LumaRawCameraCalibrationProfile,
    signal?: AbortSignal,
  ) => Promise<{ applied: true }>
  dispose: () => void
}

export type LumaRawRuntime = {
  init: () => Promise<LumaRawRuntimeInfo>
  openSession: (
    file: File,
    options?: LumaRawQuickOptions,
    signal?: AbortSignal,
  ) => Promise<LumaRawDecodeSession>
  dispose: () => void
}

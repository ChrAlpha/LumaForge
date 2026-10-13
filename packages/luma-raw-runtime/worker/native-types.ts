import type {
  LumaRawExportCapability,
  LumaRawProcessedWindow,
  LumaRawProcessedWindowRequest,
  LumaRawWindow,
  LumaRawWindowRect,
} from '../src/types'

export type LumaRawNativeMetadata = {
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
}

export type LumaRawNativeThumbnail = {
  data: Uint8Array
  width: number
  height: number
  format: 'jpeg' | 'bitmap' | 'unknown'
}

export type LumaRawNativeImage = {
  data: Uint16Array
  width: number
  height: number
  bits: 16
}

export type LumaRawNativeOpenSettings = {
  halfSize: boolean
  useCameraWb: true
  outputColor: 4
  outputBps: 16
  noAutoBright: true
  useAutoWb: false
  useCameraMatrix: 1
  bright: 1
  highlight: 2
  userQual: number
  gamm: [1, 1, 1, 1, 0, 0]
}

export type LumaRawNativeOpenTimings = {
  copyToWasm: number
  librawOpen: number
}

export type LumaRawNativeDecodeOptions = {
  maxOutputPixels?: number
}

export type LumaRawNativeExportCapability = LumaRawExportCapability

// Subset of the LumaRawCameraCalibrationProfile carried into the native
// wrapper. The runtime adapter strips identity fields (profileId,
// profileName) before invoking the native call because LibRaw does not need
// to know which profile produced the matrix.
export type LumaRawNativeCalibrationPayload = {
  xyzToCamera: Float32Array
  toneCurveLut?: Float32Array
}

export type LumaRawNativeProcessor = {
  loadBuffer: (data: Uint8Array) => Pick<LumaRawNativeOpenTimings, 'copyToWasm'>
  openWithSettings: (
    settings: LumaRawNativeOpenSettings,
  ) => LumaRawNativeOpenTimings
  openBuffer: (
    data: Uint8Array,
    settings: LumaRawNativeOpenSettings,
  ) => LumaRawNativeOpenTimings | undefined
  readMetadata: () => LumaRawNativeMetadata
  extractThumbnail: () => LumaRawNativeThumbnail | undefined
  probeExportCapability?: () => LumaRawNativeExportCapability
  readRawWindow?: (rect: LumaRawWindowRect) => LumaRawWindow
  readProcessedWindow?: (
    request: LumaRawProcessedWindowRequest,
  ) => LumaRawProcessedWindow
  applyCalibration?: (payload: LumaRawNativeCalibrationPayload) => void
  decodePreview: (options?: LumaRawNativeDecodeOptions) => LumaRawNativeImage
  decodeHq: (options?: LumaRawNativeDecodeOptions) => LumaRawNativeImage
  dispose: () => void
}

export type LumaRawNativeFactory = {
  createProcessor: () => LumaRawNativeProcessor
  heapBytes?: () => number | undefined
}

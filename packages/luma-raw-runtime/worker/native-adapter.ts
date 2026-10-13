import type {
  LumaRawCfaInfo,
  LumaRawExportCapability,
  LumaRawExportColorFacts,
  LumaRawExportDiagnostics,
  LumaRawExportOrientation,
  LumaRawExportSensorFacts,
  LumaRawExportUnsupportedReason,
  LumaRawProcessedWindow,
  LumaRawProcessedWindowRequest,
  LumaRawProcessedWindowTimings,
  LumaRawVisibleCrop,
  LumaRawWindowRect,
} from '../src/types'
import type {
  LumaRawNativeCalibrationPayload,
  LumaRawNativeDecodeOptions,
  LumaRawNativeFactory,
  LumaRawNativeOpenSettings,
  LumaRawNativeOpenTimings,
  LumaRawNativeProcessor,
} from './native-types'

type EmbindCalibrationParams = {
  xyzToCamera: number[]
  toneCurveLut?: number[]
}

type EmbindProcessor = {
  loadBuffer?: (data: Uint8Array) => unknown
  openWithSettings?: (settings: LumaRawNativeOpenSettings) => unknown
  readMetadata: () => unknown
  extractThumbnail: () => unknown
  probeExportCapability?: () => unknown
  readProcessedWindow?: (request: LumaRawProcessedWindowRequest) => unknown
  applyCalibration?: (params: EmbindCalibrationParams) => unknown
  decodePreview: (options?: LumaRawNativeDecodeOptions) => unknown
  decodeHq: (options?: LumaRawNativeDecodeOptions) => unknown
  delete?: () => void
}

type EmbindModule = {
  LumaRawProcessor: new () => EmbindProcessor
  HEAPU8?: Uint8Array
}

type NativeThumbnailFormat = 'jpeg' | 'bitmap' | 'unknown'
type NativeCfaPattern =
  | 'x-trans'
  | 'rggb'
  | 'bggr'
  | 'grbg'
  | 'gbrg'
  | 'unsupported'

const maxNativeOutputPixels = 2_147_483_647

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {}
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asOpenTiming(value: unknown, label: keyof LumaRawNativeOpenTimings) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(
      `Native RAW openBuffer returned invalid ${label} timing.`,
    )
  }

  return value
}

function maybeOpenTiming(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

function asPositiveInteger(value: unknown, label: string) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    throw new TypeError(`Native RAW image returned invalid ${label}.`)
  }

  return value
}

function asNonNegativeInteger(value: unknown, label: string) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new TypeError(`Native RAW ${label} returned invalid ${label}.`)
  }

  return value
}

function asFiniteNumberOrUndefined(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asNonNegativeFiniteTiming(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(
      `Native RAW processed-window timings returned invalid ${label}.`,
    )
  }

  return value
}

function asOptionalNonNegativeFiniteTiming(
  raw: Record<string, unknown>,
  key: keyof LumaRawProcessedWindowTimings,
) {
  if (!Object.hasOwn(raw, key)) return undefined

  return asNonNegativeFiniteTiming(raw[key], key)
}

function asNonNegativeIntegerOrUndefined(value: unknown) {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
    ? value
    : undefined
}

function asPositiveIntegerOrUndefined(value: unknown) {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0
    ? value
    : undefined
}

function asOptionalThumbnailDimension(value: unknown, label: string) {
  if (value === null || value === undefined) return undefined
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new TypeError(`Native RAW thumbnail returned invalid ${label}.`)
  }

  return value
}

function isTightTransferableView(data: Uint8Array | Uint16Array) {
  return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
}

function assertTransferableArrayBuffer(
  data: Uint8Array | Uint16Array,
  label: string,
) {
  if (!(data.buffer instanceof ArrayBuffer)) {
    throw new TypeError(
      `Native RAW ${label} returned data backed by a non-transferable buffer.`,
    )
  }
}

function normalizeUint8Output(data: Uint8Array, label: string) {
  assertTransferableArrayBuffer(data, label)
  return isTightTransferableView(data) ? data : new Uint8Array(data)
}

function normalizeUint16Output(data: Uint16Array, label: string) {
  assertTransferableArrayBuffer(data, label)
  return isTightTransferableView(data) ? data : new Uint16Array(data)
}

function normalizeDecodeOptions(options?: LumaRawNativeDecodeOptions) {
  if (options === null || options === undefined) return undefined

  const { maxOutputPixels } = options
  if (maxOutputPixels === undefined) return undefined
  if (
    typeof maxOutputPixels !== 'number' ||
    !Number.isFinite(maxOutputPixels) ||
    !Number.isInteger(maxOutputPixels) ||
    maxOutputPixels <= 0 ||
    maxOutputPixels > maxNativeOutputPixels
  ) {
    throw new TypeError(
      'Native RAW decode options include invalid maxOutputPixels.',
    )
  }

  return { maxOutputPixels }
}

function normalizeMetadata(value: unknown) {
  const raw = asRecord(value)
  const thumbnailWidth = asNumber(raw.thumbWidth)
  const thumbnailHeight = asNumber(raw.thumbHeight)
  const thumbnailFormat: NativeThumbnailFormat =
    raw.thumbFormat === 'jpeg' || raw.thumbFormat === 'bitmap'
      ? raw.thumbFormat
      : 'unknown'

  const dataMaximum = asNumber(raw.dataMaximum)
  const perChannelBlack = Array.isArray(raw.perChannelBlack)
    ? (raw.perChannelBlack.slice(0, 4).map((v) => asNumber(v)) as [
        number,
        number,
        number,
        number,
      ])
    : undefined
  const blackStat = Array.isArray(raw.blackStat)
    ? (raw.blackStat.slice(0, 8).map((v) => asNumber(v)) as [
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
      ])
    : undefined

  return {
    width: asNumber(raw.width),
    height: asNumber(raw.height),
    rawWidth: asNumber(raw.rawWidth),
    rawHeight: asNumber(raw.rawHeight),
    make: typeof raw.make === 'string' ? raw.make : undefined,
    model: typeof raw.model === 'string' ? raw.model : undefined,
    lens: typeof raw.lens === 'string' ? raw.lens : undefined,
    iso: asNumber(raw.iso),
    aperture: asNumber(raw.aperture),
    focalLength: asNumber(raw.focalLength),
    shutter: asNumber(raw.shutter),
    timestamp: asNumber(raw.timestamp),
    orientation: asNumber(raw.orientation),
    blackLevel: asNumber(raw.blackLevel),
    whiteLevel: asNumber(raw.whiteLevel),
    dataMaximum:
      dataMaximum !== undefined && dataMaximum > 0 ? dataMaximum : undefined,
    perChannelBlack: perChannelBlack?.every((v) => v !== undefined)
      ? perChannelBlack
      : undefined,
    blackStat: blackStat?.every((v) => v !== undefined) ? blackStat : undefined,
    baselineExposure: asNumber(raw.baselineExposure),
    thumbnail:
      thumbnailWidth && thumbnailHeight
        ? {
            width: thumbnailWidth,
            height: thumbnailHeight,
            format: thumbnailFormat,
          }
        : undefined,
  }
}

function normalizeOpenTimings(
  value: unknown,
): LumaRawNativeOpenTimings | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object') {
    return undefined
  }

  const raw = asRecord(value)
  const copyToWasm = maybeOpenTiming(raw.copyToWasm)
  const librawOpen = maybeOpenTiming(raw.librawOpen)
  if (copyToWasm === undefined || librawOpen === undefined) {
    return undefined
  }

  return {
    copyToWasm,
    librawOpen,
  }
}

function normalizeRequiredOpenTimings(value: unknown) {
  const timings = normalizeOpenTimings(value)
  if (!timings) {
    throw new TypeError('Native RAW openBuffer returned invalid timing data.')
  }

  return timings
}

function normalizeLoadBufferTimings(value: unknown) {
  if (value === null || value === undefined || typeof value !== 'object') {
    throw new TypeError('Native RAW openBuffer returned invalid timing data.')
  }

  const raw = asRecord(value)

  return {
    copyToWasm: asOpenTiming(raw.copyToWasm, 'copyToWasm'),
  }
}

function normalizeThumbnail(value: unknown) {
  if (value === null || value === undefined) return undefined

  const raw = asRecord(value)
  if (!(raw.data instanceof Uint8Array)) {
    throw new TypeError('Native RAW thumbnail did not return Uint8Array data.')
  }

  const format: NativeThumbnailFormat =
    raw.format === 'jpeg' || raw.format === 'bitmap' ? raw.format : 'unknown'
  const primaryWidth = asOptionalThumbnailDimension(raw.width, 'width')
  const primaryHeight = asOptionalThumbnailDimension(raw.height, 'height')
  const fallbackWidth = asOptionalThumbnailDimension(
    raw.thumbWidth,
    'thumbWidth',
  )
  const fallbackHeight = asOptionalThumbnailDimension(
    raw.thumbHeight,
    'thumbHeight',
  )
  const width =
    primaryWidth === undefined || primaryWidth === 0
      ? (fallbackWidth ?? 0)
      : primaryWidth
  const height =
    primaryHeight === undefined || primaryHeight === 0
      ? (fallbackHeight ?? 0)
      : primaryHeight

  return {
    data: normalizeUint8Output(raw.data, 'thumbnail'),
    width,
    height,
    format,
  }
}

function normalizeImage(value: unknown) {
  const raw = asRecord(value)
  if (!(raw.data instanceof Uint16Array)) {
    throw new TypeError('Native RAW image did not return Uint16Array data.')
  }

  const width = asPositiveInteger(raw.width, 'width')
  const height = asPositiveInteger(raw.height, 'height')
  const expectedLength = width * height * 3

  if (!Number.isSafeInteger(expectedLength)) {
    throw new TypeError('Native RAW image dimensions are too large.')
  }
  if (raw.data.length !== expectedLength) {
    throw new TypeError(
      'Native RAW image data length does not match RGB dimensions.',
    )
  }

  return {
    data: normalizeUint16Output(raw.data, 'image'),
    width,
    height,
    bits: 16 as const,
  }
}

function clampPhase(value: unknown): LumaRawCfaInfo['xPhase'] {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0
  }

  return Math.max(0, Math.min(5, Math.trunc(value))) as LumaRawCfaInfo['xPhase']
}

function normalizeCfa(value: unknown) {
  const raw = asRecord(value)
  const pattern: NativeCfaPattern =
    raw.pattern === 'x-trans' ||
    raw.pattern === 'rggb' ||
    raw.pattern === 'bggr' ||
    raw.pattern === 'grbg' ||
    raw.pattern === 'gbrg'
      ? raw.pattern
      : 'unsupported'

  return {
    pattern,
    xPhase: clampPhase(raw.xPhase),
    yPhase: clampPhase(raw.yPhase),
  } as const
}

function normalizeUnsupportedReasons(
  value: unknown,
): LumaRawExportUnsupportedReason[] {
  if (!Array.isArray(value)) return []

  const reasons = value.filter(
    (reason): reason is LumaRawExportUnsupportedReason =>
      reason === 'libraw-open-failed' ||
      reason === 'libraw-unpack-failed' ||
      reason === 'libraw-cropbox-window-unavailable' ||
      reason === 'libraw-cropbox-not-repeatable' ||
      reason === 'orientation-transform-unimplemented' ||
      reason === 'unsupported-sensor-layout' ||
      reason === 'unsupported-cfa-pattern' ||
      reason === 'missing-camera-white-balance' ||
      reason === 'missing-camera-to-output-color' ||
      reason === 'degenerate-camera-to-output-color' ||
      reason === 'processed-window-unavailable' ||
      reason === 'raw-window-unavailable-after-unpack' ||
      reason === 'jpeg-runtime-unavailable' ||
      reason === 'unsupported-source' ||
      reason === 'unsupported-cfa' ||
      reason === 'compressed-raw-window-unavailable' ||
      reason === 'raw-window-unavailable' ||
      reason === 'missing-dimensions' ||
      reason === 'missing-levels' ||
      reason === 'missing-visible-crop' ||
      reason === 'unsupported-orientation' ||
      reason === 'missing-color-transform' ||
      reason === 'missing-export-facts',
  )

  return [...new Set(reasons)]
}

function normalizeVisibleCrop(
  value: unknown,
  rawWidth: number,
  rawHeight: number,
): LumaRawVisibleCrop | undefined {
  const raw = asRecord(value)
  const x = asNonNegativeIntegerOrUndefined(raw.x)
  const y = asNonNegativeIntegerOrUndefined(raw.y)
  const width = asPositiveIntegerOrUndefined(raw.width)
  const height = asPositiveIntegerOrUndefined(raw.height)

  if (
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined
  ) {
    return undefined
  }
  if (
    rawWidth <= 0 ||
    rawHeight <= 0 ||
    x + width > rawWidth ||
    y + height > rawHeight
  ) {
    return undefined
  }

  return { x, y, width, height }
}

function normalizeExportOrientation(
  value: unknown,
  options: { allowRuntimeAppliedOrientation?: boolean } = {},
): LumaRawExportOrientation | undefined {
  // Capability orientation is the native orientation record. A bare number is
  // not one: it says nothing about whether the processed window applies the
  // rotation, so it leaves the capability without orientation facts.
  const raw = asRecord(value)
  const code = asPositiveIntegerOrUndefined(raw.code)
  if (code === undefined) return undefined

  const orientation: LumaRawExportOrientation = {
    code,
    supported:
      raw.supported === true &&
      (code === 1 || options.allowRuntimeAppliedOrientation === true),
  }

  const outputWidth = asPositiveIntegerOrUndefined(raw.outputWidth)
  const outputHeight = asPositiveIntegerOrUndefined(raw.outputHeight)
  if (outputWidth !== undefined) orientation.outputWidth = outputWidth
  if (outputHeight !== undefined) orientation.outputHeight = outputHeight

  return orientation
}

function normalizeFiniteTuple(value: unknown, length: number) {
  if (!Array.isArray(value) || value.length !== length) return undefined

  const numbers = value.map(asFiniteNumberOrUndefined)
  return numbers.every((number) => number !== undefined)
    ? (numbers as number[])
    : undefined
}

function hasUsableMatrix3x3(values: number[]) {
  const determinant =
    values[0] * (values[4] * values[8] - values[5] * values[7]) -
    values[1] * (values[3] * values[8] - values[5] * values[6]) +
    values[2] * (values[3] * values[7] - values[4] * values[6])

  return Math.abs(determinant) > 1e-12
}

function normalizeExportSensorFacts(
  value: unknown,
  fallbackCfa: LumaRawCfaInfo,
): LumaRawExportSensorFacts {
  const raw = asRecord(value)
  const cfa = raw.cfa == null ? fallbackCfa : normalizeCfa(raw.cfa)
  const layout =
    raw.layout === 'bayer' ||
    raw.layout === 'x-trans' ||
    raw.layout === 'foveon' ||
    raw.layout === 'monochrome' ||
    raw.layout === 'rgb-like' ||
    raw.layout === 'unknown'
      ? raw.layout
      : fallbackCfa.pattern === 'x-trans'
        ? 'x-trans'
        : fallbackCfa.pattern === 'unsupported'
          ? 'unknown'
          : 'bayer'
  const colorCount = asPositiveIntegerOrUndefined(raw.colorCount) ?? 3

  return {
    layout,
    colorCount,
    cfa,
    phaseIsWindowLocal: raw.phaseIsWindowLocal === true,
  }
}

function normalizeExportDiagnostics(
  value: unknown,
  supported: boolean,
): LumaRawExportDiagnostics {
  const raw = asRecord(value)
  const diagnostics: LumaRawExportDiagnostics = {
    hasRawImage:
      typeof raw.hasRawImage === 'boolean' ? raw.hasRawImage : supported,
    hasColor3Image:
      typeof raw.hasColor3Image === 'boolean' ? raw.hasColor3Image : false,
    hasColor4Image:
      typeof raw.hasColor4Image === 'boolean' ? raw.hasColor4Image : false,
    hasXTransTable:
      typeof raw.hasXTransTable === 'boolean' ? raw.hasXTransTable : false,
  }

  if (typeof raw.make === 'string') diagnostics.make = raw.make
  if (typeof raw.model === 'string') diagnostics.model = raw.model
  if (typeof raw.normalizedMake === 'string') {
    diagnostics.normalizedMake = raw.normalizedMake
  }
  if (typeof raw.normalizedModel === 'string') {
    diagnostics.normalizedModel = raw.normalizedModel
  }
  if (typeof raw.librawFilterCode === 'number') {
    diagnostics.librawFilterCode = raw.librawFilterCode
  }
  if (typeof raw.canRepeatCropProcess === 'boolean') {
    diagnostics.canRepeatCropProcess = raw.canRepeatCropProcess
  }
  if (typeof raw.lastLibRawWarningMask === 'number') {
    diagnostics.lastLibRawWarningMask = raw.lastLibRawWarningMask
  }

  return diagnostics
}

function normalizeExportColorFacts(
  value: unknown,
): LumaRawExportColorFacts | undefined {
  // Every color fact is read as the native wrapper writes it. An absent or
  // malformed fact leaves the capability without color facts; nothing is
  // defaulted, renamed, or inferred from another fact.
  const raw = asRecord(value)
  const whiteBalance = normalizeFiniteTuple(raw.whiteBalance, 4)
  const cameraToWorkingRgb = normalizeFiniteTuple(raw.cameraToWorkingRgb, 9)

  if (
    raw.workingSpace !== 'linear-prophoto-rgb' ||
    raw.librawOutputColor !== 'prophoto' ||
    raw.gamma !== 'linear' ||
    typeof raw.cameraWhiteBalanceAppliedByRuntime !== 'boolean' ||
    typeof raw.cameraMatrixAppliedByRuntime !== 'boolean' ||
    whiteBalance === undefined ||
    !whiteBalance.every((value) => value > 0) ||
    cameraToWorkingRgb === undefined ||
    !hasUsableMatrix3x3(cameraToWorkingRgb)
  ) {
    return undefined
  }

  return {
    workingSpace: 'linear-prophoto-rgb',
    librawOutputColor: 'prophoto',
    gamma: 'linear',
    cameraWhiteBalanceAppliedByRuntime: raw.cameraWhiteBalanceAppliedByRuntime,
    cameraMatrixAppliedByRuntime: raw.cameraMatrixAppliedByRuntime,
    whiteBalance: whiteBalance as [number, number, number, number],
    cameraToWorkingRgb: cameraToWorkingRgb as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ],
  }
}

export function normalizeExportCapability(
  value: unknown,
): LumaRawExportCapability {
  const raw = asRecord(value)
  const width = asNonNegativeIntegerOrUndefined(raw.width) ?? 0
  const height = asNonNegativeIntegerOrUndefined(raw.height) ?? 0
  const rawWidth = asNonNegativeIntegerOrUndefined(raw.rawWidth) ?? 0
  const rawHeight = asNonNegativeIntegerOrUndefined(raw.rawHeight) ?? 0
  const visibleCrop = normalizeVisibleCrop(raw.visibleCrop, rawWidth, rawHeight)
  const cfa = normalizeCfa(raw.cfa)
  const sensor = normalizeExportSensorFacts(raw.sensor, cfa)
  const rawLevels = asRecord(raw.levels)
  const blackLevel =
    asFiniteNumberOrUndefined(raw.blackLevel) ??
    asFiniteNumberOrUndefined(rawLevels.black)
  const whiteLevel =
    asFiniteNumberOrUndefined(raw.whiteLevel) ??
    asFiniteNumberOrUndefined(rawLevels.white)
  const rawWindows = asRecord(raw.windows)
  const librawProcessed = rawWindows.librawProcessed === true
  const orientation = normalizeExportOrientation(raw.orientation, {
    allowRuntimeAppliedOrientation:
      raw.strategy === 'libraw-processed-window' || librawProcessed,
  })
  const color = normalizeExportColorFacts(raw.color)
  const normalizedReasons = normalizeUnsupportedReasons(raw.reasons)
  const reasons = new Set<LumaRawExportUnsupportedReason>(normalizedReasons)
  let supported = raw.supported === true
  let missingFactCount = 0

  if (
    cfa.pattern === 'unsupported' &&
    sensor.layout !== 'foveon' &&
    sensor.layout !== 'monochrome' &&
    sensor.layout !== 'rgb-like'
  ) {
    supported = false
    reasons.add('unsupported-cfa')
  }

  if (width <= 0 || height <= 0 || rawWidth <= 0 || rawHeight <= 0) {
    supported = false
    reasons.add('missing-dimensions')
  }

  if (blackLevel === undefined || whiteLevel === undefined) {
    supported = false
    reasons.add('missing-levels')
  }

  if (raw.supported === true) {
    if (!librawProcessed) {
      reasons.add('processed-window-unavailable')
    }
    if (!visibleCrop) {
      missingFactCount += 1
      reasons.add('missing-visible-crop')
    }
    if (!orientation?.supported) {
      reasons.add('unsupported-orientation')
    }
    if (!color) {
      missingFactCount += 1
      reasons.add('missing-color-transform')
    } else {
      if (!color.cameraWhiteBalanceAppliedByRuntime) {
        reasons.add('missing-camera-white-balance')
      }
      if (!color.cameraMatrixAppliedByRuntime) {
        reasons.add('missing-camera-to-output-color')
      }
    }
    if (missingFactCount > 1) {
      reasons.add('missing-export-facts')
    }
  }

  if (reasons.size > 0) {
    supported = false
  }

  const capability: LumaRawExportCapability = {
    supported,
    width,
    height,
    rawWidth,
    rawHeight,
    cfa,
    blackLevel: blackLevel ?? 0,
    whiteLevel: whiteLevel ?? 0,
    sensor,
    windows: { librawProcessed },
    diagnostics: normalizeExportDiagnostics(raw.diagnostics, supported),
    reasons: [...reasons],
  }

  if (raw.strategy === 'libraw-processed-window') {
    capability.strategy = raw.strategy
  }
  if (visibleCrop) capability.visibleCrop = visibleCrop
  if (orientation) capability.orientation = orientation
  if (color) capability.color = color
  if (blackLevel !== undefined && whiteLevel !== undefined) {
    const perChannelBlack = normalizeFiniteTuple(rawLevels.perChannelBlack, 4)
    capability.levels = { black: blackLevel, white: whiteLevel }
    if (perChannelBlack) {
      capability.levels.perChannelBlack = perChannelBlack as [
        number,
        number,
        number,
        number,
      ]
    }
  }

  return capability
}

function normalizeWindowRect(value: unknown): LumaRawWindowRect {
  const raw = asRecord(value)

  return {
    x: asNonNegativeInteger(raw.x, 'x'),
    y: asNonNegativeInteger(raw.y, 'y'),
    width: asPositiveInteger(raw.width, 'width'),
    height: asPositiveInteger(raw.height, 'height'),
  }
}

function normalizeProcessedWindowTimings(
  value: unknown,
): LumaRawProcessedWindowTimings | undefined {
  if (value === undefined || value === null) return undefined

  const raw = asRecord(value)
  const total = asNonNegativeFiniteTiming(raw.total, 'total')

  return {
    setup: asOptionalNonNegativeFiniteTiming(raw, 'setup'),
    open: asOptionalNonNegativeFiniteTiming(raw, 'open'),
    unpack: asOptionalNonNegativeFiniteTiming(raw, 'unpack'),
    process: asOptionalNonNegativeFiniteTiming(raw, 'process'),
    outputCopy: asOptionalNonNegativeFiniteTiming(raw, 'outputCopy'),
    orientation: asOptionalNonNegativeFiniteTiming(raw, 'orientation'),
    total,
  }
}

function normalizeProcessedWindow(value: unknown): LumaRawProcessedWindow {
  const raw = asRecord(value)
  const rect = normalizeWindowRect(raw.rect)
  const timings = normalizeProcessedWindowTimings(raw.timings)

  if (!(raw.data instanceof Uint16Array)) {
    throw new TypeError(
      'Native RAW processed-window did not return Uint16Array data.',
    )
  }

  const width = asPositiveInteger(raw.width, 'width')
  const height = asPositiveInteger(raw.height, 'height')
  const stride = asPositiveInteger(raw.stride, 'stride')
  if (raw.workingSpace !== 'linear-prophoto-rgb') {
    throw new TypeError(
      'Native RAW processed-window returned invalid workingSpace.',
    )
  }
  if (raw.normalized !== false) {
    throw new TypeError(
      'Native RAW processed-window returned invalid normalized flag.',
    )
  }
  if (raw.orientationApplied !== true) {
    throw new TypeError(
      'Native RAW processed-window returned invalid orientationApplied flag.',
    )
  }
  if (raw.colorApplied !== true) {
    throw new TypeError(
      'Native RAW processed-window returned invalid colorApplied flag.',
    )
  }
  if (
    !Array.isArray(raw.warnings) ||
    !raw.warnings.every((warning) => typeof warning === 'string')
  ) {
    throw new TypeError(
      'Native RAW processed-window returned invalid warnings.',
    )
  }
  if (rect.width !== width || rect.height !== height) {
    throw new TypeError(
      'Native RAW processed-window dimensions do not match rect dimensions.',
    )
  }
  const expectedStride = width * 3
  if (stride < expectedStride) {
    throw new TypeError('Native RAW processed-window returned invalid stride.')
  }

  const expectedLength = expectedStride * height
  if (!Number.isSafeInteger(expectedLength)) {
    throw new TypeError('Native RAW processed-window dimensions are too large.')
  }
  if (raw.data.length !== expectedLength) {
    throw new TypeError(
      'Native RAW processed-window data length does not match RGB dimensions.',
    )
  }
  if (stride !== expectedStride) {
    throw new TypeError('Native RAW processed-window returned invalid stride.')
  }

  return {
    rect,
    workingSpace: 'linear-prophoto-rgb',
    data: normalizeUint16Output(raw.data, 'processed-window'),
    width,
    height,
    stride,
    normalized: false,
    orientationApplied: true,
    colorApplied: true,
    warnings: raw.warnings,
    ...(timings ? { timings } : {}),
  }
}

export function createNativeFactory(
  module: EmbindModule,
): LumaRawNativeFactory {
  return {
    createProcessor(): LumaRawNativeProcessor {
      const processor = new module.LumaRawProcessor()

      const adapted: LumaRawNativeProcessor = {
        loadBuffer(data) {
          if (!processor.loadBuffer) {
            throw new TypeError(
              'Native RAW openBuffer returned invalid timing data.',
            )
          }
          return normalizeLoadBufferTimings(processor.loadBuffer(data))
        },
        openWithSettings(settings) {
          if (!processor.openWithSettings) {
            throw new TypeError(
              'Native RAW openBuffer returned invalid timing data.',
            )
          }
          return normalizeRequiredOpenTimings(
            processor.openWithSettings(settings),
          )
        },
        readMetadata() {
          return normalizeMetadata(processor.readMetadata())
        },
        extractThumbnail() {
          return normalizeThumbnail(processor.extractThumbnail())
        },
        probeExportCapability() {
          if (!processor.probeExportCapability) {
            return {
              supported: false,
              width: 0,
              height: 0,
              rawWidth: 0,
              rawHeight: 0,
              cfa: { pattern: 'unsupported', xPhase: 0, yPhase: 0 },
              blackLevel: 0,
              whiteLevel: 0,
              orientation: { code: 1, supported: true },
              sensor: {
                layout: 'unknown',
                colorCount: 0,
                cfa: { pattern: 'unsupported', xPhase: 0, yPhase: 0 },
                phaseIsWindowLocal: false,
              },
              windows: { librawProcessed: false },
              diagnostics: {
                hasRawImage: false,
                hasColor3Image: false,
                hasColor4Image: false,
                hasXTransTable: false,
              },
              reasons: ['raw-window-unavailable'],
            }
          }

          return normalizeExportCapability(processor.probeExportCapability())
        },
        decodePreview(options) {
          return normalizeImage(
            processor.decodePreview(normalizeDecodeOptions(options)),
          )
        },
        decodeHq(options) {
          return normalizeImage(
            processor.decodeHq(normalizeDecodeOptions(options)),
          )
        },
        dispose() {
          processor.delete?.()
        },
      }

      if (processor.readProcessedWindow) {
        adapted.readProcessedWindow = (request) => {
          if (!processor.readProcessedWindow) {
            throw new TypeError(
              'Native RAW processed-window access is unavailable.',
            )
          }

          return normalizeProcessedWindow(
            processor.readProcessedWindow(request),
          )
        }
      }
      if (processor.applyCalibration) {
        adapted.applyCalibration = (
          payload: LumaRawNativeCalibrationPayload,
        ) => {
          if (!processor.applyCalibration) {
            throw new TypeError(
              'Native RAW calibration application is unavailable.',
            )
          }

          if (!(payload.xyzToCamera instanceof Float32Array)) {
            throw new TypeError(
              'Native RAW calibration payload xyzToCamera must be a Float32Array.',
            )
          }
          if (payload.xyzToCamera.length !== 9) {
            throw new TypeError(
              'Native RAW calibration payload xyzToCamera must have length 9.',
            )
          }
          for (let index = 0; index < 9; index += 1) {
            if (!Number.isFinite(payload.xyzToCamera[index])) {
              throw new TypeError(
                'Native RAW calibration payload xyzToCamera must contain finite values.',
              )
            }
          }

          // Embind val("number[]") accepts plain JS arrays. Convert from
          // Float32Array once at the boundary instead of marshaling the typed
          // array element-by-element across the JS<->Wasm bridge.
          const params: EmbindCalibrationParams = {
            xyzToCamera: Array.from(payload.xyzToCamera),
          }
          if (payload.toneCurveLut) {
            if (!(payload.toneCurveLut instanceof Float32Array)) {
              throw new TypeError(
                'Native RAW calibration payload toneCurveLut must be a Float32Array.',
              )
            }
            if (payload.toneCurveLut.length < 4096) {
              throw new TypeError(
                'Native RAW calibration payload toneCurveLut must have at least 4096 entries.',
              )
            }
            params.toneCurveLut = Array.from(payload.toneCurveLut)
          }

          processor.applyCalibration(params)
        }
      }

      return adapted
    },
    heapBytes() {
      const heap = (module as unknown as { HEAPU8?: Uint8Array }).HEAPU8
      return heap ? heap.buffer.byteLength : undefined
    },
  }
}

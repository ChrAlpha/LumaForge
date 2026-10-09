export const LIMITS = Object.freeze({
  // Presented canvas vs the processed texture it samples.
  maxByteError: 2,
  meanByteError: 0.25,
  // WebGPU preview vs the TS export executor, in 8-bit display code values.
  referenceMaxByteError: 2,
  referenceMeanByteError: 0.1,
  // WebGPU preview vs frozen WebGL output, for paths export does not cover.
  goldenMaxByteError: 2,
  goldenMeanByteError: 0.25,
})

/** Linear ProPhoto rgb-u16, the only frame layout the app decodes RAW into. */
export function makeImage(width = 97, height = 65) {
  const channels = 3
  const data = new Uint16Array(width * height * channels)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * channels
      // Asymmetric axes and corner colors detect flips, transposes and channel swaps.
      const rgb = [
        0.02 + (0.91 * x) / (width - 1),
        0.03 + (0.79 * y) / (height - 1),
        0.01 + (0.63 * ((x * 7 + y * 3) % 31)) / 30,
      ]
      if (x < 8 && y < 8) rgb.splice(0, 3, 0.9, 0.1, 0.05)
      if (x >= width - 8 && y >= height - 8) rgb.splice(0, 3, 0.05, 0.15, 0.8)
      for (let channel = 0; channel < 3; channel++)
        data[offset + channel] = Math.round(rgb[channel] * 65535)
    }
  }
  return {
    data,
    width,
    height,
    layout: 'rgb-u16',
    colorSpace: 'linear-prophoto-rgb',
    renderExposureEv: 0.4,
    renderExposureMultiplier: 2 ** 0.4,
  }
}

export function makeLut(
  role = 'display-look',
  inputTransfer = 'srgb',
  legal = false,
) {
  const size = 5
  const data = new Float32Array(size ** 3 * 3)
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const offset = (b * size * size + g * size + r) * 3
        data[offset] = 0.08 + 0.84 * (r / (size - 1)) ** 0.9
        data[offset + 1] = 0.03 + (0.9 * g) / (size - 1)
        data[offset + 2] = 0.05 + 0.8 * (b / (size - 1)) ** 1.1
      }
  const profile = {
    id: `validation-${role}-${inputTransfer}`,
    label: 'Synthetic validation profile',
    role,
    inputGamut: role === 'display-look' ? 'srgb-rec709' : 'rec2020',
    inputTransfer,
    inputRange: legal ? 'legal' : 'full',
    outputGamut: 'srgb-rec709',
    outputTransfer: 'srgb',
    outputRange: legal ? 'legal' : 'full',
    aliases: [],
  }
  return {
    size,
    data,
    domainMin: [0, 0, 0],
    domainMax: [1, 1, 1],
    profileResolution: { kind: 'confirmed', profile, confidence: 'user' },
  }
}

export function scenarios(transferIds = []) {
  const result = [{ name: 'neutral', params: {} }]
  for (const preset of [
    'neutral',
    'warm',
    'cool',
    'film-soft',
    'film-contrast',
    'cinematic',
    'fade',
    'mono',
  ]) {
    result.push({
      name: `preset-${preset}`,
      params: { styleKind: 'builtin', builtinPreset: preset, intensity: 0.83 },
    })
  }
  result.push(
    {
      name: 'tone',
      params: {
        userExposureEv: 0.4,
        userContrast: 32,
        userHighlights: -35,
        userShadows: 22,
        userWhites: -17,
        userBlacks: 15,
      },
    },
    { name: 'color-balance', params: { userTemperature: 37, userTint: -24 } },
    {
      name: 'saturation-boost',
      params: { userSaturation: 55, userVibrance: 65 },
    },
    {
      name: 'saturation-cut',
      params: { userSaturation: -52, userVibrance: -42 },
    },
    {
      name: 'selective-color',
      params: {
        selectiveColor: Object.fromEntries(
          [
            'red',
            'orange',
            'yellow',
            'green',
            'aqua',
            'blue',
            'purple',
            'magenta',
          ].map((band, index) => [
            band,
            {
              hue: index % 2 ? 42 : -27,
              saturation: index % 3 ? 33 : -19,
              lightness: index % 2 ? -16 : 12,
            },
          ]),
        ),
      },
    },
    {
      name: 'original',
      params: { viewMode: 'original', userExposureEv: 1, userContrast: 40 },
    },
  )
  for (const [role, transfer, legal] of [
    ['display-look', 'srgb', false],
    ['scene-creative', 'n-log', false],
    ['combined-look-output', 's-log3', true],
    ['technical-output', 'acescct', false],
  ]) {
    for (const intensity of [0.71, 1])
      result.push({
        name: `lut-${role}${intensity === 1 ? '-full' : ''}`,
        lut: makeLut(role, transfer, legal),
        params: { styleKind: 'custom', intensity },
      })
  }
  // Display looks may declare a wider output gamut; export converts it to sRGB.
  for (const outputGamut of ['display-p3', 'rec2020']) {
    const wide = makeLut('display-look', 'srgb')
    wide.profileResolution.profile.outputGamut = outputGamut
    result.push({
      name: `lut-display-look-${outputGamut}-output`,
      lut: wide,
      params: { styleKind: 'custom', intensity: 1 },
    })
  }
  const domain = makeLut()
  domain.domainMin = [-0.15, -0.05, -0.2]
  domain.domainMax = [0.7, 0.9, 0.8]
  result.push({
    name: 'lut-nonunit-domain',
    lut: domain,
    params: { styleKind: 'custom', intensity: 1 },
  })
  for (const transfer of transferIds) {
    const input = makeLut('display-look', transfer)
    const output = makeLut('display-look', 'srgb')
    output.profileResolution.profile.outputTransfer = transfer
    result.push(
      {
        name: `transfer-input-${transfer}`,
        lut: input,
        params: { styleKind: 'custom', intensity: 1 },
      },
      {
        name: `transfer-output-${transfer}`,
        lut: output,
        params: { styleKind: 'custom', intensity: 1 },
        // Export refuses a linear LUT output.
        ...(transfer === 'linear' ? { exportRefused: true } : {}),
      },
    )
  }
  result.push(...refusedLutScenarios())
  return result
}

/** Non-neutral user color, so a preview that drops it with the look shows. */
export const ADJUSTED_USER_COLOR = Object.freeze({
  userExposureEv: 0.35,
  userContrast: 18,
  userHighlights: -22,
  userShadows: 16,
  userWhites: -8,
  userBlacks: 6,
  userTemperature: 21,
  userTint: -9,
  userSaturation: 14,
  userVibrance: 11,
  selectiveColor: {
    orange: { hue: 12, saturation: -18, lightness: 6 },
    blue: { hue: -9, saturation: 15, lightness: -4 },
  },
})

/**
 * Custom LUTs whose contract export refuses, at partial strength over adjusted
 * user color. The preview drops only the look: it keeps the user color and the
 * RAW render exposure, and export keeps refusing the selection.
 */
export function refusedLutScenarios() {
  const linearDisplay = makeLut('display-look', 'srgb')
  linearDisplay.profileResolution.profile.outputTransfer = 'linear'
  const linearTechnical = makeLut('technical-output', 'acescct')
  linearTechnical.profileResolution.profile.outputGamut = 'rec2020'
  linearTechnical.profileResolution.profile.outputTransfer = 'linear'
  const unknownRange = makeLut('display-look', 'srgb')
  unknownRange.profileResolution.profile.outputRange = 'unknown'
  const missingOutput = makeLut('combined-look-output', 's-log3', true)
  missingOutput.profileResolution.profile.outputTransfer = undefined
  const unconfirmed = makeLut('scene-creative', 'n-log')
  unconfirmed.profileResolution = {
    kind: 'recommended',
    recommendations: [unconfirmed.profileResolution.profile],
  }
  return [
    ['display-linear-output', linearDisplay, 0.63],
    ['technical-linear-output', linearTechnical, 0.37],
    ['output-range-unknown', unknownRange, 0.81],
    ['output-profile-missing', missingOutput, 0.52],
    ['input-unconfirmed', unconfirmed, 0.44],
  ].map(([name, lut, intensity]) => ({
    name: `lut-refused-${name}`,
    lut,
    params: { ...ADJUSTED_USER_COLOR, styleKind: 'custom', intensity },
    exportRefused: true,
  }))
}

export function pixelDiff(actual, expected, channels = 4) {
  if (actual.length !== expected.length)
    throw new Error(
      `PIXEL_LENGTH_MISMATCH: ${actual.length} vs ${expected.length}`,
    )
  let max = 0
  let sum = 0
  let squared = 0
  let count = 0
  let changed = 0
  let nonfinite = 0
  for (let index = 0; index < actual.length; index++) {
    if (channels === 4 && index % 4 === 3) continue
    const error = Math.abs(actual[index] - expected[index])
    if (!Number.isFinite(error)) nonfinite++
    max = Math.max(max, error)
    sum += error
    squared += error * error
    count++
    if (error > 0) changed++
  }
  return {
    max,
    mean: sum / count,
    rms: Math.sqrt(squared / count),
    changed,
    samples: count,
    nonfinite,
  }
}

/** Quantize processed float RGBA the way the canvas and JPEG encoder do. */
export function toDisplayBytes(pixels) {
  const bytes = new Uint8ClampedArray(pixels.length)
  for (let index = 0; index < pixels.length; index++)
    bytes[index] = Math.round(pixels[index] * 255)
  return bytes
}

export function readCanvas(canvas) {
  const copy = document.createElement('canvas')
  copy.width = canvas.width
  copy.height = canvas.height
  const context = copy.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('VALIDATION_2D_CONTEXT_MISSING')
  context.drawImage(canvas, 0, 0)
  return context.getImageData(0, 0, copy.width, copy.height).data
}

export async function readPresentedCanvas(canvas) {
  // Read the compositor screenshot, since WebGPU's drawing buffer may already
  // have been recycled after presentation even while the visible image remains.
  const base64 = await window.__captureValidationCanvas(
    canvas.dataset.validationId,
  )
  const bytes = Uint8Array.from(atob(base64), (character) =>
    character.charCodeAt(0),
  )
  const bitmap = await createImageBitmap(
    new Blob([bytes], { type: 'image/png' }),
  )
  const copy = document.createElement('canvas')
  copy.width = bitmap.width
  copy.height = bitmap.height
  const context = copy.getContext('2d')
  context.drawImage(bitmap, 0, 0)
  bitmap.close()
  return context.getImageData(0, 0, copy.width, copy.height).data
}

export function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const percentile = (p) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
  return {
    count: values.length,
    min: sorted[0],
    median: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1),
    mean: values.reduce((a, b) => a + b, 0) / values.length,
  }
}

// Built-in styles have no TS executor, so they are held to frozen WebGL
// output from the last checkout that had both renderers. Every other scene is
// compared to the TS export executor, or, for LUTs export refuses, to its
// graph with the look stripped.
export const GOLDEN_STRIDE = 3

export function isGoldenScenario(name) {
  return /^u16\/preset-/.test(name)
}

/** RGB bytes of every `stride`-th pixel in both axes of an RGBA frame. */
export function subsampleRgb(rgba, width, height, stride = GOLDEN_STRIDE) {
  const out = []
  for (let y = 0; y < height; y += stride)
    for (let x = 0; x < width; x += stride) {
      const offset = (y * width + x) * 4
      out.push(rgba[offset], rgba[offset + 1], rgba[offset + 2])
    }
  return Uint8Array.from(out)
}

export function bytesToBase64(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function base64ToBytes(base64) {
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
}

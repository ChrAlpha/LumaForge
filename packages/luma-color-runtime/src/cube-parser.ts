import {
  resolveLUTProfile,
  toCompatInputProfile,
} from './lut-profile-resolution'
import type { LUTColorProfile } from './registry'
import type {
  LumaColorLUTData,
  LUTContractResolution,
  LUTInputProfile,
} from './types'

export interface ParsedLUT {
  title: string
  sourceName?: string
  comments: string[]
  size: number
  domainMin: [number, number, number]
  domainMax: [number, number, number]
  data: Float32Array
  fingerprint: string
  profileResolution: LUTContractResolution
  inputProfile: LUTInputProfile
  /** SHA-256 of the source .cube bytes when the caller recorded it (content identity for manifests). */
  sha256?: string
}

export interface ParseCubeOptions {
  sourceName?: string
  lookupStoredProfile?: (fingerprint: string) => LUTColorProfile | undefined
}

const CUBE_FLOAT_PATTERN = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?'
const CUBE_DATA_LINE_RE = new RegExp(
  `^${CUBE_FLOAT_PATTERN}\\s+${CUBE_FLOAT_PATTERN}\\s+${CUBE_FLOAT_PATTERN}(?:\\s|$)`,
  'i',
)
const DOMAIN_MIN_RE = new RegExp(
  `DOMAIN_MIN\\s+(${CUBE_FLOAT_PATTERN})\\s+(${CUBE_FLOAT_PATTERN})\\s+(${CUBE_FLOAT_PATTERN})`,
  'i',
)
const DOMAIN_MAX_RE = new RegExp(
  `DOMAIN_MAX\\s+(${CUBE_FLOAT_PATTERN})\\s+(${CUBE_FLOAT_PATTERN})\\s+(${CUBE_FLOAT_PATTERN})`,
  'i',
)

function stripCubeExtension(name: string): string {
  return name.replace(/\.cube$/i, '')
}

function createStableHash(value: string): string {
  let hash = 0x811C9DC5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x0100_0193)
  }

  return (hash >>> 0).toString(36)
}

function createLUTFingerprint(input: {
  content?: string
  title: string
  size: number
  domainMin: [number, number, number]
  domainMax: [number, number, number]
  comments: string[]
  data: Float32Array
}): string {
  const fullData =
    input.content ??
    Array.from(input.data, (value) => value.toPrecision(8)).join(',')
  const fingerprintSource = [
    input.title,
    input.size,
    input.domainMin.join(','),
    input.domainMax.join(','),
    input.comments.join('\n'),
    input.data.length,
    fullData,
  ].join('')

  return `lut-${createStableHash(fingerprintSource)}`
}

export function parseCubeLUT(
  content: string,
  options: ParseCubeOptions = {},
): ParsedLUT {
  const lines = content.split(/\r?\n/)

  let title = ''
  let size = 0
  let domainMin: [number, number, number] = [0, 0, 0]
  let domainMax: [number, number, number] = [1, 1, 1]
  const comments: string[] = []
  const dataLines: string[] = []
  let inData = false

  for (const rawLine of lines) {
    const line = rawLine.trim()

    if (!line) continue
    if (line.startsWith('#')) {
      const comment = line.replace(/^#+\s?/, '').trim()
      if (comment) comments.push(comment)
      continue
    }

    if (line.startsWith('TITLE')) {
      const match = line.match(/TITLE\s+"?([^"]*)"?/)
      if (match) title = match[1]
      continue
    }

    if (line.startsWith('LUT_3D_SIZE')) {
      const match = line.match(/LUT_3D_SIZE\s+(\d+)/)
      if (match) size = Number.parseInt(match[1], 10)
      inData = true
      continue
    }

    if (line.startsWith('DOMAIN_MIN')) {
      const match = line.match(DOMAIN_MIN_RE)
      if (match) {
        domainMin = [
          Number.parseFloat(match[1]),
          Number.parseFloat(match[2]),
          Number.parseFloat(match[3]),
        ]
      }
      continue
    }

    if (line.startsWith('DOMAIN_MAX')) {
      const match = line.match(DOMAIN_MAX_RE)
      if (match) {
        domainMax = [
          Number.parseFloat(match[1]),
          Number.parseFloat(match[2]),
          Number.parseFloat(match[3]),
        ]
      }
      continue
    }

    if (
      line.startsWith('LUT_1D_SIZE') ||
      line.startsWith('LUT_1D_INPUT_RANGE') ||
      line.startsWith('LUT_3D_INPUT_RANGE')
    ) {
      continue
    }

    if (inData && CUBE_DATA_LINE_RE.test(line)) {
      dataLines.push(line)
    }
  }

  if (size === 0) {
    throw new Error('Invalid .cube file: LUT_3D_SIZE not found')
  }

  const expectedEntries = size * size * size
  if (dataLines.length < expectedEntries) {
    throw new Error(
      `Invalid .cube file: expected ${expectedEntries} entries, got ${dataLines.length}`,
    )
  }

  const data = new Float32Array(size * size * size * 3)

  for (let i = 0; i < expectedEntries; i++) {
    const values = dataLines[i]
      .trim()
      .split(/\s+/)
      .map((v) => Number.parseFloat(v))

    if (values.length < 3) {
      throw new Error(`Invalid data at line ${i}: ${dataLines[i]}`)
    }

    data[i * 3 + 0] = values[0]
    data[i * 3 + 1] = values[1]
    data[i * 3 + 2] = values[2]
  }

  const resolvedTitle =
    title ||
    (options.sourceName
      ? stripCubeExtension(options.sourceName)
      : 'Untitled LUT')
  const fingerprint = createLUTFingerprint({
    content,
    title,
    size,
    domainMin,
    domainMax,
    comments,
    data,
  })
  const profileResolution = resolveLUTProfile({
    title: resolvedTitle,
    sourceName: options.sourceName,
    comments,
    fingerprint,
    lookupStoredProfile: options.lookupStoredProfile,
  })

  return {
    title: resolvedTitle,
    sourceName: options.sourceName,
    comments,
    size,
    domainMin,
    domainMax,
    data,
    fingerprint,
    profileResolution,
    inputProfile: toCompatInputProfile(profileResolution),
  }
}

export function toLUTData(parsed: ParsedLUT): LumaColorLUTData {
  return {
    size: parsed.size,
    data: parsed.data,
    domainMin: parsed.domainMin,
    domainMax: parsed.domainMax,
    title: parsed.title,
    inputProfile: parsed.inputProfile,
    profileResolution: parsed.profileResolution,
  }
}

export function validateLUT(lut: ParsedLUT): {
  valid: boolean
  errors: string[]
} {
  const errors: string[] = []

  if (![17, 33, 65].includes(lut.size)) {
    errors.push(
      `Unsupported LUT size: ${lut.size}. Only 17, 33, and 65 are allowed in phase 1.`,
    )
  }

  const expectedLength = lut.size * lut.size * lut.size * 3
  if (lut.data.length !== expectedLength) {
    errors.push(
      `Data length mismatch: expected ${expectedLength}, got ${lut.data.length}`,
    )
  }

  for (let i = 0; i < lut.data.length; i++) {
    if (!Number.isFinite(lut.data[i])) {
      errors.push(`Invalid value at index ${i}: ${lut.data[i]}`)
      break
    }
  }

  return { valid: errors.length === 0, errors }
}

export function generateIdentityLUT(size = 33): ParsedLUT {
  const data = new Float32Array(size * size * size * 3)
  const step = 1 / (size - 1)

  let idx = 0
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        data[idx++] = r * step
        data[idx++] = g * step
        data[idx++] = b * step
      }
    }
  }

  const fingerprint = createLUTFingerprint({
    title: 'Identity',
    size,
    domainMin: [0, 0, 0],
    domainMax: [1, 1, 1],
    comments: [],
    data,
  })
  const profileResolution = resolveLUTProfile({
    title: 'Identity',
    comments: [
      'LUMAFORGE_INPUT_PROFILE=display-srgb',
      'LUMAFORGE_ROLE=display-look',
    ],
  })

  return {
    title: 'Identity',
    comments: [],
    size,
    domainMin: [0, 0, 0],
    domainMax: [1, 1, 1],
    data,
    fingerprint,
    profileResolution,
    inputProfile: toCompatInputProfile(profileResolution),
  }
}

export const SUPPORTED_LUT_EXTENSIONS = new Set(['cube'])

export function isSupportedLUT(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase()
  return ext ? SUPPORTED_LUT_EXTENSIONS.has(ext) : false
}

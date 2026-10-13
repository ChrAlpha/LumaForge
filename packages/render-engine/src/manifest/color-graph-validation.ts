// Closed-record checks for the executable parts of a manifest, used only by
// `parseRenderManifest`: the recorded `color_graph` identity, and the field
// rules the executable `render_params` sections share with it.
//
// A reader replays the color graph a manifest records, so the descriptor must
// be one this engine writes: the current `descriptor_version`, the step
// sequence of a supported export graph, every step with exactly the fields
// that step records, and a fingerprint that hashes the descriptor as given.
// Nothing is defaulted or normalized; an older or unversioned descriptor is
// refused rather than read as current.

import {
  EXPORT_LUT_STEP_KINDS,
  EXPORT_PLAIN_STEP_KINDS,
  HSL_BAND_IDS,
} from '@lumaforge/luma-color-runtime'

import type { ColorGraphDescriptor } from './color-graph-descriptor'
import {
  COLOR_GRAPH_DESCRIPTOR_VERSION,
  fingerprintColorGraph,
} from './color-graph-descriptor'

export type Fields = Readonly<Record<string, unknown>>

/** Receives each issue as a dotted path and a message. */
type IssueReporter = (path: string, message: string) => void

export const SHA256_HEX = /^[0-9a-f]{64}$/

export function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function describeValue(value: unknown): string {
  if (value === undefined) return 'missing'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'string') return `the string ${JSON.stringify(value)}`
  if (typeof value === 'number') return `the number ${String(value)}`
  return `a ${typeof value}`
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

type FieldRule =
  | 'number'
  | 'count'
  | 'string'
  | 'sha256'
  | 'vec3'
  | 'mat3'
  | { readonly oneOf: readonly string[] }
  | { readonly record: FieldRules }

export type FieldRules = Readonly<Record<string, FieldRule>>

function checkNumbers(
  value: unknown,
  length: number,
  path: string,
  report: IssueReporter,
): void {
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    !value.every(isFiniteNumber)
  ) {
    report(path, `must be an array of ${length} finite numbers.`)
  }
}

function checkField(
  value: unknown,
  rule: FieldRule,
  path: string,
  report: IssueReporter,
): void {
  if (typeof rule === 'object') {
    if ('record' in rule) {
      checkRecord(value, rule.record, path, report)
    } else if (typeof value !== 'string' || !rule.oneOf.includes(value)) {
      report(
        path,
        `must be ${rule.oneOf.length === 1 ? '' : 'one of '}${rule.oneOf.map((item) => `"${item}"`).join(', ')}, got ${describeValue(value)}.`,
      )
    }
    return
  }
  switch (rule) {
    case 'number':
      if (!isFiniteNumber(value)) {
        report(path, `must be a finite number, got ${describeValue(value)}.`)
      }
      return
    case 'count':
      if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < 1
      ) {
        report(path, `must be an integer >= 1, got ${describeValue(value)}.`)
      }
      return
    case 'string':
      if (typeof value !== 'string') {
        report(path, `must be a string, got ${describeValue(value)}.`)
      }
      return
    case 'sha256':
      if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
        report(
          path,
          `must be a lowercase hex SHA-256, got ${describeValue(value)}.`,
        )
      }
      return
    case 'vec3':
      checkNumbers(value, 3, path, report)
      return
    case 'mat3':
      checkNumbers(value, 9, path, report)
  }
}

/**
 * Hold a value to exactly `rules`: an object with every listed field present
 * and of its kind, and no field its writer never records.
 */
export function checkRecord(
  value: unknown,
  rules: FieldRules,
  path: string,
  report: IssueReporter,
): void {
  if (!isFields(value)) {
    report(path, `must be an object, got ${describeValue(value)}.`)
    return
  }
  for (const [key, rule] of Object.entries(rules)) {
    checkField(value[key], rule, `${path}.${key}`, report)
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(rules, key)) {
      report(`${path}.${key}`, 'is not a field of this record.')
    }
  }
}

const BAND_SHIFT: FieldRules = {
  hue: 'number',
  saturation: 'number',
  lightness: 'number',
}

/** All eight HSL bands, each with all three axes. */
export const HSL_BANDS: FieldRules = Object.fromEntries(
  HSL_BAND_IDS.map((band) => [band, { record: BAND_SHIFT }]),
)

const LUMINANCE = 'vec3'
const SIGNAL_RANGE = { oneOf: ['full', 'legal', 'unknown'] }

/** The fields each step of a current descriptor records. */
const STEP_FIELDS: Readonly<Record<string, FieldRules>> = {
  'input-linear-prophoto': {},
  'raw-render-exposure': { ev: 'number', multiplier: 'number' },
  'user-color-balance': {
    temperature: 'number',
    tint: 'number',
    gain: 'vec3',
    operator: { oneOf: ['linear-prophoto-relative-rgb-gain'] },
    luminanceCoefficients: LUMINANCE,
  },
  'user-exposure': { ev: 'number', multiplier: 'number' },
  'user-contrast': {
    amount: 'number',
    factor: 'number',
    pivot: 'number',
    operator: { oneOf: ['linear-prophoto-luminance-scale'] },
    luminanceCoefficients: LUMINANCE,
    zeroLuminanceMode: { oneOf: ['return-black'] },
  },
  'user-regional-tone': {
    highlights: 'number',
    shadows: 'number',
    whites: 'number',
    blacks: 'number',
    operator: { oneOf: ['linear-prophoto-log-luminance-regions'] },
    pivot: 'number',
    luminanceCoefficients: LUMINANCE,
    zeroLuminanceMode: { oneOf: ['return-black'] },
  },
  'user-saturation': {
    operator: { oneOf: ['oklab-chroma-with-skin-protection'] },
    saturation: 'number',
    vibrance: 'number',
    satMaxFactor: 'number',
    vibMaxFactor: 'number',
    chromaRef: 'number',
    skinHueCenterDeg: 'number',
    skinHueSigmaDeg: 'number',
    skinProtectStrength: 'number',
  },
  'user-selective-color': {
    bands: { record: HSL_BANDS },
    chromaClampLow: 'number',
    chromaClampHigh: 'number',
    workingSpace: { oneOf: ['oklab-via-prophoto-d65'] },
    operator: { oneOf: ['oklch-per-band-shift'] },
    constantsVersion: 'count',
  },
  'gamut-to-lut-input': { matrix: 'mat3', gamut: 'string' },
  'encode-lut-transfer': { transfer: 'string', range: SIGNAL_RANGE },
  lut3d: {
    size: 'count',
    domain_min: 'vec3',
    domain_max: 'vec3',
    data_length: 'count',
    data_sha256: 'sha256',
    data_encoding: { oneOf: ['float32-le'] },
  },
  'lut-output-to-srgb': {
    matrix: 'mat3',
    transfer: 'string',
    range: SIGNAL_RANGE,
    role: 'string',
    intensity: 'number',
  },
  'output-srgb': {},
}

const CONTRACT: FieldRules = {
  gamut: 'string',
  transfer: 'string',
  range: { oneOf: ['full', 'legal'] },
}
const LUT_PROFILE: FieldRules = {
  role: 'string',
  input: { record: CONTRACT },
  output: { record: CONTRACT },
}

function stepKind(step: unknown): unknown {
  return isFields(step) ? step.kind : undefined
}

function checkSteps(
  steps: unknown,
  appliesLut: boolean,
  path: string,
  report: IssueReporter,
): void {
  if (!Array.isArray(steps)) {
    report(path, `must be an array, got ${describeValue(steps)}.`)
    return
  }
  const expected: readonly string[] = appliesLut
    ? EXPORT_LUT_STEP_KINDS
    : EXPORT_PLAIN_STEP_KINDS
  const kinds = steps.map(stepKind)
  if (
    kinds.length !== expected.length ||
    kinds.some((kind, index) => kind !== expected[index])
  ) {
    report(
      path,
      `must be the ${appliesLut ? 'LUT' : 'plain'} export step sequence ${expected.join(', ')}; got ${kinds.map((kind) => (typeof kind === 'string' ? kind : describeValue(kind))).join(', ') || 'no steps'}.`,
    )
    return
  }
  steps.forEach((step, index) => {
    const kind = expected[index]!
    const { kind: _kind, ...fields } = step as Fields
    checkRecord(fields, STEP_FIELDS[kind]!, `${path}.${index}`, report)
  })
}

function fingerprintOf(descriptor: Fields): string | null {
  try {
    return fingerprintColorGraph(descriptor as ColorGraphDescriptor)
  } catch {
    return null
  }
}

/**
 * Check a recorded `color_graph` identity: a lowercase hex fingerprint over a
 * descriptor of the current version, held to the structure this engine
 * writes. The fingerprint is compared only once the structure holds.
 */
export function checkColorGraphIdentity(
  graph: unknown,
  path: string,
  report: IssueReporter,
): void {
  if (!isFields(graph)) {
    report(path, `must be an object, got ${describeValue(graph)}.`)
    return
  }
  let failed = false
  const track: IssueReporter = (issuePath, message) => {
    failed = true
    report(issuePath, message)
  }
  checkField(graph.fingerprint, 'sha256', `${path}.fingerprint`, track)
  const descriptorPath = `${path}.descriptor`
  const descriptor = graph.descriptor
  if (!isFields(descriptor)) {
    track(
      descriptorPath,
      `must be an object, got ${describeValue(descriptor)}.`,
    )
    return
  }
  if (descriptor.descriptor_version !== COLOR_GRAPH_DESCRIPTOR_VERSION) {
    track(
      `${descriptorPath}.descriptor_version`,
      `must be ${COLOR_GRAPH_DESCRIPTOR_VERSION}, the descriptor version this engine writes and verifies, got ${describeValue(descriptor.descriptor_version)}.`,
    )
    return
  }
  const { steps, lut_profile: lutProfile, ...rest } = descriptor
  checkRecord(
    rest,
    {
      descriptor_version: 'count',
      output_gamut: { oneOf: ['srgb-rec709'] },
      output_transfer: { oneOf: ['srgb'] },
    },
    descriptorPath,
    track,
  )
  if (!Object.hasOwn(descriptor, 'lut_profile')) {
    track(
      `${descriptorPath}.lut_profile`,
      'must be null or an object, got missing.',
    )
  } else if (lutProfile !== null) {
    checkRecord(lutProfile, LUT_PROFILE, `${descriptorPath}.lut_profile`, track)
  }
  checkSteps(steps, lutProfile != null, `${descriptorPath}.steps`, track)
  if (failed) return
  if (fingerprintOf(descriptor) !== graph.fingerprint) {
    report(`${path}.fingerprint`, 'does not match the recorded descriptor.')
  }
}

import type {
  ColorGraphIntent,
  LUTData,
  RawRenderExposure,
} from '@lumaforge/luma-color-runtime'
import {
  colorGraphIntentSignature,
  normalizeUserColorIntent,
  pickLookSelection,
} from '@lumaforge/luma-color-runtime'
import type { ExportGeometry } from '@lumaforge/render-engine/export'

import type {
  ExportResultIdentity,
  ExportResultKind,
  ExportResultLutContract,
  ExportResultLutIdentity,
} from '../../model/export-result'

/** What a producer reads when it captures its request, before any work. */
export type ExportResultIdentityInput = {
  resultKind: ExportResultKind
  /** The attempt this result belongs to; unique per export attempt. */
  attemptId: string
  sessionId: string
  sourceFile: File
  /** The color intent as given; view fields on the record are not read. */
  intent: ColorGraphIntent
  /** The LUT the pipeline holds; read only when the look draws a LUT. */
  lut: LUTData | null
  /** The RAW render exposure pinned for the source. */
  rawRenderExposure: RawRenderExposure | null
  /** The geometry the session committed; null when none is applied. */
  geometry: ExportGeometry | null
}

// Parsed LUT tables of this page, each named the first time a request
// captures it. A generation tells tables apart in memory only: it is not a
// content hash, and the same bytes parsed again get another one.
const lutTableGenerations = new WeakMap<Float32Array, number>()
let lastLutTableGeneration = 0

function lutTableGeneration(table: Float32Array): number {
  let generation = lutTableGenerations.get(table)
  if (generation === undefined) {
    lastLutTableGeneration += 1
    generation = lastLutTableGeneration
    lutTableGenerations.set(table, generation)
  }
  return generation
}

function captureLutContract(lut: LUTData): ExportResultLutContract {
  const resolution = lut.profileResolution
  if (resolution.kind !== 'confirmed') {
    return Object.freeze({ status: 'unconfirmed', resolution: resolution.kind })
  }
  const { profile } = resolution
  return Object.freeze({
    status: 'confirmed',
    role: profile.role,
    inputGamut: profile.inputGamut,
    inputTransfer: profile.inputTransfer,
    inputRange: profile.inputRange,
    ...(profile.outputGamut !== undefined
      ? { outputGamut: profile.outputGamut }
      : {}),
    ...(profile.outputTransfer !== undefined
      ? { outputTransfer: profile.outputTransfer }
      : {}),
    ...(profile.outputRange !== undefined
      ? { outputRange: profile.outputRange }
      : {}),
  })
}

function freezeTriple(
  value: readonly [number, number, number],
): readonly [number, number, number] {
  return Object.freeze([value[0], value[1], value[2]] as const)
}

/** The LUT reaches the result only when the look draws one, as in the graph. */
function captureLut(
  intent: ColorGraphIntent,
  lut: LUTData | null,
): ExportResultLutIdentity | null {
  if (intent.styleKind !== 'custom' || !lut) return null
  return Object.freeze({
    inMemoryGeneration: lutTableGeneration(lut.data),
    size: lut.size,
    domainMin: freezeTriple(lut.domainMin),
    domainMax: freezeTriple(lut.domainMax),
    contract: captureLutContract(lut),
  })
}

/**
 * The look as given, strength included and never snapped or filled in, plus
 * the user color as the color graph reads it.
 */
function captureColorIntent(
  intent: ColorGraphIntent,
): Readonly<ColorGraphIntent> {
  const user = normalizeUserColorIntent(intent)
  for (const band of Object.values(user.selectiveColor)) Object.freeze(band)
  Object.freeze(user.selectiveColor)
  return Object.freeze({ ...pickLookSelection(intent), ...user })
}

/** JSON has no non-finite numbers; spell them out so they stay distinct. */
function encodeNonFinite(_key: string, value: unknown): unknown {
  return typeof value === 'number' && !Number.isFinite(value)
    ? String(value)
    : value
}

/**
 * Fix the request a result will answer. Call it before the work starts and
 * hand the identity to materialization unchanged: everything is copied and
 * frozen here, so state that moves on while the job runs cannot reach it.
 */
export function captureExportResultIdentity(
  input: ExportResultIdentityInput,
): ExportResultIdentity {
  if (!input.attemptId || !input.sessionId) {
    throw new Error('EXPORT_RESULT_IDENTITY_INVALID')
  }
  const { name, size, lastModified } = input.sourceFile
  const source = Object.freeze({ name, size, lastModified })
  const colorIntent = captureColorIntent(input.intent)
  const lut = captureLut(input.intent, input.lut)
  const rawRenderExposure = input.rawRenderExposure
    ? Object.freeze({
        ev: input.rawRenderExposure.ev,
        multiplier: input.rawRenderExposure.multiplier,
        source: input.rawRenderExposure.source,
      })
    : null
  const geometry = input.geometry
    ? Object.freeze({
        matrix: Object.freeze([...input.geometry.matrix]),
        constrainCrop: input.geometry.constrainCrop,
      })
    : null
  const inputSignature = JSON.stringify(
    [
      input.sessionId,
      source.name,
      source.size,
      source.lastModified,
      colorGraphIntentSignature(colorIntent),
      lut,
      rawRenderExposure,
      geometry,
    ],
    encodeNonFinite,
  )

  return Object.freeze({
    resultKind: input.resultKind,
    attemptId: input.attemptId,
    sessionId: input.sessionId,
    source,
    colorIntent,
    lut,
    rawRenderExposure,
    geometry,
    inputSignature,
  })
}

/** Whether two identities asked for the same output, whatever the attempt. */
export function isSameExportResultInput(
  left: ExportResultIdentity,
  right: ExportResultIdentity,
): boolean {
  return left.inputSignature === right.inputSignature
}

/** Whether two identities name the same result of the same attempt. */
export function isSameExportResult(
  left: ExportResultIdentity,
  right: ExportResultIdentity,
): boolean {
  return (
    left.resultKind === right.resultKind &&
    left.attemptId === right.attemptId &&
    isSameExportResultInput(left, right)
  )
}

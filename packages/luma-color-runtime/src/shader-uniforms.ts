import type { TransferFunctionId } from './log-encoding'
import type { LUTRole, SignalRange } from './registry'

export const LUT_ROLE_UNIFORMS: Record<LUTRole, number> = {
  'display-look': 0,
  'scene-creative': 1,
  'combined-look-output': 2,
  'technical-output': 3,
}

export const LUT_RANGE_UNIFORMS: Record<SignalRange, number> = {
  full: 0,
  legal: 1,
  unknown: 2,
}

export const LUT_TRANSFER_UNIFORMS: Record<TransferFunctionId, number> = {
  srgb: 0,
  bt709: 1,
  gamma24: 2,
  's-log2': 3,
  's-log3': 4,
  'canon-log': 5,
  'canon-log2': 6,
  'canon-log3': 7,
  'n-log': 8,
  'f-log': 9,
  'f-log2': 10,
  'f-log2c': 11,
  'v-log': 12,
  logc3: 13,
  logc4: 14,
  log3g10: 15,
  acescc: 16,
  acescct: 17,
  'l-log': 18,
  linear: 19,
  'apple-log': 20,
  'dji-d-log': 21,
}

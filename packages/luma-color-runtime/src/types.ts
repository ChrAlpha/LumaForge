import type { ColorGamutId } from './constants'
import type { TransferFunctionId } from './log-encoding'
import type { LUTColorProfile, SignalRange } from './registry'

export type BuiltinStylePreset =
  | 'neutral'
  | 'warm'
  | 'cool'
  | 'film-soft'
  | 'film-contrast'
  | 'cinematic'
  | 'fade'
  | 'mono'

export type LUTContractResolution =
  | {
      kind: 'confirmed'
      profile: LUTColorProfile
      confidence: 'metadata' | 'user' | 'persisted-user'
    }
  | { kind: 'recommended'; recommendations: LUTColorProfile[] }
  | { kind: 'unknown' }
  | { kind: 'unsupported-output'; recommendations: LUTColorProfile[] }

export interface LUTData {
  size: number
  data: Float32Array
  domainMin: [number, number, number]
  domainMax: [number, number, number]
  title?: string
  profileResolution: LUTContractResolution
}

export interface LUTContractSelection {
  inputProfile?: string
  role: LUTColorProfile['role']
  inputGamut?: ColorGamutId
  inputTransfer?: TransferFunctionId
  inputRange?: SignalRange
  outputGamut?: ColorGamutId
  outputTransfer?: TransferFunctionId
  outputRange?: SignalRange
}

export interface StoredLUTContractSelection {
  inputProfile?: string
  role: LUTColorProfile['role']
  inputGamut: ColorGamutId
  inputTransfer: TransferFunctionId
  inputRange: SignalRange
  outputGamut?: ColorGamutId
  outputTransfer?: TransferFunctionId
  outputRange?: SignalRange
}

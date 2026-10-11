import type { LumaColorBalanceParams } from './color-balance'
import type { ColorGamutId } from './constants'
import type { TransferFunctionId } from './log-encoding'
import type { LUTColorProfile, SignalRange } from './registry'
import type { LumaColorSaturationParams } from './saturation'
import type { LumaColorSelectiveColorParams } from './selective-color'
import type { LumaColorToneParams } from './tone'

export type BuiltinStylePreset =
  | 'neutral'
  | 'warm'
  | 'cool'
  | 'film-soft'
  | 'film-contrast'
  | 'cinematic'
  | 'fade'
  | 'mono'

export interface LumaColorProcessingParams
  extends
    LumaColorToneParams,
    LumaColorBalanceParams,
    LumaColorSaturationParams,
    Partial<LumaColorSelectiveColorParams> {
  intensity: number
  /**
   * @deprecated View state is not color. The color graph never reads it;
   * pass the view to the preview separately. Kept optional so existing
   * records still type-check.
   */
  viewMode?: 'processed' | 'original' | 'compare'
  /**
   * @deprecated View state is not color. The color graph never reads it;
   * pass the compare split to the preview separately. Kept optional so
   * existing records still type-check.
   */
  compareSplit?: number
  styleKind: 'none' | 'builtin' | 'custom'
  builtinPreset: BuiltinStylePreset | null
}

export type ProcessingParams = LumaColorProcessingParams

export type LUTContractResolution =
  | {
      kind: 'confirmed'
      profile: LUTColorProfile
      confidence: 'metadata' | 'user' | 'persisted-user'
    }
  | { kind: 'recommended'; recommendations: LUTColorProfile[] }
  | { kind: 'unknown' }
  | { kind: 'unsupported-output'; recommendations: LUTColorProfile[] }

export interface LumaColorLUTData {
  size: number
  data: Float32Array
  domainMin: [number, number, number]
  domainMax: [number, number, number]
  title?: string
  profileResolution: LUTContractResolution
}

export type LUTData = LumaColorLUTData

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

import type {
  ColorGraphIntent,
  ExportColorGraphInput,
  LookSelection,
  LUTData,
  RawRenderExposure,
  SupportedExportColorGraphDescriptor,
  UserColorIntent,
} from '@lumaforge/luma-color-runtime'
import {
  NEUTRAL_USER_COLOR_INTENT,
  pickLookSelection,
  resolveExportColorGraph,
} from '@lumaforge/luma-color-runtime'

import type { CpuPreviewVariant } from './worker-bridge/protocol'

/*
 * What a preview draws for the look a user selected.
 *
 * The export color graph is the authority: a custom LUT draws only when
 * export would run it. When export refuses the LUT's contract the preview
 * drops the look and keeps the user's adjustments and the RAW render
 * exposure; the selection itself is reported unchanged, and export keeps
 * refusing it. A strength of 0 does not skip the contract check.
 *
 * Built-in presets are the one look export never runs. WebGPU draws them; the
 * TS row-band executor (CPU preview, histogram) has no preset implementation,
 * so on the CPU the preview draws the adjusted graph without the look, and
 * while WebGPU shows a preset no TS graph stands in for it.
 */

/** The executor that draws the preview. */
export type PreviewColorExecutor = 'webgpu' | 'cpu'

/** Why the drawn look or user color differs from the selection. */
export type PreviewColorPlanReason =
  /** The original: no look and neutral user color by design. */
  | 'neutral-variant'
  /** A custom LUT is selected but its data is not loaded. */
  | 'lut-not-loaded'
  /** The LUT's input contract is recommended or unknown, not confirmed. */
  | 'lut-input-unconfirmed'
  /** The LUT's contract was resolved to an output this build cannot use. */
  | 'lut-output-unsupported'
  /** The confirmed contract leaves the LUT output range unknown. */
  | 'lut-output-range-unknown'
  /** The confirmed contract does not fully describe the LUT output. */
  | 'lut-output-profile-missing'
  /** The confirmed contract has a linear LUT output, which export refuses. */
  | 'lut-output-transfer-linear'
  /** Export refused the contract for a reason not listed above. */
  | 'lut-contract-refused'
  /** A builtin style is selected without a preset. */
  | 'builtin-preset-missing'
  /** The executor has no implementation of builtin presets. */
  | 'builtin-no-ts-executor'

export const PREVIEW_COLOR_PLAN_REASONS: readonly PreviewColorPlanReason[] =
  Object.freeze([
    'neutral-variant',
    'lut-not-loaded',
    'lut-input-unconfirmed',
    'lut-output-unsupported',
    'lut-output-range-unknown',
    'lut-output-profile-missing',
    'lut-output-transfer-linear',
    'lut-contract-refused',
    'builtin-preset-missing',
    'builtin-no-ts-executor',
  ] satisfies PreviewColorPlanReason[])

/** What a preview histogram may measure. */
export type PreviewHistogramPlan =
  | { kind: 'graph'; graph: SupportedExportColorGraphDescriptor }
  /** The preview draws a look no TS graph reproduces. */
  | { kind: 'unrepresented'; reason: 'builtin-no-ts-executor' }

export interface ResolvePreviewColorPlanInput {
  /**
   * The selected look and the complete user color, HSL included; read and
   * never written. Fields outside the intent are ignored.
   */
  intent: ColorGraphIntent
  /** The selected custom LUT's data, when loaded. */
  lut: LUTData | null
  rawRenderExposure?: RawRenderExposure
  executor: PreviewColorExecutor
  /** Defaults to `'processed'`. */
  variant?: CpuPreviewVariant
}

export interface PreviewColorPlan {
  executor: PreviewColorExecutor
  variant: CpuPreviewVariant
  /** The look as selected. */
  selected: LookSelection
  /** The look the executor draws; no look is always the same record. */
  effective: LookSelection
  /** The effective look with the user color the executor draws. */
  effectiveIntent: ColorGraphIntent
  /** The LUT the executor draws; null unless a custom look is drawn. */
  lut: LUTData | null
  /** Why `effectiveIntent` differs from the selection; null when it does not. */
  reason: PreviewColorPlanReason | null
  /**
   * The TS graph that reproduces the draw. Null only when the executor draws
   * a look with no TS implementation (a builtin preset on WebGPU).
   */
  graph: SupportedExportColorGraphDescriptor | null
  histogram: PreviewHistogramPlan
}

const NO_LOOK: LookSelection = Object.freeze({
  styleKind: 'none',
  builtinPreset: null,
  intensity: 0,
})

/** Why export refuses a custom LUT's contract, or null when it accepts it. */
function lutContractRefusal(lut: LUTData): PreviewColorPlanReason | null {
  const resolution = lut.profileResolution
  if (resolution.kind === 'unsupported-output') return 'lut-output-unsupported'
  if (resolution.kind !== 'confirmed') return 'lut-input-unconfirmed'

  const { profile } = resolution
  if (profile.outputRange === 'unknown') return 'lut-output-range-unknown'
  if (
    profile.role !== 'display-look' &&
    (!profile.outputGamut || !profile.outputTransfer || !profile.outputRange)
  ) {
    return 'lut-output-profile-missing'
  }
  // A display look without a declared output transfer outputs its input one.
  const outputTransfer =
    profile.outputTransfer ??
    (profile.role === 'display-look' ? profile.inputTransfer : undefined)
  if (!outputTransfer) return 'lut-output-profile-missing'
  if (outputTransfer === 'linear') return 'lut-output-transfer-linear'
  return null
}

/** The user color out of a larger record, every value as given. */
function userColorOf(intent: ColorGraphIntent): UserColorIntent {
  return {
    userExposureEv: intent.userExposureEv,
    userContrast: intent.userContrast,
    userHighlights: intent.userHighlights,
    userShadows: intent.userShadows,
    userWhites: intent.userWhites,
    userBlacks: intent.userBlacks,
    userTemperature: intent.userTemperature,
    userTint: intent.userTint,
    userSaturation: intent.userSaturation,
    userVibrance: intent.userVibrance,
    selectiveColor: intent.selectiveColor,
  }
}

function resolveTsGraph(
  input: ExportColorGraphInput,
): SupportedExportColorGraphDescriptor | null {
  const graph = resolveExportColorGraph(input)
  return graph.supported ? graph : null
}

export function resolvePreviewColorPlan({
  intent,
  lut,
  rawRenderExposure,
  executor,
  variant = 'processed',
}: ResolvePreviewColorPlanInput): PreviewColorPlan {
  const selected = pickLookSelection(intent)
  const userColor = userColorOf(intent)
  const asSelected: ColorGraphIntent = { ...selected, ...userColor }

  const drawn = (
    effective: LookSelection,
    effectiveIntent: ColorGraphIntent,
    effectiveLut: LUTData | null,
    reason: PreviewColorPlanReason | null,
    graph: SupportedExportColorGraphDescriptor | null,
  ): PreviewColorPlan => ({
    executor,
    variant,
    selected,
    effective,
    effectiveIntent,
    lut: effectiveLut,
    reason,
    graph,
    histogram: graph
      ? { kind: 'graph', graph }
      : { kind: 'unrepresented', reason: 'builtin-no-ts-executor' },
  })

  // No look over the given user color. Export always runs this graph.
  const withoutLook = (
    reason: PreviewColorPlanReason | null,
    effectiveUserColor = userColor,
  ) => {
    const effectiveIntent = { ...NO_LOOK, ...effectiveUserColor }
    const graph = resolveTsGraph({
      ...effectiveIntent,
      lut: null,
      rawRenderExposure,
    })
    if (!graph) throw new Error('The color graph without a look must resolve.')
    return drawn(NO_LOOK, effectiveIntent, null, reason, graph)
  }

  if (variant === 'neutral') {
    return withoutLook('neutral-variant', NEUTRAL_USER_COLOR_INTENT)
  }

  if (selected.styleKind === 'builtin') {
    if (!selected.builtinPreset) return withoutLook('builtin-preset-missing')
    if (executor === 'cpu') return withoutLook('builtin-no-ts-executor')
    return drawn(selected, asSelected, null, null, null)
  }

  if (selected.styleKind !== 'custom') return withoutLook(null)
  if (!lut) return withoutLook('lut-not-loaded')

  const graph = resolveTsGraph({ ...asSelected, lut, rawRenderExposure })
  if (!graph) {
    return withoutLook(lutContractRefusal(lut) ?? 'lut-contract-refused')
  }
  return drawn(selected, asSelected, lut, null, graph)
}

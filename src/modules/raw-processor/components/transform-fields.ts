import type { MessageKey } from '~/lib/i18n'
import type { UprightMode } from '~/modules/transform-demo/geometry/types'
import type { ManualTransform } from '~/modules/transform-demo/transform-types'
import { NEUTRAL_TRANSFORM } from '~/modules/transform-demo/transform-types'

import type { RawTransformFeature } from '../hooks/useRawTransformFeature'

/**
 * Field model for the Transform tool, shared by the desktop rail and the
 * mobile dock the way `tone-fields` / `color-fields` are.
 *
 * Every field is exposed to the UI on a **zero-centred** domain so the two
 * Adjust rows (`DesktopAdjustRow`, `AdjustSliderRow`) can be reused verbatim:
 * they anchor the bipolar fill at 0, mark "dirty" as `value !== 0`, and reset
 * to 0. Scale is the only field whose neutral is not 0 in the model (100%), so
 * it carries `base: 100` and the UI trades in the offset from neutral while
 * the readout still reads as an absolute percentage.
 */
export type TransformGroup = 'perspective' | 'frame'

export interface TransformField {
  key: keyof ManualTransform
  labelKey: MessageKey
  group: TransformGroup
  /** Model value at the slider's neutral (0) position. */
  base: number
  /** Slider domain, always centred on 0. */
  min: number
  max: number
  step: number
  decimals: number
  unit: string
}

export const TRANSFORM_FIELDS: TransformField[] = [
  {
    key: 'vertical',
    labelKey: 'transform.vertical',
    group: 'perspective',
    base: 0,
    min: -60,
    max: 60,
    step: 1,
    decimals: 0,
    unit: '',
  },
  {
    key: 'horizontal',
    labelKey: 'transform.horizontal',
    group: 'perspective',
    base: 0,
    min: -60,
    max: 60,
    step: 1,
    decimals: 0,
    unit: '',
  },
  {
    key: 'rotate',
    labelKey: 'transform.rotate',
    group: 'perspective',
    base: 0,
    min: -30,
    max: 30,
    step: 0.1,
    decimals: 1,
    unit: '°',
  },
  {
    key: 'aspect',
    labelKey: 'transform.aspect',
    group: 'perspective',
    base: 0,
    min: -50,
    max: 50,
    step: 1,
    decimals: 0,
    unit: '',
  },
  {
    key: 'scale',
    labelKey: 'transform.scale',
    group: 'frame',
    base: 100,
    min: -50,
    max: 50,
    step: 1,
    decimals: 0,
    unit: '%',
  },
  {
    key: 'offsetX',
    labelKey: 'transform.offsetX',
    group: 'frame',
    base: 0,
    min: -30,
    max: 30,
    step: 1,
    decimals: 0,
    unit: '',
  },
  {
    key: 'offsetY',
    labelKey: 'transform.offsetY',
    group: 'frame',
    base: 0,
    min: -30,
    max: 30,
    step: 1,
    decimals: 0,
    unit: '',
  },
]

export const TRANSFORM_GROUPS: TransformGroup[] = ['perspective', 'frame']

export const TRANSFORM_GROUP_LABEL: Record<TransformGroup, MessageKey> = {
  perspective: 'raw.transform.group.perspective',
  frame: 'raw.transform.group.frame',
}

export function transformFieldsIn(group: TransformGroup): TransformField[] {
  return TRANSFORM_FIELDS.filter((field) => field.group === group)
}

/** Slider value (offset from neutral) for a field of the model transform. */
export function transformSliderValue(
  field: TransformField,
  manual: ManualTransform,
): number {
  return manual[field.key] - field.base
}

/** Model transform after a slider on `field` moved to `value`. */
export function applyTransformSlider(
  field: TransformField,
  manual: ManualTransform,
  value: number,
): ManualTransform {
  return { ...manual, [field.key]: field.base + value }
}

/**
 * Readout for one field. Offsets carry an explicit sign, absolute domains
 * (Scale) read as the value itself so 100% still says "100%".
 */
export function formatTransformValue(
  field: TransformField,
  value: number,
): string {
  const model = field.base + value
  const text = model.toFixed(field.decimals)
  const signed = field.base === 0 && model > 0 ? `+${text}` : text
  return `${signed}${field.unit}`
}

export function isTransformGroupNeutral(
  group: TransformGroup,
  manual: ManualTransform,
): boolean {
  return transformFieldsIn(group).every(
    (field) => manual[field.key] === field.base,
  )
}

export function isManualTransformNeutral(manual: ManualTransform): boolean {
  return (Object.keys(NEUTRAL_TRANSFORM) as Array<keyof ManualTransform>).every(
    (key) => manual[key] === NEUTRAL_TRANSFORM[key],
  )
}

export function resetTransformGroup(
  group: TransformGroup,
  manual: ManualTransform,
): ManualTransform {
  const next = { ...manual }
  for (const field of transformFieldsIn(group)) next[field.key] = field.base
  return next
}

/** True when Transform is doing something the user can reset. */
export function isTransformDirty(
  mode: UprightMode,
  manual: ManualTransform,
): boolean {
  return mode !== 'off' || !isManualTransformNeutral(manual)
}

export interface TransformMessage {
  /** `alert` states are the ones a photographer has to act on. */
  tone: 'alert' | 'hint'
  key: MessageKey
}

/**
 * The single line both surfaces show under the mode row. One slot, ranked:
 * blockers first, then progress, then the guidance for the selected mode. The
 * committed result is not narrated here; the photograph reports it.
 */
export function resolveTransformMessage(
  feature: RawTransformFeature,
): TransformMessage {
  const { demo } = feature
  if (!feature.hasImage)
    return { tone: 'hint', key: 'raw.transform.awaitImage' }
  // Naming the action that is actually on screen beats telling someone to wait
  // for something that will not come back on its own.
  if (feature.previewSuspended)
    return { tone: 'hint', key: 'raw.transform.previewReleased' }
  if (feature.captureError || demo.error || !feature.available) {
    return {
      tone: 'alert',
      key:
        demo.error === 'transform'
          ? 'transform.error.transform'
          : 'raw.transform.unavailable',
    }
  }
  if (feature.busy && !demo.result)
    return { tone: 'hint', key: 'raw.transform.preparing' }
  if (demo.mode !== 'off' && demo.solution.status === 'insufficient')
    return { tone: 'alert', key: 'transform.insufficient' }
  return { tone: 'hint', key: `transform.modeHelp.${demo.mode}` }
}

export const UPRIGHT_MODES: UprightMode[] = [
  'off',
  'auto',
  'level',
  'vertical',
  'full',
]

export function uprightModeLabelKey(mode: UprightMode): MessageKey {
  return `transform.mode.${mode}`
}

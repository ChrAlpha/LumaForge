import { TRANSFORM_FIELDS } from '~/modules/raw-processor/components/transform-fields'
import type { ManualTransform } from '~/modules/transform-demo/transform-types'
import { NEUTRAL_TRANSFORM } from '~/modules/transform-demo/transform-types'

/**
 * The full slider range of every Transform field, in model units, read from
 * the field model the desktop and mobile Transform controls render.
 */
export const TRANSFORM_EXTREMES: Readonly<
  Record<keyof ManualTransform, readonly number[]>
> = fieldExtremes()

function fieldExtremes(): Record<keyof ManualTransform, readonly number[]> {
  const extremes: Partial<Record<keyof ManualTransform, readonly number[]>> = {}
  for (const field of TRANSFORM_FIELDS)
    extremes[field.key] = [field.base + field.min, field.base + field.max]
  return extremes as Record<keyof ManualTransform, readonly number[]>
}

export const TRANSFORM_COMBINATIONS: ReadonlyArray<
  readonly [label: string, patch: Partial<ManualTransform>]
> = [
  ['rotate + zoom out', { rotate: 30, scale: 50 }],
  ['rotate + zoom out + vertical', { rotate: 30, scale: 50, vertical: 60 }],
  ['zoom out + aspect', { scale: 50, aspect: -50 }],
  ['both perspective axes', { vertical: 60, horizontal: 60 }],
  [
    'every field at its limit',
    {
      rotate: 30,
      scale: 50,
      vertical: 60,
      horizontal: 60,
      aspect: -50,
      offsetX: 30,
      offsetY: 30,
    },
  ],
]

/**
 * A geometry whose projective horizon crosses the unconstrained output frame,
 * so it folds. Constraining the crop pulls the frame back inside the horizon.
 */
export const FOLDING_TRANSFORM: ManualTransform = {
  ...NEUTRAL_TRANSFORM,
  rotate: 30,
  scale: 50,
  vertical: 60,
  horizontal: 60,
}

export type TransformGeometryCase = readonly [
  label: string,
  manual: ManualTransform,
  constrainCrop: boolean,
]

/**
 * Every field alone at each end of its range, then every combination, each in
 * both crop modes.
 *
 * The render engine sweeps its export bounds over these cases as recorded
 * matrices; the parity test holds this composition to that recording.
 */
export function transformGeometryCases(): TransformGeometryCase[] {
  const out: TransformGeometryCase[] = []
  for (const key of Object.keys(TRANSFORM_EXTREMES) as Array<
    keyof ManualTransform
  >) {
    for (const value of TRANSFORM_EXTREMES[key]) {
      for (const crop of [true, false]) {
        out.push([
          `${key}=${value} crop=${crop}`,
          { ...NEUTRAL_TRANSFORM, [key]: value },
          crop,
        ])
      }
    }
  }
  for (const [label, patch] of TRANSFORM_COMBINATIONS) {
    for (const crop of [true, false]) {
      out.push([
        `${label} crop=${crop}`,
        { ...NEUTRAL_TRANSFORM, ...patch },
        crop,
      ])
    }
  }
  return out
}

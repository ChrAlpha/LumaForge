import type { Matrix3 } from '../../export/geometry/matrix'

/**
 * Fixed geometry corpus for engine-side export tests.
 *
 * Each matrix is the source-normalized to output-normalized matrix the app's
 * Transform controls commit for a 4:3 frame: every field alone at each end of
 * its range, then five combinations. The engine cannot compose those controls
 * itself, so the matrices are recorded here and the app's own tests hold its
 * composition to them. Re-record a matrix only when the app's composition is
 * meant to change.
 */

/** 100 MP, the 4:3 size the bounded export pipeline exists for. */
export const TRANSFORM_CASE_SOURCE = { width: 11648, height: 8736 } as const

/** Output frame the export plans for one crop mode, or `null` when it refuses. */
export type TransformCaseOutput = {
  readonly width: number
  readonly height: number
} | null

export type TransformMatrixGeometry = {
  readonly label: string
  readonly matrix: Matrix3
  /** Planned output with the crop constrained to the source. */
  readonly constrained: TransformCaseOutput
  /** Planned output with the full frame kept and a matte outside the source. */
  readonly unconstrained: TransformCaseOutput
}

export type TransformMatrixCase = readonly [
  label: string,
  matrix: Matrix3,
  constrainCrop: boolean,
  expected: TransformCaseOutput,
]

export const TRANSFORM_MATRIX_GEOMETRIES: readonly TransformMatrixGeometry[] = [
  {
    label: 'vertical=-60',
    matrix: [
      1, -0.3, 0.15000000000000002, 0, 0.7, 0.15000000000000002, 0, -0.6, 1.3,
    ],
    constrained: { width: 8960, height: 6720 },
    unconstrained: { width: 11648, height: 8736 },
  },
  {
    label: 'vertical=60',
    matrix: [
      1, 0.3, -0.15000000000000002, 0, 1.3, -0.15000000000000002, 0, 0.6, 0.7,
    ],
    constrained: { width: 8960, height: 6720 },
    unconstrained: { width: 11648, height: 8736 },
  },
  {
    label: 'horizontal=-60',
    matrix: [
      0.7, 0, 0.15000000000000002, -0.3, 1, 0.15000000000000002, -0.6, 0, 1.3,
    ],
    constrained: { width: 8960, height: 6720 },
    unconstrained: { width: 11648, height: 8736 },
  },
  {
    label: 'horizontal=60',
    matrix: [
      1.3, 0, -0.15000000000000002, 0.3, 1, -0.15000000000000002, 0.6, 0, 0.7,
    ],
    constrained: { width: 8960, height: 6720 },
    unconstrained: { width: 11648, height: 8736 },
  },
  {
    label: 'rotate=-30',
    matrix: [
      0.8660254037844387, 0.375, -0.12051270189221935, -0.6666666666666665,
      0.8660254037844387, 0.4003206314411139, 0, 0, 1,
    ],
    constrained: { width: 7600, height: 5700 },
    unconstrained: { width: 11648, height: 8736 },
  },
  {
    label: 'rotate=30',
    matrix: [
      0.8660254037844387, -0.375, 0.25448729810778065, 0.6666666666666665,
      0.8660254037844387, -0.2663460352255526, 0, 0, 1,
    ],
    constrained: { width: 7600, height: 5700 },
    unconstrained: { width: 11648, height: 8736 },
  },
  {
    label: 'aspect=-50',
    matrix: [0.5, 0, 0.25, 0, 1, 0, 0, 0, 1],
    constrained: { width: 5824, height: 4368 },
    unconstrained: { width: 11648, height: 8736 },
  },
  {
    label: 'aspect=50',
    matrix: [1.5, 0, -0.25, 0, 1, 0, 0, 0, 1],
    constrained: { width: 11648, height: 8736 },
    unconstrained: { width: 11648, height: 8736 },
  },
  {
    label: 'scale=50',
    matrix: [0.5, 0, 0.25, 0, 0.5, 0.25, 0, 0, 1],
    constrained: { width: 5824, height: 4368 },
    unconstrained: { width: 11648, height: 8736 },
  },
  {
    label: 'scale=150',
    matrix: [1.5, 0, -0.25, 0, 1.5, -0.25, 0, 0, 1],
    constrained: { width: 11648, height: 8736 },
    unconstrained: { width: 11648, height: 8736 },
  },
  {
    label: 'offsetX=-30',
    matrix: [1, 0, -0.3, 0, 1, 0, 0, 0, 1],
    constrained: { width: 4659, height: 3494 },
    unconstrained: { width: 11648, height: 8736 },
  },
  {
    label: 'offsetX=30',
    matrix: [1, 0, 0.30000000000000004, 0, 1, 0, 0, 0, 1],
    constrained: { width: 4659, height: 3494 },
    unconstrained: { width: 11648, height: 8736 },
  },
  {
    label: 'offsetY=-30',
    matrix: [1, 0, 0, 0, 1, -0.3, 0, 0, 1],
    constrained: { width: 4659, height: 3494 },
    unconstrained: { width: 11648, height: 8736 },
  },
  {
    label: 'offsetY=30',
    matrix: [1, 0, 0, 0, 1, 0.30000000000000004, 0, 0, 1],
    constrained: { width: 4659, height: 3494 },
    unconstrained: { width: 11648, height: 8736 },
  },
  {
    label: 'rotate + zoom out',
    matrix: [
      0.43301270189221935, -0.1875, 0.3772436490538903, 0.33333333333333326,
      0.43301270189221935, 0.1168269823872237, 0, 0, 1,
    ],
    constrained: { width: 3800, height: 2850 },
    unconstrained: { width: 11648, height: 8736 },
  },
  {
    label: 'rotate + zoom out + vertical',
    matrix: [
      0.6330127018922194, 0.07230762113533162, 0.1473398384862245,
      0.5333333333333332, 0.692820323027551, -0.11307682818044212,
      0.3999999999999999, 0.5196152422706632, 0.5401923788646684,
    ],
    constrained: { width: 3178, height: 2383 },
    unconstrained: { width: 11648, height: 8736 },
  },
  {
    label: 'zoom out + aspect',
    matrix: [0.25, 0, 0.375, 0, 0.5, 0.25, 0, 0, 1],
    constrained: { width: 2912, height: 2184 },
    unconstrained: { width: 11648, height: 8736 },
  },
  {
    label: 'both perspective axes',
    matrix: [1.3, 0.3, -0.3, 0.3, 1.3, -0.3, 0.6, 0.6, 0.4],
    constrained: { width: 7280, height: 5460 },
    unconstrained: { width: 11648, height: 8736 },
  },
  {
    label: 'every field at its limit',
    matrix: [
      0.9521985447626402, 0.14194219381653056, 0.25292963071041463,
      1.0690255271498637, 0.66870489570875, -0.06886521142930677,
      0.9196152422706632, 0.29461524227066327, 0.39288475772933684,
    ],
    constrained: null,
    unconstrained: { width: 11648, height: 8736 },
  },
]

/**
 * Rotate, zoom out and both perspective axes at their limits: the projective
 * horizon crosses the unconstrained output frame, so it folds. Constraining the
 * crop pulls the frame back inside the horizon.
 */
export const FOLDING_MATRIX_GEOMETRY: TransformMatrixGeometry = {
  label: 'folding',
  matrix: [
    0.892820323027551, -0.04019237886466842, 0.07368602791855876,
    0.7931409544686648, 0.5803203230275511, -0.1867306387481079,
    0.9196152422706632, 0.29461524227066327, 0.39288475772933684,
  ],
  constrained: { width: 3163, height: 2373 },
  unconstrained: null,
}

/** Every corpus geometry in both crop modes, labelled the way the app labels them. */
export function transformMatrixCases(
  geometries: readonly TransformMatrixGeometry[] = TRANSFORM_MATRIX_GEOMETRIES,
): TransformMatrixCase[] {
  return geometries.flatMap((geometry) =>
    ([true, false] as const).map(
      (constrainCrop): TransformMatrixCase => [
        `${geometry.label} crop=${constrainCrop}`,
        geometry.matrix,
        constrainCrop,
        constrainCrop ? geometry.constrained : geometry.unconstrained,
      ],
    ),
  )
}

import { detectLines } from '~/modules/transform-demo/geometry/detect-lines'
import { fitFamily } from '~/modules/transform-demo/geometry/fit-family'
import {
  applyMatrix,
  identityMatrix,
  invertMatrix,
  multiplyMatrices,
  rotationMatrix,
} from '~/modules/transform-demo/geometry/matrix'
import type {
  AnalysisImage,
  LineSegment,
  Matrix3,
  UprightAnalysis,
  UprightSolution,
} from '~/modules/transform-demo/geometry/types'

function unchanged(
  reason: string,
  confidence = 0,
  insufficient = true,
): UprightSolution {
  return {
    matrix: identityMatrix(),
    confidence,
    status: insufficient ? 'insufficient' : 'unchanged',
    reason,
    rotationDegrees: 0,
  }
}

function normalizeMatrix(
  matrix: Matrix3,
  width: number,
  height: number,
): Matrix3 {
  const scale = Math.max(width, height)
  const toCentered: Matrix3 = [
    width / scale,
    0,
    -width / scale / 2,
    0,
    height / scale,
    -height / scale / 2,
    0,
    0,
    1,
  ]
  const fromCentered: Matrix3 = [
    scale / width,
    0,
    0.5,
    0,
    scale / height,
    0.5,
    0,
    0,
    1,
  ]
  return multiplyMatrices(fromCentered, multiplyMatrices(matrix, toCentered))
}

function distortionCost(matrix: Matrix3): number {
  const corners = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ]
  const denominators = corners.map(
    (point) => matrix[6] * point.x + matrix[7] * point.y + matrix[8],
  )
  if (
    Math.min(...denominators) < 0.35 ||
    Math.max(...denominators) > 2.8 ||
    !invertMatrix(matrix)
  )
    return Number.POSITIVE_INFINITY
  const mapped = corners.map((point) => applyMatrix(matrix, point))
  if (mapped.some((point) => !point)) return Number.POSITIVE_INFINITY
  const points = mapped.map((point) => point!)
  const width =
    Math.max(...points.map((point) => point.x)) -
    Math.min(...points.map((point) => point.x))
  const height =
    Math.max(...points.map((point) => point.y)) -
    Math.min(...points.map((point) => point.y))
  if (width > 2.3 || height > 2.3 || width < 0.45 || height < 0.45)
    return Number.POSITIVE_INFINITY
  return (
    (Math.max(...denominators) / Math.min(...denominators) - 1) * 0.5 +
    Math.max(0, width * height - 1) * 0.4
  )
}

function solution(
  matrix: Matrix3 | null,
  confidence: number,
  rotationDegrees: number,
  reason: string,
): UprightSolution {
  if (!matrix || !Number.isFinite(distortionCost(matrix)))
    return unchanged(
      'The required correction would distort the frame too much.',
    )
  const correction = Math.max(
    ...matrix.map((value, index) => Math.abs(value - identityMatrix()[index])),
  )
  if (correction < 0.009)
    return unchanged(
      'The detected structure is already upright.',
      confidence,
      false,
    )
  return { matrix, confidence, rotationDegrees, reason, status: 'corrected' }
}

function structureError(
  matrix: Matrix3,
  lines: LineSegment[],
  width: number,
  height: number,
): number {
  let weightedError = 0
  let weight = 0
  for (const line of lines) {
    if (line.kind === 'other') continue
    const start = applyMatrix(matrix, {
      x: line.start.x / width,
      y: line.start.y / height,
    })
    const end = applyMatrix(matrix, {
      x: line.end.x / width,
      y: line.end.y / height,
    })
    if (!start || !end) return Number.POSITIVE_INFINITY
    const dx = Math.abs(end.x - start.x) * width
    const dy = Math.abs(end.y - start.y) * height
    const angle =
      ((line.kind === 'vertical' ? Math.atan2(dx, dy) : Math.atan2(dy, dx)) *
        180) /
      Math.PI
    const lineWeight =
      line.length * line.strength * (line.kind === 'vertical' ? 1 : 0.6)
    weightedError += Math.min(8, angle) * lineWeight
    weight += lineWeight
  }
  return weight > 0 ? weightedError / weight : Number.POSITIVE_INFINITY
}

export function analyzeUpright(image: AnalysisImage): UprightAnalysis {
  const insufficient = unchanged(
    'Not enough consistent straight lines. Try another image or adjust manually.',
  )
  const solutions: UprightAnalysis['solutions'] = {
    off: unchanged('Original geometry.', 1, false),
    auto: insufficient,
    level: insufficient,
    vertical: insufficient,
    full: insufficient,
  }
  if (
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    image.width < 16 ||
    image.height < 16 ||
    image.width * image.height * 4 > image.data.length
  )
    return { lines: [], solutions }
  const lines = detectLines(image)
  const vertical = fitFamily(lines, 'vertical', image.width, image.height)
  const horizontal = fitFamily(lines, 'horizontal', image.width, image.height)
  const horizontalRoll = horizontal ? Math.atan(horizontal.direction) : null
  const verticalRoll = vertical ? -Math.atan(vertical.direction) : null
  const preferVertical =
    (vertical?.confidence ?? 0) > (horizontal?.confidence ?? 0)
  let roll = preferVertical ? verticalRoll : (horizontalRoll ?? verticalRoll)
  if (
    horizontal &&
    vertical &&
    Math.abs(horizontalRoll! - verticalRoll!) < 0.02
  ) {
    roll =
      (horizontalRoll! * horizontal.confidence +
        verticalRoll! * vertical.confidence) /
      (horizontal.confidence + vertical.confidence)
  }
  const levelConfidence = Math.max(
    horizontal?.confidence ?? 0,
    vertical?.confidence ?? 0,
  )
  if (roll !== null && levelConfidence >= 0.3 && Math.abs(roll) < Math.PI / 9) {
    solutions.level = solution(
      rotationMatrix((-roll * 180) / Math.PI, image.width / image.height),
      levelConfidence,
      (-roll * 180) / Math.PI,
      'Leveled the dominant structural direction.',
    )
  }
  if (vertical && vertical.confidence >= 0.3) {
    const angle = Math.atan(vertical.direction)
    const cosine = Math.cos(angle)
    const sine = Math.sin(angle)
    const basis: Matrix3 = [
      cosine,
      sine,
      0,
      -sine,
      cosine,
      0,
      0,
      vertical.convergence * cosine,
      1,
    ]
    const matrix = invertMatrix(basis)
    solutions.vertical = solution(
      matrix && normalizeMatrix(matrix, image.width, image.height),
      vertical.confidence,
      (angle * 180) / Math.PI,
      'Straightened the consistent vertical structures.',
    )
  }
  if (
    horizontal &&
    vertical &&
    Math.min(horizontal.confidence, vertical.confidence) >= 0.35
  ) {
    const hn = Math.hypot(1, horizontal.direction)
    const vn = Math.hypot(1, vertical.direction)
    const basis: Matrix3 = [
      1 / hn,
      vertical.direction / vn,
      0,
      horizontal.direction / hn,
      1 / vn,
      0,
      horizontal.convergence / hn,
      vertical.convergence / vn,
      1,
    ]
    const matrix = invertMatrix(basis)
    solutions.full = solution(
      matrix && normalizeMatrix(matrix, image.width, image.height),
      Math.min(horizontal.confidence, vertical.confidence),
      (-Math.atan(horizontal.direction) * 180) / Math.PI,
      'Straightened both structural directions.',
    )
  }
  let bestScore = Number.POSITIVE_INFINITY
  for (const mode of ['level', 'vertical', 'full'] as const) {
    const candidate = solutions[mode]
    const minimumConfidence =
      mode === 'full'
        ? 0.62
        : mode === 'vertical'
          ? 0.5
          : horizontal
            ? 0.55
            : 0.65
    const cost = distortionCost(candidate.matrix)
    if (
      candidate.status === 'insufficient' ||
      candidate.confidence < minimumConfidence ||
      (mode === 'vertical' &&
        !horizontal &&
        ((vertical?.count ?? 0) < 4 ||
          Math.abs(candidate.rotationDegrees) >= 20)) ||
      cost > 0.85
    )
      continue
    const score =
      structureError(candidate.matrix, lines, image.width, image.height) +
      cost * 1.5 +
      (mode === 'full' ? 0.35 : 0)
    if (score < bestScore) {
      bestScore = score
      solutions.auto = {
        ...candidate,
        reason:
          candidate.status === 'unchanged'
            ? candidate.reason
            : 'Balanced straight-line alignment with frame distortion.',
      }
    }
  }
  return { lines, solutions }
}

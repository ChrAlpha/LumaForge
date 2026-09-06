import type { LineSegment } from '~/modules/transform-demo/geometry/types'

interface Observation {
  slope: number
  position: number
  weight: number
}

export interface FamilyFit {
  direction: number
  convergence: number
  confidence: number
  count: number
  support: number
}

function error(
  observation: Observation,
  direction: number,
  convergence: number,
): number {
  return (
    Math.abs(
      observation.slope - direction - convergence * observation.position,
    ) / Math.sqrt(1 + observation.slope ** 2)
  )
}

function leastSquares(observations: Observation[]): [number, number] {
  let weight = 0
  let position = 0
  let slope = 0
  let positionSquared = 0
  let product = 0
  for (const observation of observations) {
    weight += observation.weight
    position += observation.weight * observation.position
    slope += observation.weight * observation.slope
    positionSquared += observation.weight * observation.position ** 2
    product += observation.weight * observation.position * observation.slope
  }
  const determinant = weight * positionSquared - position ** 2
  if (determinant < 1e-8) return [slope / weight, 0]
  return [
    (slope * positionSquared - position * product) / determinant,
    (weight * product - position * slope) / determinant,
  ]
}

export function fitFamily(
  lines: LineSegment[],
  kind: 'vertical' | 'horizontal',
  width: number,
  height: number,
): FamilyFit | null {
  const scale = Math.max(width, height)
  const observations = lines
    .filter((line) => line.kind === kind)
    .map((line): Observation => {
      const dx = line.end.x - line.start.x
      const dy = line.end.y - line.start.y
      const x = ((line.start.x + line.end.x) / 2 - width / 2) / scale
      const y = ((line.start.y + line.end.y) / 2 - height / 2) / scale
      const slope = kind === 'vertical' ? dx / dy : dy / dx
      return {
        slope,
        position: kind === 'vertical' ? slope * y - x : slope * x - y,
        weight: (line.length / scale) * Math.max(0.2, line.strength),
      }
    })
    .slice(0, 32)
  if (observations.length < 3) return null
  const totalWeight = observations.reduce(
    (sum, observation) => sum + observation.weight,
    0,
  )
  const threshold = 0.027
  let bestScore = 0
  let best: [number, number] = [0, 0]
  for (let first = 0; first < observations.length; first++) {
    for (let last = first; last < observations.length; last++) {
      const a = observations[first]
      const b = observations[last]
      if (first !== last && Math.abs(a.position - b.position) < 0.1) continue
      const convergence =
        first === last ? 0 : (a.slope - b.slope) / (a.position - b.position)
      const direction = a.slope - convergence * a.position
      if (Math.abs(convergence) > 1.4 || Math.abs(direction) > 0.6) continue
      const score = observations.reduce((sum, observation) => {
        const residual = error(observation, direction, convergence) / threshold
        return sum + observation.weight * Math.max(0, 1 - residual ** 2)
      }, 0)
      if (score > bestScore) {
        bestScore = score
        best = [direction, convergence]
      }
    }
  }
  const inliers = observations.filter(
    (observation) => error(observation, ...best) < threshold,
  )
  const support = inliers.reduce(
    (sum, observation) => sum + observation.weight,
    0,
  )
  if (inliers.length < 3 || support < 0.28 || support / totalWeight < 0.58)
    return null
  const spread =
    Math.max(...inliers.map((observation) => observation.position)) -
    Math.min(...inliers.map((observation) => observation.position))
  if (spread < 0.12) return null
  const [direction, rawConvergence] = leastSquares(inliers)
  const convergence = Math.abs(rawConvergence) < 0.035 ? 0 : rawConvergence
  const residual =
    inliers.reduce(
      (sum, observation) =>
        sum + error(observation, direction, convergence) * observation.weight,
      0,
    ) / support
  if (
    residual > threshold * 0.65 ||
    Math.abs(convergence) > 1.4 ||
    Math.abs(direction) > 0.6
  )
    return null
  const confidence =
    Math.min(1, inliers.length / 6) *
    Math.min(1, spread / 0.35) *
    (support / totalWeight) *
    Math.max(0, 1 - residual / threshold)
  return { direction, convergence, confidence, count: inliers.length, support }
}

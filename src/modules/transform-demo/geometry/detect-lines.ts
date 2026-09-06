import { fitFamily } from '~/modules/transform-demo/geometry/fit-family'
import type {
  AnalysisImage,
  LineSegment,
} from '~/modules/transform-demo/geometry/types'

interface Edge {
  x: number
  y: number
  angle: number
  strength: number
}

interface Peak {
  angle: number
  rho: number
  votes: number
}

function luminance(
  image: AnalysisImage,
  width: number,
  height: number,
  liftShadows: boolean,
): Float32Array {
  const result = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.min(
        image.width - 1,
        Math.floor(((x + 0.5) * image.width) / width),
      )
      const sy = Math.min(
        image.height - 1,
        Math.floor(((y + 0.5) * image.height) / height),
      )
      const offset = (sy * image.width + sx) * 4
      result[y * width + x] =
        ((image.data[offset] * 0.2126 +
          image.data[offset + 1] * 0.7152 +
          image.data[offset + 2] * 0.0722) *
          image.data[offset + 3]) /
        255
    }
  }
  if (liftShadows) {
    for (let index = 0; index < result.length; index++) {
      result[index] = Math.sqrt(result[index] / 255) * 255
    }
  }
  const blurred = new Float32Array(result.length)
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x
      blurred[p] =
        (result[p] * 4 +
          (result[p - 1] +
            result[p + 1] +
            result[p - width] +
            result[p + width]) *
            2 +
          result[p - width - 1] +
          result[p - width + 1] +
          result[p + width - 1] +
          result[p + width + 1]) /
        16
    }
  }
  return blurred
}

function findEdges(
  gray: Float32Array,
  width: number,
  height: number,
  weak: boolean,
  wide: boolean,
): Edge[] {
  const magnitudes = new Float32Array(gray.length)
  const angles = new Float32Array(gray.length)
  let maximum = 0
  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      const p = y * width + x
      const gx =
        gray[p - width + 1] +
        2 * gray[p + 1] +
        gray[p + width + 1] -
        gray[p - width - 1] -
        2 * gray[p - 1] -
        gray[p + width - 1]
      const gy =
        gray[p + width - 1] +
        2 * gray[p + width] +
        gray[p + width + 1] -
        gray[p - width - 1] -
        2 * gray[p - width] -
        gray[p - width + 1]
      const magnitude = Math.hypot(gx, gy)
      magnitudes[p] = magnitude
      angles[p] = (Math.atan2(gy, gx) + Math.PI) % Math.PI
      maximum = Math.max(maximum, magnitude)
    }
  }
  const threshold = weak
    ? wide
      ? Math.max(12, maximum * 0.035)
      : Math.max(20, maximum * 0.05)
    : Math.max(45, maximum * 0.13)
  const edges: Edge[] = []
  for (let y = 3; y < height - 3; y++) {
    for (let x = 3; x < width - 3; x++) {
      const p = y * width + x
      if (magnitudes[p] < threshold) continue
      const angle = angles[p]
      const offset =
        Math.abs(Math.cos(angle)) > Math.abs(Math.sin(angle)) ? 1 : width
      if (
        magnitudes[p] < magnitudes[p - offset] ||
        magnitudes[p] <= magnitudes[p + offset]
      )
        continue
      edges.push({
        x,
        y,
        angle,
        strength: Math.max(weak ? 0.5 : 0, Math.min(2, magnitudes[p] / 128)),
      })
    }
  }
  return edges.length > width * height * 0.2 ? [] : edges
}

function findPeaks(
  edges: Edge[],
  width: number,
  height: number,
  weak: boolean,
  wide: boolean,
): Peak[] {
  const diagonal = Math.ceil(Math.hypot(width, height))
  const stride = diagonal * 2 + 1
  const accumulator = new Float32Array(180 * stride)
  const cosines = Array.from({ length: 180 }, (_, index) =>
    Math.cos((index * Math.PI) / 180),
  )
  const sines = Array.from({ length: 180 }, (_, index) =>
    Math.sin((index * Math.PI) / 180),
  )
  for (const edge of edges) {
    const normal = Math.round((edge.angle * 180) / Math.PI)
    const angleRadius = wide ? 10 : 3
    for (let offset = -angleRadius; offset <= angleRadius; offset++) {
      const angle = (normal + offset + 180) % 180
      const rho =
        Math.round(edge.x * cosines[angle] + edge.y * sines[angle]) + diagonal
      accumulator[angle * stride + rho] += edge.strength
    }
  }
  const candidates: Peak[] = []
  const minimum = weak
    ? Math.max(20, Math.min(width, height) * 0.065)
    : Math.max(24, Math.min(width, height) * 0.11)
  for (let angle = 0; angle < 180; angle++) {
    for (let rho = 1; rho < stride - 1; rho++) {
      const index = angle * stride + rho
      const votes = accumulator[index]
      if (
        votes < minimum ||
        votes < accumulator[index - 1] ||
        votes <= accumulator[index + 1]
      )
        continue
      candidates.push({ angle, rho: rho - diagonal, votes })
    }
  }
  candidates.sort((left, right) => right.votes - left.votes)
  const peaks: Peak[] = []
  for (const candidate of candidates) {
    if (
      peaks.some((peak) => {
        const angleDifference = Math.abs(peak.angle - candidate.angle)
        return (
          (angleDifference <= 3 && Math.abs(peak.rho - candidate.rho) < 5) ||
          (angleDifference >= 177 && Math.abs(peak.rho + candidate.rho) < 5)
        )
      })
    )
      continue
    peaks.push(candidate)
    if (peaks.length >= (weak ? 180 : 100)) break
  }
  return peaks
}

function fitSegment(points: Edge[], minimumLength: number): LineSegment | null {
  if (points.length < minimumLength * 0.45) return null
  const cx = points.reduce((sum, point) => sum + point.x, 0) / points.length
  const cy = points.reduce((sum, point) => sum + point.y, 0) / points.length
  let xx = 0
  let xy = 0
  let yy = 0
  for (const point of points) {
    xx += (point.x - cx) ** 2
    xy += (point.x - cx) * (point.y - cy)
    yy += (point.y - cy) ** 2
  }
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy)
  const dx = Math.cos(angle)
  const dy = Math.sin(angle)
  const projections = points.map(
    (point) => (point.x - cx) * dx + (point.y - cy) * dy,
  )
  const first = Math.min(...projections)
  const last = Math.max(...projections)
  const length = last - first
  if (length < minimumLength || points.length / length < 0.45) return null
  const error =
    points.reduce(
      (sum, point) => sum + (-(point.x - cx) * dy + (point.y - cy) * dx) ** 2,
      0,
    ) / points.length
  if (error > 2.5) return null
  const kind =
    Math.abs(dx) < 0.57
      ? 'vertical'
      : Math.abs(dy) < 0.57
        ? 'horizontal'
        : 'other'
  return {
    start: { x: cx + first * dx, y: cy + first * dy },
    end: { x: cx + last * dx, y: cy + last * dy },
    length,
    kind,
    strength: Math.min(1, points.length / length) / (1 + error),
  }
}

function duplicate(first: LineSegment, second: LineSegment): boolean {
  const dx = (first.end.x - first.start.x) / first.length
  const dy = (first.end.y - first.start.y) / first.length
  const sx = (second.end.x - second.start.x) / second.length
  const sy = (second.end.y - second.start.y) / second.length
  if (Math.abs(dx * sy - dy * sx) > 0.035) return false
  const distance = (point: { x: number; y: number }) =>
    Math.abs((point.x - first.start.x) * dy - (point.y - first.start.y) * dx)
  if (distance(second.start) > 6 || distance(second.end) > 6) return false
  const start =
    (second.start.x - first.start.x) * dx +
    (second.start.y - first.start.y) * dy
  const end =
    (second.end.x - first.start.x) * dx + (second.end.y - first.start.y) * dy
  return Math.min(start, end) < first.length + 8 && Math.max(start, end) > -8
}

function detectAtThreshold(
  image: AnalysisImage,
  weak: boolean,
  wide = false,
): LineSegment[] {
  const scale = Math.min(1, 640 / Math.max(image.width, image.height))
  const width = Math.max(1, Math.round(image.width * scale))
  const height = Math.max(1, Math.round(image.height * scale))
  const edges = findEdges(
    luminance(image, width, height, weak),
    width,
    height,
    weak,
    wide,
  )
  const peaks = findPeaks(edges, width, height, weak, wide)
  const segments: LineSegment[] = []
  const minimumLength = Math.max(30, Math.min(width, height) * 0.1)
  for (const peak of peaks) {
    const angle = (peak.angle * Math.PI) / 180
    const cosine = Math.cos(angle)
    const sine = Math.sin(angle)
    const points = edges.filter(
      (edge) =>
        Math.abs(edge.x * cosine + edge.y * sine - peak.rho) < 2.2 &&
        Math.abs(Math.cos(edge.angle - angle)) > 0.97,
    )
    points.sort(
      (left, right) =>
        -left.x * sine + left.y * cosine - (-right.x * sine + right.y * cosine),
    )
    let first = 0
    for (let index = 1; index <= points.length; index++) {
      if (
        index < points.length &&
        Math.hypot(
          points[index].x - points[index - 1].x,
          points[index].y - points[index - 1].y,
        ) < 10
      )
        continue
      const segment = fitSegment(points.slice(first, index), minimumLength)
      if (segment) segments.push(segment)
      first = index
    }
  }
  segments.sort(
    (left, right) =>
      right.length * right.strength - left.length * left.strength,
  )
  const unique: LineSegment[] = []
  for (const segment of segments) {
    if (!unique.some((existing) => duplicate(existing, segment)))
      unique.push(segment)
    if (unique.length >= (weak ? 128 : 64)) break
  }
  return unique.map((line) => {
    const start = {
      x: (line.start.x * image.width) / width,
      y: (line.start.y * image.height) / height,
    }
    const end = {
      x: (line.end.x * image.width) / width,
      y: (line.end.y * image.height) / height,
    }
    return {
      ...line,
      start,
      end,
      length: Math.hypot(end.x - start.x, end.y - start.y),
    }
  })
}

export function detectLines(image: AnalysisImage): LineSegment[] {
  const strong = detectAtThreshold(image, false)
  const kinds = ['vertical', 'horizontal'] as const
  const confidence = (lines: LineSegment[], kind: (typeof kinds)[number]) =>
    fitFamily(lines, kind, image.width, image.height)?.confidence ?? 0
  if (kinds.every((kind) => confidence(strong, kind) >= 0.65)) return strong
  const shadows = detectAtThreshold(image, true)
  const candidates = [strong, shadows]
  if (kinds.every((kind) => confidence(shadows, kind) < 0.3))
    candidates.push(detectAtThreshold(image, true, true))
  const selected = strong.filter((line) => line.kind === 'other')
  for (const kind of kinds) {
    const best = candidates.reduce((previous, current) =>
      confidence(current, kind) > confidence(previous, kind)
        ? current
        : previous,
    )
    selected.push(...best.filter((line) => line.kind === kind))
  }
  return selected
}

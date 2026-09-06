export type Matrix3 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
]

export interface Point {
  x: number
  y: number
}

export type UprightMode = 'off' | 'auto' | 'level' | 'vertical' | 'full'

export interface LineSegment {
  start: Point
  end: Point
  length: number
  kind: 'vertical' | 'horizontal' | 'other'
  strength: number
}

export interface UprightSolution {
  matrix: Matrix3
  confidence: number
  status: 'corrected' | 'unchanged' | 'insufficient'
  reason: string
  rotationDegrees: number
}

export interface UprightAnalysis {
  lines: LineSegment[]
  solutions: Record<UprightMode, UprightSolution>
}

export interface AnalysisImage {
  data: Uint8ClampedArray
  width: number
  height: number
}

import { vi } from 'vitest'

import { identityMatrix } from '~/modules/transform-demo/geometry/matrix'
import { NEUTRAL_TRANSFORM } from '~/modules/transform-demo/transform-types'

import type { RawTransformFeature } from '../../hooks/useRawTransformFeature'

export function transformFeatureFixture(
  overrides: Partial<RawTransformFeature> = {},
): RawTransformFeature {
  return {
    demo: {
      source: null,
      analysis: null,
      result: null,
      mode: 'off',
      setMode: vi.fn(),
      manual: NEUTRAL_TRANSFORM,
      setManual: vi.fn(),
      constrainCrop: true,
      setConstrainCrop: vi.fn(),
      loading: false,
      rendering: false,
      error: null,
      analysisMs: 0,
      loadSource: vi.fn(),
      clearSource: vi.fn(),
      reset: vi.fn(),
      ready: false,
      solution: {
        matrix: identityMatrix(),
        confidence: 0,
        status: 'unchanged',
        reason: '',
        rotationDegrees: 0,
      },
    },
    active: false,
    available: false,
    hasImage: false,
    observe: vi.fn(() => vi.fn()),
    busy: false,
    captureError: false,
    current: false,
    before: false,
    setBefore: vi.fn(),
    showLines: false,
    setShowLines: vi.fn(),
    showGrid: false,
    setShowGrid: vi.fn(),
    setMode: vi.fn(),
    setManual: vi.fn(),
    setConstrainCrop: vi.fn(),
    reset: vi.fn(),
    setCpuFrame: vi.fn(),
    isProcessing: false,
    showOverlay: false,
    download: vi.fn(),
    downloading: false,
    downloadError: false,
    ...overrides,
  }
}

import { vi } from 'vitest'

import { identityMatrix } from '~/lib/transform/geometry/matrix'
import { NEUTRAL_TRANSFORM } from '~/lib/transform/transform-types'

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
      matrix: null,
      // No render has been answered yet.
      acknowledged: null,
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
    previewSuspended: false,
    hasImage: false,
    observe: vi.fn(() => vi.fn()),
    busy: false,
    captureError: false,
    current: false,
    // A neutral Transform holds no geometry, so nothing blocks export.
    exportBlock: null,
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
    ...overrides,
  }
}

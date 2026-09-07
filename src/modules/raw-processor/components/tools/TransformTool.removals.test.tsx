import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { transformFeatureFixture } from './transform-feature.fixture'
import { TransformTool } from './TransformTool'

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    vi.fn(() => ({
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    })),
  )
})
afterEach(() => vi.unstubAllGlobals())

it('keeps the RAW Transform tool free of the removed comparison and preview-save UI', () => {
  const feature = transformFeatureFixture({
    hasImage: true,
    available: true,
    current: true,
  })
  feature.demo = {
    ...feature.demo,
    ready: true,
    result: {
      frame: { width: 1280, height: 960, data: new Uint8ClampedArray(0) },
      displayMatrix: feature.demo.solution.matrix,
      retainedArea: 0.64,
    },
  }
  const { container } = render(<TransformTool feature={feature} />)
  expect(
    screen.queryByRole('button', { name: /before transform|after transform/i }),
  ).toBeNull()
  expect(screen.queryByRole('button', { name: /save preview/i })).toBeNull()
  expect(container).not.toHaveTextContent(/preview JPEG|1600|1280 × 960/i)
})

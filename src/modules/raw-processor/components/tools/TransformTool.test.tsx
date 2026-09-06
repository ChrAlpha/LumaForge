import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { identityMatrix } from '~/modules/transform-demo/geometry/matrix'
import { NEUTRAL_TRANSFORM } from '~/modules/transform-demo/transform-types'

import type { RawTransformFeature } from '../../hooks/useRawTransformFeature'
import { TransformTool } from './TransformTool'

function featureFixture(
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

describe('transformTool', () => {
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
  it('observes the current RAW only while mounted and never loads a sample', () => {
    const stop = vi.fn()
    const feature = featureFixture({ observe: vi.fn(() => stop) })
    const { unmount, container } = render(<TransformTool feature={feature} />)
    expect(feature.observe).toHaveBeenCalledOnce()
    expect(feature.demo.loadSource).not.toHaveBeenCalled()
    expect(
      screen.getByText('Open a RAW photo to adjust its perspective.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Auto' })).toBeDisabled()
    expect(container.querySelector('canvas, img')).toBeNull()
    unmount()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('keeps reset available after capture fails while disabling stale preview saving', () => {
    const feature = featureFixture({
      hasImage: true,
      active: true,
      captureError: true,
      busy: true,
    })
    render(<TransformTool feature={feature} />)
    expect(
      screen.getByText(
        'The processed preview is unavailable. Wait for it or reset Transform.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Save preview JPEG' }),
    ).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(feature.reset).toHaveBeenCalledOnce()
    expect(feature.download).not.toHaveBeenCalled()
  })

  it('uses transform comparison and saves only a current processed preview', () => {
    const feature = featureFixture({
      hasImage: true,
      available: true,
      current: true,
    })
    render(<TransformTool feature={feature} />)
    fireEvent.click(screen.getByRole('button', { name: 'Before transform' }))
    expect(feature.setBefore).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: 'After transform' }))
    expect(feature.setBefore).toHaveBeenCalledWith(false)
    fireEvent.click(screen.getByRole('button', { name: 'Grid' }))
    expect(feature.setShowGrid).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: 'Save preview JPEG' }))
    expect(feature.download).toHaveBeenCalledOnce()
    expect(
      screen.getByText(/Perspective preview, up to 1600 px/),
    ).toBeInTheDocument()
  })
})

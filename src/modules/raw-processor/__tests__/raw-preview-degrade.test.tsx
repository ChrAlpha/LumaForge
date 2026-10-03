/**
 * Tests for the CPU preview safety-net degraded path in RawProcessorView.
 *
 * Task 8 — verify that:
 *   - degraded/cpu renders the normal workspace shell (NOT full-page UnsupportedState)
 *   - degraded/cpu renders CpuPreviewBanner; GPU PreviewCanvas is absent
 *   - unsupported/coi-missing still renders the full-page UnsupportedState block
 */

import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RawProcessorView } from '../RawProcessorView'
import { resetToDefaults } from '../state/workflow.atoms'

// Mock capability gate — same pattern as raw-route-shell.test.tsx
vi.mock('../hooks/useCapabilityGate', () => ({
  useCapabilityGate: vi.fn(),
}))

// Mock useCpuPreview so it doesn't try to spin up a worker in jsdom
vi.mock('../hooks/useCpuPreview', () => ({
  useCpuPreview: vi.fn(() => ({
    frame: null,
    inFlight: false,
    failureReason: null,
  })),
}))

const mockedUseCapabilityGate = vi.mocked(
  (await import('../hooks/useCapabilityGate')).useCapabilityGate,
)

beforeEach(() => {
  resetToDefaults()
  localStorage.clear()

  mockedUseCapabilityGate.mockReset()

  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

describe('rawProcessorView CPU preview degraded path', () => {
  it('renders workspace shell (not UnsupportedState) when degraded/cpu with gpu-preview-failed', () => {
    mockedUseCapabilityGate.mockReturnValue({
      ready: true,
      supportStatus: 'degraded',
      previewMode: 'cpu',
      reason: 'gpu-preview-failed',
    })

    const { container } = render(<RawProcessorView />)

    // Must NOT render the full-page unsupported block
    expect(
      screen.queryByText('This browser cannot run the RAW Lab'),
    ).not.toBeInTheDocument()

    // Must render the normal workspace viewport shell
    const viewportShell = container.querySelector(
      '[data-raw-lab-shell="viewport"]',
    )
    expect(viewportShell).not.toBeNull()
    expect(viewportShell).not.toHaveAttribute(
      'data-raw-lab-state',
      'unsupported',
    )

    // CPU degrade banner must be present
    const banner = container.querySelector('[data-cpu-preview-banner]')
    expect(banner).not.toBeNull()

    // GPU PreviewCanvas must NOT be in the DOM
    // PreviewCanvas renders a canvas inside a .raw-lab-preview-frame element;
    // the specific marker is the data attribute set on the canvas wrapper.
    expect(container.querySelector('[data-preview-canvas]')).toBeNull()

    // Empty CPU mode must keep the normal RAW chooser instead of showing the
    // post-decode CPU-preview failure placeholder.
    expect(
      screen.getByRole('button', { name: /choose raw/i }),
    ).toBeInTheDocument()
    expect(
      container.querySelector('[data-testid="cpu-preview-unavailable"]'),
    ).toBeNull()
  })

  it('renders workspace shell (not UnsupportedState) when degraded/cpu with webgpu-unavailable', () => {
    mockedUseCapabilityGate.mockReturnValue({
      ready: true,
      supportStatus: 'degraded',
      previewMode: 'cpu',
      reason: 'webgpu-unavailable',
    })

    const { container } = render(<RawProcessorView />)

    expect(
      screen.queryByText('This browser cannot run the RAW Lab'),
    ).not.toBeInTheDocument()

    const banner = container.querySelector('[data-cpu-preview-banner]')
    expect(banner).not.toBeNull()
  })

  it('renders full-page UnsupportedState when unsupported/coi-missing', () => {
    mockedUseCapabilityGate.mockReturnValue({
      ready: true,
      supportStatus: 'unsupported',
      previewMode: null,
      reason: 'coi-missing',
    })

    const { container } = render(<RawProcessorView />)

    // Full-page unsupported block must be present
    expect(
      screen.getByText('This browser cannot run the RAW Lab'),
    ).toBeInTheDocument()

    const viewportShell = container.querySelector(
      '[data-raw-lab-shell="viewport"]',
    )
    expect(viewportShell).toHaveAttribute('data-raw-lab-state', 'unsupported')

    // The reason shown must NOT be the raw literal 'coi-missing'
    expect(screen.queryByText('coi-missing')).not.toBeInTheDocument()
  })
})

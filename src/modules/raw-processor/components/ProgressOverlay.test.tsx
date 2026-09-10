import { render, screen } from '@testing-library/react'
import { createStore, Provider } from 'jotai'
import { describe, expect, it } from 'vitest'

import type { ImageSession } from '../model/session'
import { currentSessionAtom } from '../state/session.atoms'
import { ProgressOverlay } from './ProgressOverlay'

function renderOverlayWithActivePlan(
  activePlan: ImageSession['exportState']['activePlan'],
) {
  const store = createStore()
  store.set(currentSessionAtom, {
    id: 's1',
    exportState: {
      activePlan,
      lastProgress: undefined,
    },
  } as ImageSession)

  return render(
    <Provider store={store}>
      <ProgressOverlay visible phase="exporting" />
    </Provider>,
  )
}

describe('progressOverlay', () => {
  it('uses the flat export handoff instead of the generic stage panel', () => {
    const { container } = renderOverlayWithActivePlan(undefined)

    const overlay = screen.getByRole('status')
    expect(overlay).toHaveAttribute('data-progress-overlay', 'exporting')
    expect(overlay).toHaveAttribute('data-progress-variant', 'flat-handoff')
    expect(overlay).toHaveClass('raw-progress-overlay')
    expect(overlay).toHaveClass('absolute')
    expect(overlay).not.toHaveClass('fixed')
    expect(container).toContainElement(overlay)
    expect(overlay.parentElement).not.toBe(document.body)
    expect(overlay).not.toHaveClass('bg-[var(--color-stage-scrim)]')
    expect(overlay.querySelector('[data-progress-panel]')).toBeNull()
    expect(
      overlay.querySelector('[data-progress-flat-handoff]'),
    ).toBeInTheDocument()
  })

  it('labels low-memory mobile-balanced exports as safe exports', () => {
    renderOverlayWithActivePlan({
      profileName: 'mobile-balanced',
      preferredRows: 256,
      concurrency: 2,
      runtimeMemoryProfile: 'low-memory',
      outputSink: 'streaming',
      checkpointMode: 'safe-retry',
    })

    expect(
      screen.getByText('Safe export · 256 rows · 2 workers'),
    ).toBeInTheDocument()
  })

  it('uses the same flat export handoff for desktop plans', () => {
    renderOverlayWithActivePlan({
      profileName: 'desktop-fast',
      preferredRows: 1024,
      concurrency: 3,
      runtimeMemoryProfile: 'desktop',
      outputSink: 'streaming',
      checkpointMode: 'safe-retry',
    })

    const overlay = screen.getByRole('status')
    expect(overlay).toHaveAttribute('data-progress-variant', 'flat-handoff')
    expect(overlay.querySelector('[data-progress-panel]')).toBeNull()
    expect(
      overlay.querySelector('[data-progress-flat-handoff]'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Preview released for memory-safe export'),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'LumaForge freed the GPU preview before encoding this full-resolution JPEG.',
      ),
    ).toBeInTheDocument()
  })

  it('labels desktop exports as high-performance exports', () => {
    renderOverlayWithActivePlan({
      profileName: 'desktop-fast',
      preferredRows: 1024,
      concurrency: 3,
      runtimeMemoryProfile: 'desktop',
      outputSink: 'streaming',
      checkpointMode: 'safe-retry',
    })

    expect(
      screen.getByText('High-performance export · 1024 rows · 3 workers'),
    ).toBeInTheDocument()
  })
})

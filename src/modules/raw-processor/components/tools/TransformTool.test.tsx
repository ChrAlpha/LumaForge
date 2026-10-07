import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RawTransformFeature } from '../../hooks/useRawTransformFeature'
import type { ToolAvailability } from '../../services/surface/derive-tool-availability'
import type {
  TransformToolState,
  TransformToolStateName,
} from './transform-feature.fixture'
import {
  TRANSFORM_TOOL_STATES,
  transformToolStateFixture,
} from './transform-feature.fixture'
import { TransformTool } from './TransformTool'

function desktop(
  state: TransformToolState,
  overrides: Partial<RawTransformFeature> = {},
) {
  return transformToolStateFixture('desktop', state, overrides)
}

function renderTool({
  feature,
  availability,
}: {
  feature: RawTransformFeature
  availability: ToolAvailability
}) {
  const result = render(
    <TransformTool feature={feature} availability={availability} />,
  )
  return {
    ...result,
    rerender: (next: {
      feature: RawTransformFeature
      availability: ToolAvailability
    }) =>
      result.rerender(
        <TransformTool
          feature={next.feature}
          availability={next.availability}
        />,
      ),
  }
}

function enabled(element: HTMLElement) {
  return !element.hasAttribute('disabled')
}

/** What the card offers, read off the controls on screen. */
function renderedControls() {
  const modes = within(
    screen.getByRole('group', { name: 'Upright mode' }),
  ).getAllByRole('button')
  const sliders = screen
    .getAllByRole('slider')
    .map((slider) => slider.closest<HTMLElement>('[data-slot="slider-root"]')!)
  const geometry = [
    ...modes.map(enabled),
    ...sliders.map((root) => !root.hasAttribute('data-disabled')),
    enabled(screen.getByRole('checkbox', { name: 'Constrain crop' })),
  ]
  const overlay = within(screen.getByRole('group', { name: 'View aids' }))
    .getAllByRole('button')
    .map(enabled)
  expect(modes).toHaveLength(5)
  expect(sliders).toHaveLength(7)
  expect(overlay).toHaveLength(2)
  // Every control of an action answers to that action alone.
  for (const group of [geometry, overlay]) expect(new Set(group).size).toBe(1)
  return {
    geometry: geometry[0],
    overlay: overlay[0],
    reset: enabled(screen.getByRole('button', { name: 'Reset' })),
  }
}

const S = TRANSFORM_TOOL_STATES

describe('transformTool', () => {
  beforeEach(() => {
    vi.stubGlobal('PointerEvent', MouseEvent)
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
    const state = desktop(S.noSource, { observe: vi.fn(() => stop) })
    const { feature } = state
    const { unmount, container } = renderTool(state)
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

  // Each row is the selector's answer for that state, written out: the
  // geometry (modes, sliders, crop), the view aids, and Reset for an intent
  // that has something to reset. Without a source the intent is neutral.
  const expected: Record<
    TransformToolStateName,
    { geometry: boolean; overlay: boolean; reset: boolean }
  > = {
    ready: { geometry: true, overlay: true, reset: true },
    noSource: { geometry: false, overlay: false, reset: false },
    noFrame: { geometry: false, overlay: false, reset: true },
    workerPending: { geometry: false, overlay: false, reset: true },
    captureFailed: { geometry: false, overlay: false, reset: true },
    loading: { geometry: false, overlay: false, reset: false },
    decoding: { geometry: false, overlay: false, reset: false },
    exporting: { geometry: false, overlay: false, reset: false },
    released: { geometry: false, overlay: false, reset: false },
    warming: { geometry: true, overlay: true, reset: true },
    processing: { geometry: true, overlay: true, reset: true },
  }
  it.each(
    Object.entries(expected) as Array<
      [TransformToolStateName, (typeof expected)[TransformToolStateName]]
    >,
  )('offers the controls the action policy allows: %s', (name, controls) => {
    const state = S[name]
    const fixture = desktop(state)
    if (state.hasImage) {
      fixture.feature.demo = {
        ...fixture.feature.demo,
        manual: { ...fixture.feature.demo.manual, scale: 120 },
      }
    }
    renderTool(fixture)
    expect(renderedControls()).toEqual(controls)
  })

  it('reads every control from its action, not from the feature', () => {
    const { feature } = desktop(S.ready)
    feature.demo = {
      ...feature.demo,
      manual: { ...feature.demo.manual, scale: 120 },
    }
    renderTool({ feature, availability: desktop(S.released).availability })
    expect(renderedControls()).toEqual({
      geometry: false,
      overlay: false,
      reset: false,
    })
  })

  it('keeps Reset available after a failed active transform', () => {
    const fixture = desktop(S.captureFailed, { active: true, busy: true })
    const { feature } = fixture
    feature.demo = { ...feature.demo, mode: 'auto' }
    renderTool(fixture)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The processed preview is unavailable. Wait for it or reset Transform.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(feature.reset).toHaveBeenCalledOnce()
  })

  it('offers modes, view aids and independent geometry controls', () => {
    const fixture = desktop(S.ready)
    const { feature } = fixture
    renderTool(fixture)
    expect(screen.getByRole('slider', { name: 'Scale' })).toHaveAttribute(
      'aria-valuetext',
      '100%',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Auto' }))
    expect(feature.setMode).toHaveBeenCalledWith('auto')
    fireEvent.click(screen.getByRole('button', { name: 'Grid' }))
    expect(feature.setShowGrid).toHaveBeenCalledWith(true)
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Scale' }), {
      key: 'ArrowRight',
    })
    expect(feature.setManual).toHaveBeenCalledWith({
      ...feature.demo.manual,
      scale: 101,
    })
  })

  it('explains abstention and allows manual correction', () => {
    const fixture = desktop(S.ready)
    const { feature, availability } = fixture
    feature.demo = {
      ...feature.demo,
      mode: 'auto',
      solution: { ...feature.demo.solution, status: 'insufficient' },
    }
    const { rerender } = renderTool(fixture)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Not enough reliable structure. Try manual adjustments.',
    )
    expect(screen.getByRole('slider', { name: 'Rotate' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    )
    rerender({
      feature: { ...feature, demo: { ...feature.demo, mode: 'off' } },
      availability,
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('points at Restore preview once export released it, not at waiting', () => {
    renderTool(desktop(S.released))

    // "Wait for it" would be a lie here: the preview only comes back when the
    // photographer restores it, and that button is already on screen.
    expect(screen.getByRole('status')).toHaveTextContent(
      'Restore the preview to keep adjusting Transform.',
    )
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('resets the Scale readout to 100 percent without changing other fields', () => {
    const fixture = desktop(S.ready)
    const { feature } = fixture
    feature.demo = {
      ...feature.demo,
      manual: { ...feature.demo.manual, scale: 120, rotate: 2 },
    }
    renderTool(fixture)
    expect(screen.getByRole('slider', { name: 'Scale' })).toHaveAttribute(
      'aria-valuetext',
      '120%',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reset Scale' }))
    expect(feature.setManual).toHaveBeenCalledWith({
      ...feature.demo.manual,
      scale: 100,
    })
  })

  it('allows a full reset when only constrain crop has changed', () => {
    const fixture = desktop(S.noFrame)
    const { feature } = fixture
    feature.demo = { ...feature.demo, constrainCrop: false }
    renderTool(fixture)
    const reset = screen.getByRole('button', { name: 'Reset' })
    expect(reset).toBeEnabled()
    fireEvent.click(reset)
    expect(feature.reset).toHaveBeenCalledOnce()
  })

  it('keeps Reset off for an intent with nothing to reset', () => {
    renderTool(desktop(S.ready))
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled()
  })

  it('ignores an existing scrub after processing disables the controls', () => {
    const fixture = desktop(S.ready)
    const { feature } = fixture
    const { rerender } = renderTool(fixture)
    const row = screen
      .getByRole('slider', { name: 'Scale' })
      .closest('[data-adjust-row]')!
    vi.spyOn(
      row.querySelector('[data-slot="slider-track"]')!,
      'getBoundingClientRect',
    ).mockReturnValue({ left: 0, top: 0, width: 200, height: 10 } as DOMRect)
    fireEvent.pointerDown(row, { clientX: 100, clientY: 5, buttons: 1 })
    expect(row).toHaveAttribute('data-scrubbing', 'true')
    vi.mocked(feature.setManual).mockClear()
    rerender(desktop(S.decoding, { setManual: feature.setManual }))
    fireEvent.pointerMove(row, { clientX: 160, clientY: 5, buttons: 1 })
    fireEvent.pointerUp(row, { clientX: 160, clientY: 5 })
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Scale' }), {
      key: 'ArrowRight',
    })
    expect(feature.setManual).not.toHaveBeenCalled()
  })
})

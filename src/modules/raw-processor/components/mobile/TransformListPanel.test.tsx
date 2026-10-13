import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RawTransformFeature } from '../../hooks/useRawTransformFeature'
import type { ToolAvailability } from '../../services/surface/derive-tool-availability'
import type {
  TransformToolState,
  TransformToolStateName,
} from '../shared/transform-feature.fixture'
import {
  patchTransformPreview,
  TRANSFORM_TOOL_STATES,
  transformPreviewOf,
  transformToolStateFixture,
  withTransformPreview,
} from '../shared/transform-feature.fixture'
import { TransformListPanel } from './TransformListPanel'

const S = TRANSFORM_TOOL_STATES

interface PanelState {
  feature: RawTransformFeature
  availability: ToolAvailability
}

/** A panel state with geometry in every section, so each has a reset. */
function mobile(
  state: TransformToolState,
  overrides: Partial<RawTransformFeature> = {},
): PanelState {
  const fixture = transformToolStateFixture('mobile', state, overrides)
  if (state.hasImage)
    patchTransformPreview(fixture.feature, {
      manual: { scale: 120, rotate: 2 },
    })
  return fixture
}

function readyPanel(overrides: Partial<RawTransformFeature> = {}) {
  return mobile(S.ready, overrides)
}

async function openSection(name: 'Upright' | 'Perspective' | 'Frame') {
  fireEvent.click(screen.getByRole('tab', { name }))
  if (name === 'Upright') {
    return screen.findByRole('group', { name: 'Upright mode' })
  }
  return screen.findByRole('slider', {
    name: name === 'Frame' ? 'Scale' : 'Rotate',
  })
}

async function openFrame() {
  return openSection('Frame')
}

const onScrubChange = vi.fn()
function renderPanel({ feature, availability }: PanelState) {
  const result = render(
    <TransformListPanel
      feature={feature}
      availability={availability}
      onScrubChange={onScrubChange}
    />,
  )
  return {
    ...result,
    rerender: (next: PanelState) =>
      result.rerender(
        <TransformListPanel
          feature={next.feature}
          availability={next.availability}
          onScrubChange={onScrubChange}
        />,
      ),
  }
}

function enabled(element: HTMLElement) {
  return !element.hasAttribute('disabled')
}

function sectionReset(name: string) {
  return enabled(screen.getByRole('button', { name: `Reset ${name}` }))
}

function slidersEnabled() {
  return screen
    .getAllByRole('slider')
    .map(
      (slider) =>
        !slider
          .closest('[data-slot="slider-root"]')!
          .hasAttribute('data-disabled'),
    )
}

/** What the panel offers, read off the controls in every section. */
async function renderedControls() {
  const geometry: boolean[] = []
  const reset: boolean[] = []
  const modes = within(await openSection('Upright')).getAllByRole('button')
  expect(modes).toHaveLength(5)
  geometry.push(...modes.map(enabled))
  const overlay = within(screen.getByRole('group', { name: 'View aids' }))
    .getAllByRole('button')
    .map(enabled)
  expect(overlay).toHaveLength(2)
  reset.push(sectionReset('Upright'))

  await openSection('Perspective')
  geometry.push(...slidersEnabled())
  reset.push(sectionReset('Perspective'))

  await openFrame()
  geometry.push(
    ...slidersEnabled(),
    enabled(screen.getByRole('checkbox', { name: 'Constrain crop' })),
  )
  reset.push(sectionReset('Frame'))

  expect(geometry).toHaveLength(5 + 4 + 3 + 1)
  // Every control of an action answers to that action alone.
  for (const group of [geometry, overlay, reset])
    expect(new Set(group).size).toBe(1)
  return { geometry: geometry[0], overlay: overlay[0], reset: reset[0] }
}

describe('transformListPanel', () => {
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
  afterEach(() => {
    vi.unstubAllGlobals()
    onScrubChange.mockClear()
  })

  // Each row is the selector's answer for that state, written out: the
  // geometry (modes, sliders, crop), the view aids, and every section's
  // reset for an intent that has something to reset. Without a source the
  // intent is neutral. Reaching the panel at all is the deck's business:
  // while the runtime warms or the look reprocesses, mobile keeps the deck
  // closed under the edit rule even though these actions stay open.
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
  )(
    'offers the controls the action policy allows: %s',
    async (name, controls) => {
      renderPanel(mobile(S[name]))
      expect(await renderedControls()).toEqual(controls)
    },
  )

  it('reads every control from its action, not from the feature', async () => {
    const { feature } = readyPanel()
    renderPanel({ feature, availability: mobile(S.released).availability })
    expect(await renderedControls()).toEqual({
      geometry: false,
      overlay: false,
      reset: false,
    })
  })

  it.each(['noFrame', 'captureFailed', 'decoding'] as const)(
    'disables all manual input while %s',
    async (name) => {
      const { feature, availability } = mobile(S[name])
      renderPanel({ feature, availability })
      const scale = await openFrame()
      expect(scale.closest('[data-slot="slider-root"]')).toHaveAttribute(
        'data-disabled',
      )
      const reset = screen.getByRole('button', { name: 'Reset Scale' })
      expect(reset).toBeDisabled()
      fireEvent.keyDown(scale, { key: 'ArrowRight' })
      fireEvent.click(reset)
      const row = scale.closest('[data-adjust-slider-row]')!
      fireEvent.pointerDown(row)
      fireEvent.pointerUp(row)
      expect(feature.setManual).not.toHaveBeenCalled()
    },
  )

  it('keeps every section reset for a dirty failed frame', async () => {
    const { feature, availability } = mobile(S.captureFailed, { active: true })
    patchTransformPreview(feature, { mode: 'auto', constrainCrop: false })
    renderPanel({ feature, availability })
    fireEvent.click(screen.getByRole('button', { name: 'Reset Upright' }))
    expect(feature.reset).toHaveBeenCalledOnce()
    await openFrame()
    fireEvent.click(screen.getByRole('button', { name: 'Reset Frame' }))
    expect(feature.setConstrainCrop).toHaveBeenCalledWith(true)
    expect(feature.setManual).toHaveBeenCalledWith({
      ...transformPreviewOf(feature).manual,
      scale: 100,
    })
  })

  it('ignores a scrub already in progress when processing starts', async () => {
    const panel = readyPanel()
    const { feature } = panel
    const { rerender } = renderPanel(panel)
    const scale = await openFrame()
    const row = scale.closest('[data-adjust-slider-row]')!
    vi.spyOn(
      row.querySelector('[data-slot="slider-track"]')!,
      'getBoundingClientRect',
    ).mockReturnValue({ left: 0, top: 0, width: 200, height: 10 } as DOMRect)
    fireEvent.pointerDown(row, { clientX: 100, clientY: 5, buttons: 1 })
    expect(row).toHaveAttribute('data-scrubbing', 'true')
    vi.mocked(feature.setManual).mockClear()
    rerender(mobile(S.decoding, { setManual: feature.setManual }))
    fireEvent.pointerMove(row, { clientX: 160, clientY: 5, buttons: 1 })
    fireEvent.pointerUp(row, { clientX: 160, clientY: 5 })
    fireEvent.keyDown(scale, { key: 'ArrowRight' })
    expect(feature.setManual).not.toHaveBeenCalled()
    expect(row).not.toHaveAttribute('data-scrubbing')
  })

  it('announces absolute Scale and resets it to 100 percent', async () => {
    const panel = readyPanel()
    const { feature, availability } = panel
    const { rerender } = renderPanel(panel)
    const scale = await openFrame()
    expect(scale).toHaveAttribute('aria-valuetext', '120%')
    fireEvent.click(screen.getByRole('button', { name: 'Reset Scale' }))
    expect(feature.setManual).toHaveBeenCalledWith({
      ...transformPreviewOf(feature).manual,
      scale: 100,
    })
    rerender({
      feature: withTransformPreview(feature, { manual: { scale: 100 } }),
      availability,
    })
    expect(scale).toHaveAttribute('aria-valuetext', '100%')
  })

  it('enables full and Frame reset for a crop-only change', async () => {
    const panel = transformToolStateFixture('mobile', S.noFrame)
    const { feature } = panel
    patchTransformPreview(feature, { constrainCrop: false })
    renderPanel(panel)
    const fullReset = screen.getByRole('button', { name: 'Reset Upright' })
    expect(fullReset).toBeEnabled()
    fireEvent.click(fullReset)
    expect(feature.reset).toHaveBeenCalledOnce()
    await openFrame()
    const frameReset = screen.getByRole('button', { name: 'Reset Frame' })
    expect(frameReset).toBeEnabled()
    fireEvent.click(frameReset)
    expect(feature.setConstrainCrop).toHaveBeenCalledWith(true)
    expect(feature.setManual).toHaveBeenCalledWith(
      transformPreviewOf(feature).manual,
    )
  })

  it('keeps a section reset off while that section is neutral', async () => {
    const panel = readyPanel()
    patchTransformPreview(panel.feature, { manual: { rotate: 0 } })
    renderPanel(panel)
    expect(screen.getByRole('button', { name: 'Reset Upright' })).toBeEnabled()
    await openSection('Perspective')
    expect(
      screen.getByRole('button', { name: 'Reset Perspective' }),
    ).toBeDisabled()
  })

  it('reports the scrubbed field to the shared mobile scrub channel', async () => {
    renderPanel(readyPanel())
    const scale = await openFrame()
    const row = scale.closest('[data-adjust-slider-row]')!
    vi.spyOn(
      row.querySelector('[data-slot="slider-track"]')!,
      'getBoundingClientRect',
    ).mockReturnValue({ left: 0, top: 0, width: 200, height: 10 } as DOMRect)
    fireEvent.pointerDown(row, { clientX: 100, clientY: 5, buttons: 1 })
    // The HUD, the topbar fade and the dock dim all read this one channel.
    expect(onScrubChange).toHaveBeenLastCalledWith({
      kind: 'transform',
      key: 'scale',
    })
    fireEvent.pointerUp(row, { clientX: 100, clientY: 5 })
    expect(onScrubChange).toHaveBeenLastCalledWith(null)
  })

  it('releases the scrub when a section swap unmounts the row', async () => {
    renderPanel(readyPanel())
    const scale = await openFrame()
    const row = scale.closest('[data-adjust-slider-row]')!
    vi.spyOn(
      row.querySelector('[data-slot="slider-track"]')!,
      'getBoundingClientRect',
    ).mockReturnValue({ left: 0, top: 0, width: 200, height: 10 } as DOMRect)
    fireEvent.pointerDown(row, { clientX: 100, clientY: 5, buttons: 1 })
    onScrubChange.mockClear()
    fireEvent.click(screen.getByRole('tab', { name: 'Upright' }))
    expect(onScrubChange).toHaveBeenCalledWith(null)
  })

  it('resets Frame without restoring stale geometry activation or other fields', async () => {
    const panel = readyPanel()
    const { feature } = panel
    patchTransformPreview(feature, { constrainCrop: false })
    renderPanel(panel)
    await openFrame()
    fireEvent.click(screen.getByRole('button', { name: 'Reset Frame' }))
    expect(feature.setManual).toHaveBeenCalledWith({
      ...transformPreviewOf(feature).manual,
      scale: 100,
      offsetX: 0,
      offsetY: 0,
    })
    expect(
      vi.mocked(feature.setConstrainCrop).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(feature.setManual).mock.invocationCallOrder[0])
  })
})

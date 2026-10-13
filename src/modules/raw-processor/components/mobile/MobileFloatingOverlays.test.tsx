import type { PreviewHistogramState } from '@lumaforge/luma-color-runtime'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { RawPreviewHistogramContext } from '../RawWorkflowContext'
import type { MobileFloatingOverlaysProps } from './MobileFloatingOverlays'
import {
  getCpuNoticePlacement,
  getCpuNoticeStyle,
  getPeekPillPlacement,
  MobileFloatingOverlays,
} from './MobileFloatingOverlays'

function renderOverlays({
  histogram = { state: 'unavailable', reason: 'no-image' },
  ...overrides
}: Partial<MobileFloatingOverlaysProps> & {
  histogram?: PreviewHistogramState
} = {}) {
  return render(
    <RawPreviewHistogramContext value={histogram}>
      <MobileFloatingOverlays
        immersive={false}
        focusActive={false}
        hasImage
        handoffActive={false}
        peeking={false}
        histogramOpen={false}
        scrubField={null}
        manualTransform={undefined}
        onExitImmersive={vi.fn()}
        lensVisible
        {...overrides}
      />
    </RawPreviewHistogramContext>,
  )
}

describe('getCpuNoticePlacement', () => {
  it('keeps the CPU notice beside the lens while the photo has room, else below it', () => {
    // A 3:2 landscape at 393px leaves 393 - 8 - 48 = 337px beside the lens.
    expect(getCpuNoticePlacement(393, true)).toBe('side')
    expect(getCpuNoticePlacement(296, true)).toBe('side')
    // A 2:3 portrait in Look (~267px) leaves ~211px: drop under the lens.
    expect(getCpuNoticePlacement(266.7, true)).toBe('below')
    // No lens on screen (empty state, a handoff): the photo's full width.
    expect(getCpuNoticePlacement(393, false)).toBe('full')
    expect(getCpuNoticePlacement(0, true)).toBe('side')
  })

  it('pins the notice 8px inside the photo and never over the lens column', () => {
    const side = getCpuNoticeStyle('side')
    expect(side.top).toBe(
      'calc(max(var(--raw-photo-top, 0px), var(--raw-topbar-height, 0px)) + 8px)',
    )
    expect(side.left).toBe('calc(var(--raw-photo-left, 0px) + 8px)')
    expect(side.right).toBe('calc(var(--raw-photo-right, 0px) + 48px)')

    const below = getCpuNoticeStyle('below')
    expect(below.top).toBe(
      'calc(max(var(--raw-photo-top, 0px), var(--raw-topbar-height, 0px)) + 8px + calc(var(--raw-compare-lens-size, 32px) + 8px))',
    )
    expect(below.right).toBe('calc(var(--raw-photo-right, 0px) + 8px)')
    expect(getCpuNoticeStyle('full').right).toBe(
      'calc(var(--raw-photo-right, 0px) + 8px)',
    )
  })
})

describe('getPeekPillPlacement', () => {
  it('shares the lens row only while the photo holds the pill clear of the lens', () => {
    // 393 - 2 x 48 = 297px between the lens columns.
    expect(getPeekPillPlacement(393, true)).toBe('row')
    expect(getPeekPillPlacement(296, true)).toBe('row')
    // A 2:3 portrait in Look (~267px) leaves ~171px: below the lens row.
    expect(getPeekPillPlacement(266.7, true)).toBe('below')
    // No lens, nothing to clear.
    expect(getPeekPillPlacement(191, false)).toBe('row')
    // Unmeasured: keep the row.
    expect(getPeekPillPlacement(0, true)).toBe('row')
  })
})

describe('mobileFloatingOverlays', () => {
  it('centres the peek pill on the photo rect', () => {
    const { container } = renderOverlays({ peeking: true })
    const pill = container.querySelector('[data-mobile-peek-hint]')!
    expect(pill).toHaveTextContent('Showing unprocessed RAW')
  })

  it('drops the pill below the lens row when asked', () => {
    const { container } = renderOverlays({
      peeking: true,
      peekPlacement: 'below',
    })
    const pill = container.querySelector('[data-mobile-peek-hint]')!
    expect(pill).toHaveAttribute('data-mobile-peek-hint', 'below')
  })

  it('hides the peek pill during a handoff or a scrub', () => {
    const handoff = renderOverlays({ peeking: true, handoffActive: true })
    expect(
      handoff.container.querySelector('[data-mobile-peek-hint]'),
    ).toBeNull()
    handoff.unmount()
    const scrub = renderOverlays({ peeking: true, focusActive: true })
    expect(scrub.container.querySelector('[data-mobile-peek-hint]')).toBeNull()
  })

  it('shows the histogram on the photo only outside scrub, immersive, and handoff', () => {
    const shown = renderOverlays({ histogramOpen: true })
    shown.unmount()
    for (const state of [
      { focusActive: true },
      { immersive: true },
      { handoffActive: true },
    ]) {
      const { container, unmount } = renderOverlays({
        histogramOpen: true,
        ...state,
      })
      expect(container.querySelector('[data-mobile-histogram-card]')).toBeNull()
      unmount()
    }
  })

  it('hands the histogram to the scrub HUD only while the user has it on', () => {
    const luma = new Uint32Array(256)
    luma[128] = 4
    const histogram = {
      state: 'ready',
      source: 'quick',
      width: 2,
      height: 2,
      sampledPixels: 4,
      totalPixels: 4,
      bins: {
        luma,
        red: new Uint32Array(256),
        green: new Uint32Array(256),
        blue: new Uint32Array(256),
      },
      clipping: {
        shadowAnyChannel: 0,
        highlightAnyChannel: 0,
        shadowLuma: 0,
        highlightLuma: 0,
      },
    } as PreviewHistogramState
    const scrub = {
      focusActive: true,
      scrubField: { kind: 'tone', key: 'userContrast' },
      histogram,
    } as const
    const on = renderOverlays({ ...scrub, histogramOpen: true })
    // The card steps aside during a scrub; the curve rides the HUD.
    expect(
      on.container.querySelector('[data-mobile-histogram-card]'),
    ).toBeNull()
    expect(
      on.container.querySelector('[data-scrub-hud-histogram]'),
    ).not.toBeNull()
    on.unmount()

    const off = renderOverlays({ ...scrub, histogramOpen: false })
    expect(off.container.querySelector('[data-scrub-hud-histogram]')).toBeNull()
  })
})

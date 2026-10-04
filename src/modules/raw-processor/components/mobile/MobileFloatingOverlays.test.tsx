import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { COLOR_NEUTRAL } from '../color-fields'
import { TONE_NEUTRAL } from '../tone-fields'
import type { MobileFloatingOverlaysProps } from './MobileFloatingOverlays'
import {
  getCpuNoticePlacement,
  getCpuNoticeStyle,
  getPeekPillPlacement,
  MobileFloatingOverlays,
} from './MobileFloatingOverlays'

function renderOverlays(overrides: Partial<MobileFloatingOverlaysProps> = {}) {
  return render(
    <MobileFloatingOverlays
      immersive={false}
      focusActive={false}
      hasImage
      handoffActive={false}
      peeking={false}
      histogramOpen={false}
      histogram={{ state: 'unavailable', reason: 'no-image' }}
      scrubField={null}
      tone={TONE_NEUTRAL}
      color={COLOR_NEUTRAL}
      selectiveColor={undefined}
      manualTransform={undefined}
      onExitImmersive={vi.fn()}
      lensVisible
      {...overrides}
    />,
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
    expect(pill).toHaveClass(
      'left-[calc(var(--raw-photo-left,0px)+var(--raw-photo-width,100vw)/2)]',
      '-translate-x-1/2',
      'min-h-8',
    )
  })

  it('drops the pill below the lens row when asked', () => {
    const { container } = renderOverlays({
      peeking: true,
      peekPlacement: 'below',
    })
    const pill = container.querySelector('[data-mobile-peek-hint]')!
    expect(pill).toHaveAttribute('data-mobile-peek-hint', 'below')
    expect(pill).toHaveClass(
      'top-[calc(var(--raw-compare-lens-top,8px)+var(--raw-compare-lens-size,32px)+8px)]',
      'max-w-[calc(var(--raw-photo-width,100vw)-16px)]',
    )
  })

  it('lets the pill use the row edge to edge when no lens is on screen', () => {
    const { container } = renderOverlays({ peeking: true, lensVisible: false })
    expect(container.querySelector('[data-mobile-peek-hint]')).toHaveClass(
      'max-w-[calc(var(--raw-photo-width,100vw)-16px)]',
    )
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
    const card = shown.container.querySelector('[data-mobile-histogram-card]')
    // It hangs below the lens on its right edge and never outgrows the photo.
    expect(card).toHaveClass(
      'right-[var(--raw-compare-lens-right,12px)]',
      'w-[min(256px,calc(var(--raw-photo-width,100vw)-16px))]',
    )
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
})

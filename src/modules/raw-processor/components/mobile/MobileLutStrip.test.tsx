import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { LutStripItem } from './mobile-lut-strip'
import { MobileLutStrip, scrollTileIntoStrip } from './MobileLutStrip'

function rect(left: number, width: number): DOMRect {
  return {
    left,
    right: left + width,
    width,
    top: 0,
    bottom: 60,
    height: 60,
    x: left,
    y: 0,
    toJSON: () => ({}),
  }
}

function items(appliedId: string | null): LutStripItem[] {
  const entry = (id: string) => ({
    key: `src:${id}`,
    eyebrow: 'Film',
    applied: id === appliedId,
    entry: {
      id,
      resourceId: 'src',
      title: id,
      sourceUrl: '',
      sourceType: 'catalog-entry' as const,
      cube: { url: '', sha256: id },
      tags: [],
    },
  })
  return [
    { kind: 'original', key: 'original', applied: appliedId === null },
    {
      kind: 'source',
      key: 'source:src',
      resourceId: 'src',
      label: 'Source',
      labelled: false,
      entries: ['a', 'b', 'c', 'd', 'e', 'f'].map(entry),
    },
    { kind: 'import', key: 'import' },
  ]
}

describe('scrollTileIntoStrip', () => {
  it('scrolls the strip only, the nearest way, keeping its 12px padding', () => {
    const scroller = document.createElement('div')
    const tile = document.createElement('button')
    scroller.scrollLeft = 100
    const scrollTo = vi.fn()
    scroller.scrollTo = scrollTo as never
    scroller.getBoundingClientRect = () => rect(0, 393)

    // Past the right edge: bring its right side 12px inside.
    tile.getBoundingClientRect = () => rect(400, 72)
    scrollTileIntoStrip(scroller, tile, 'smooth')
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 191, behavior: 'smooth' })

    // Past the left edge: bring its left side 12px inside.
    tile.getBoundingClientRect = () => rect(-40, 72)
    scrollTileIntoStrip(scroller, tile, 'instant')
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 48, behavior: 'instant' })

    // Already in view: leave the strip where it is.
    scrollTo.mockClear()
    tile.getBoundingClientRect = () => rect(100, 72)
    scrollTileIntoStrip(scroller, tile, 'smooth')
    expect(scrollTo).not.toHaveBeenCalled()
  })
})

describe('mobileLutStrip', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo
  })

  it('brings the applied tile into view at once on open, then smoothly', () => {
    const scrollTo = vi.fn()
    // jsdom has no element scrolling to spy on.
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.dataset.mobileLutStrip !== undefined) return rect(0, 393)
        // Every tile reads as past the right edge.
        return rect(500, 72)
      },
    )
    const props = {
      loadingEntryId: null,
      failedEntryId: null,
      entryLoadProgress: null,
      disabled: false,
      appliedNeedsContract: false,
      onSelectOriginal: vi.fn(),
      onSelectEntry: vi.fn(),
      onCancelEntry: vi.fn(),
      onImport: vi.fn(),
    }
    const { rerender } = render(
      <MobileLutStrip {...props} items={items('e')} />,
    )
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo.mock.calls[0][0]).toMatchObject({ behavior: 'instant' })

    rerender(<MobileLutStrip {...props} items={items('f')} />)
    expect(scrollTo).toHaveBeenCalledTimes(2)
    expect(scrollTo.mock.calls[1][0]).toMatchObject({ behavior: 'smooth' })
  })

  it('fades only the side with more tiles past it', () => {
    const { container } = render(
      <MobileLutStrip
        items={items(null)}
        loadingEntryId={null}
        failedEntryId={null}
        entryLoadProgress={null}
        disabled={false}
        appliedNeedsContract={false}
        onSelectOriginal={vi.fn()}
        onSelectEntry={vi.fn()}
        onCancelEntry={vi.fn()}
        onImport={vi.fn()}
      />,
    )
    const strip = container.querySelector<HTMLElement>(
      '[data-mobile-lut-strip]',
    )!
    // jsdom lays nothing out, so nothing overflows: no mask at all.
    expect(strip.style.maskImage).toBe('')

    Object.defineProperty(strip, 'scrollWidth', { value: 800 })
    Object.defineProperty(strip, 'clientWidth', { value: 393 })
    strip.scrollLeft = 0
    act(() => {
      strip.dispatchEvent(new Event('scroll'))
    })
    expect(strip).toHaveAttribute('data-fade-right', 'true')
    expect(strip).not.toHaveAttribute('data-fade-left')
    expect(strip.style.maskImage).toContain('transparent 100%')

    strip.scrollLeft = 200
    act(() => {
      strip.dispatchEvent(new Event('scroll'))
    })
    expect(strip).toHaveAttribute('data-fade-left', 'true')
    expect(strip).toHaveAttribute('data-fade-right', 'true')
  })
})

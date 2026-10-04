import { describe, expect, it } from 'vitest'

import type { MobileStageLayoutInput } from './mobile-stage-layout'
import {
  computeMobileStageLayout,
  getMobileDeckBounds,
  isMobileListDeck,
} from './mobile-stage-layout'

const LANDSCAPE = 3 / 2
const PORTRAIT = 2 / 3
const TOPBAR = 56
const DOCK_BAR = 64
// Look's content at its natural height, deck padding included.
const LOOK_NATURAL = 140
const EXPORT_NATURAL = 220

function input(
  overrides: Partial<MobileStageLayoutInput> = {},
): MobileStageLayoutInput {
  return {
    viewportWidth: 393,
    viewportHeight: 660,
    topbarHeight: TOPBAR,
    dockBarHeight: DOCK_BAR,
    photoAspect: LANDSCAPE,
    tool: 'look',
    deck: 'expanded',
    exportOpen: false,
    deckNaturalHeight: LOOK_NATURAL,
    immersive: false,
    hasImage: true,
    ...overrides,
  }
}

const TOOLS = [
  { name: 'Look', patch: { tool: 'look' as const } },
  { name: 'Adjust', patch: { tool: 'tone' as const } },
  { name: 'Transform', patch: { tool: 'transform' as const } },
  { name: 'collapsed', patch: { deck: 'collapsed' as const } },
  {
    name: 'export',
    patch: { exportOpen: true, deckNaturalHeight: EXPORT_NATURAL },
  },
]

describe('mobile deck bounds', () => {
  it('lets list tools fill the deck and has Look and export size it', () => {
    expect(isMobileListDeck('tone', false)).toBe(true)
    expect(isMobileListDeck('transform', false)).toBe(true)
    expect(isMobileListDeck('look', false)).toBe(false)
    expect(isMobileListDeck('tone', true)).toBe(false)

    // 0.38 x 660 = 250.8 is below the 264px cap.
    expect(getMobileDeckBounds(input({ tool: 'tone' }))).toEqual({
      min: 200,
      max: 250.8,
      fill: true,
    })
    // 0.38 x 844 = 320.7, so the 264px cap wins.
    expect(
      getMobileDeckBounds(input({ tool: 'tone', viewportHeight: 844 })),
    ).toEqual({ min: 200, max: 264, fill: true })
    expect(getMobileDeckBounds(input())).toEqual({
      min: LOOK_NATURAL,
      max: LOOK_NATURAL,
      fill: false,
    })
    expect(getMobileDeckBounds(input({ deck: 'collapsed' }))).toEqual({
      min: 0,
      max: 0,
      fill: false,
    })
  })

  it('caps natural content at the list maximum, so taller content scrolls', () => {
    expect(
      getMobileDeckBounds(input({ exportOpen: true, deckNaturalHeight: 400 })),
    ).toEqual({ min: 250.8, max: 250.8, fill: false })
  })

  it('never lets the list minimum exceed the list maximum on a short viewport', () => {
    const bounds = getMobileDeckBounds(
      input({ tool: 'tone', viewportHeight: 480 }),
    )
    expect(bounds.max).toBeCloseTo(182.4)
    expect(bounds.min).toBe(bounds.max)
  })
})

describe('computeMobileStageLayout at 393x660', () => {
  it.each(TOOLS)(
    'keeps a 3:2 landscape photo at 393x262 under the topbar ($name)',
    ({ patch }) => {
      const layout = computeMobileStageLayout(input(patch))
      expect(layout.insetTop).toBe(TOPBAR)
      expect(layout.photoRect.top).toBe(TOPBAR)
      expect(layout.photoRect.left).toBe(0)
      expect(layout.photoRect.width).toBeCloseTo(393)
      expect(layout.photoRect.height).toBeCloseTo(262)
      // The stage region is exactly the photo, so the frame's centring
      // cannot float it.
      expect(layout.insetBottom).toBeCloseTo(660 - TOPBAR - 262)
    },
  )

  it('sizes the deck per tool around a landscape photo', () => {
    expect(computeMobileStageLayout(input()).deckHeight).toBe(LOOK_NATURAL)
    expect(
      computeMobileStageLayout(input({ tool: 'tone' })).deckHeight,
    ).toBeCloseTo(250.8)
    expect(
      computeMobileStageLayout(input({ tool: 'transform' })).deckHeight,
    ).toBeCloseTo(250.8)
    expect(
      computeMobileStageLayout(input({ deck: 'collapsed' })).deckHeight,
    ).toBe(0)
    expect(
      computeMobileStageLayout(
        input({ exportOpen: true, deckNaturalHeight: EXPORT_NATURAL }),
      ).deckHeight,
    ).toBe(EXPORT_NATURAL)
  })

  it('gives a 2:3 portrait photo all the height the deck leaves', () => {
    const look = computeMobileStageLayout(input({ photoAspect: PORTRAIT }))
    // 660 - 56 - 64 - 140 = 400 tall, so ~267 wide.
    expect(look.photoRect.height).toBeCloseTo(400)
    expect(look.photoRect.width).toBeCloseTo(266.67, 1)
    expect(look.photoRect.left).toBeCloseTo((393 - 266.67) / 2, 1)
    expect(look.insetBottom).toBeCloseTo(660 - TOPBAR - 400)
    expect(look.deckHeight).toBe(LOOK_NATURAL)

    for (const tool of ['tone', 'transform'] as const) {
      const list = computeMobileStageLayout(
        input({ photoAspect: PORTRAIT, tool }),
      )
      // The deck holds its 200px minimum; the photo takes the rest.
      expect(list.deckHeight).toBe(200)
      expect(list.photoRect.height).toBeCloseTo(340)
      expect(list.photoRect.width).toBeCloseTo(226.67, 1)
    }

    const collapsed = computeMobileStageLayout(
      input({ photoAspect: PORTRAIT, deck: 'collapsed' }),
    )
    expect(collapsed.deckHeight).toBe(0)
    expect(collapsed.photoRect.height).toBeCloseTo(540)
    expect(collapsed.photoRect.width).toBeCloseTo(360)
    expect(collapsed.insetBottom).toBeCloseTo(DOCK_BAR)

    const exporting = computeMobileStageLayout(
      input({
        photoAspect: PORTRAIT,
        exportOpen: true,
        deckNaturalHeight: EXPORT_NATURAL,
      }),
    )
    expect(exporting.deckHeight).toBe(EXPORT_NATURAL)
    expect(exporting.photoRect.height).toBeCloseTo(320)
  })

  it('caps a tall export panel at the list maximum and gives the photo the rest', () => {
    const layout = computeMobileStageLayout(
      input({
        photoAspect: PORTRAIT,
        exportOpen: true,
        deckNaturalHeight: 400,
      }),
    )
    expect(layout.deckHeight).toBeCloseTo(250.8)
    expect(layout.photoRect.height).toBeCloseTo(540 - 250.8)
  })
})

describe('computeMobileStageLayout at 390x844', () => {
  it.each(TOOLS)(
    'keeps a 3:2 landscape photo at 390x260 under the topbar ($name)',
    ({ patch }) => {
      const layout = computeMobileStageLayout(
        input({ viewportWidth: 390, viewportHeight: 844, ...patch }),
      )
      expect(layout.photoRect.top).toBe(TOPBAR)
      expect(layout.photoRect.width).toBeCloseTo(390)
      expect(layout.photoRect.height).toBeCloseTo(260)
      expect(layout.insetBottom).toBeCloseTo(844 - TOPBAR - 260)
    },
  )

  it('lets list tools take the 264px cap under a landscape photo', () => {
    const layout = computeMobileStageLayout(
      input({ viewportWidth: 390, viewportHeight: 844, tool: 'tone' }),
    )
    expect(layout.deckHeight).toBe(264)
  })

  it('gives a 2:3 portrait photo the height the deck leaves, up to its natural height', () => {
    const tall = { viewportWidth: 390, viewportHeight: 844 }
    const look = computeMobileStageLayout(
      input({ ...tall, photoAspect: PORTRAIT }),
    )
    // 844 - 56 - 64 - 140 = 584, just under the 585px natural height.
    expect(look.photoRect.height).toBeCloseTo(584)
    expect(look.deckHeight).toBe(LOOK_NATURAL)

    const adjust = computeMobileStageLayout(
      input({ ...tall, photoAspect: PORTRAIT, tool: 'tone' }),
    )
    expect(adjust.photoRect.height).toBeCloseTo(524)
    expect(adjust.photoRect.width).toBeCloseTo(349.33, 1)
    expect(adjust.deckHeight).toBe(200)

    const collapsed = computeMobileStageLayout(
      input({ ...tall, photoAspect: PORTRAIT, deck: 'collapsed' }),
    )
    // Full width: the photo reaches its natural 585px and stops there.
    expect(collapsed.photoRect.height).toBeCloseTo(585)
    expect(collapsed.photoRect.width).toBeCloseTo(390)
    expect(collapsed.insetBottom).toBeCloseTo(844 - TOPBAR - 585)

    const exporting = computeMobileStageLayout(
      input({
        ...tall,
        photoAspect: PORTRAIT,
        exportOpen: true,
        deckNaturalHeight: EXPORT_NATURAL,
      }),
    )
    expect(exporting.photoRect.height).toBeCloseTo(504)
    expect(exporting.deckHeight).toBe(EXPORT_NATURAL)
  })
})

describe('computeMobileStageLayout full-bleed and fallback states', () => {
  it('drops both insets in immersive and fits the photo to the whole shell', () => {
    const layout = computeMobileStageLayout(
      input({ immersive: true, tool: 'tone' }),
    )
    expect(layout.insetTop).toBe(0)
    expect(layout.insetBottom).toBe(0)
    expect(layout.photoRect).toEqual({
      top: (660 - 262) / 2,
      left: 0,
      width: 393,
      height: 262,
    })
    // The deck keeps its size while the chrome fades out.
    expect(layout.deckHeight).toBeCloseTo(250.8)
  })

  it('drops both insets and the deck while no image is loaded', () => {
    const layout = computeMobileStageLayout(
      input({ hasImage: false, photoAspect: null }),
    )
    expect(layout.insetTop).toBe(0)
    expect(layout.insetBottom).toBe(0)
    expect(layout.deckHeight).toBe(0)
  })

  it('falls back to the region above the deck when the aspect is unknown', () => {
    const adjust = computeMobileStageLayout(
      input({ photoAspect: null, tool: 'tone' }),
    )
    expect(adjust.insetTop).toBe(TOPBAR)
    expect(adjust.deckHeight).toBeCloseTo(250.8)
    expect(adjust.insetBottom).toBeCloseTo(DOCK_BAR + 250.8)
    expect(adjust.photoRect).toEqual({
      top: TOPBAR,
      left: 0,
      width: 393,
      height: expect.closeTo(660 - TOPBAR - DOCK_BAR - 250.8),
    })

    const look = computeMobileStageLayout(input({ photoAspect: null }))
    expect(look.insetBottom).toBe(DOCK_BAR + LOOK_NATURAL)

    const collapsed = computeMobileStageLayout(
      input({ photoAspect: null, deck: 'collapsed' }),
    )
    expect(collapsed.insetBottom).toBe(DOCK_BAR)
  })

  it('treats an unmeasured shell as an unknown aspect', () => {
    const layout = computeMobileStageLayout(
      input({ viewportWidth: 0, viewportHeight: 0 }),
    )
    expect(layout.photoRect.width).toBe(0)
    expect(layout.insetBottom).toBe(0)
  })

  it('ignores a degenerate aspect', () => {
    for (const photoAspect of [0, -1, Number.NaN, Infinity]) {
      expect(
        computeMobileStageLayout(input({ photoAspect, tool: 'tone' }))
          .insetBottom,
      ).toBeCloseTo(DOCK_BAR + 250.8)
    }
  })
})

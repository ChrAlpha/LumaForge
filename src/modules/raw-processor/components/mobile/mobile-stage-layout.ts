import type { MobileMode } from './MobileModeDock'

/**
 * Photo-first geometry for the mobile `/raw` stage.
 *
 * The stage region (the band between `insetTop` and `insetBottom`) is sized
 * to exactly the photo's displayed height, so the frame's own centring puts
 * the photo flush under the topbar. A landscape photo therefore keeps one
 * size and position in every tool; only a photo too tall for the space the
 * deck leaves gives ground, and it gives exactly what the deck needs.
 */

/** List tools fill the deck and scroll their rows inside it. */
const LIST_TOOLS: ReadonlySet<MobileMode> = new Set(['tone', 'transform'])

/**
 * What the Look deck shows: its strip, or the LUT contract chosen inline,
 * which is a list and takes list-tool sizing so the photo stays above it.
 */
export type MobileLookView = 'strip' | 'contract'

/** The deck's vertical padding (14px top + 10px bottom). */
export const DECK_PADDING_Y_PX = 24

/**
 * Whether the deck holds a list tool, which fills whatever height the
 * layout gives it, rather than content that sizes the deck.
 */
export function isMobileListDeck(
  tool: MobileMode,
  exportOpen: boolean,
  lookView: MobileLookView = 'strip',
) {
  if (exportOpen) return false
  return LIST_TOOLS.has(tool) || (tool === 'look' && lookView === 'contract')
}

/** A list deck never drops below this, so a few rows stay in reach. */
export const DECK_LIST_MIN_PX = 200
/** A list deck never grows past this, nor past a share of the viewport. */
export const DECK_LIST_MAX_PX = 264
export const DECK_LIST_MAX_VIEWPORT_SHARE = 0.38
/**
 * The export panel can need more than the list cap: a blocked reason, the
 * recap, both export buttons and the HQ preview's reason. Rather than hide
 * its primary action below the fold, it takes height from the photo the way
 * a list tool does, leaving the photo at least this share of the region
 * between the topbar and the tab bar.
 */
export const EXPORT_PHOTO_MIN_SHARE = 0.4

export interface MobileStageRect {
  top: number
  left: number
  width: number
  height: number
}

export interface MobileStageLayoutInput {
  /** The shell's size: the box the stage and the chrome both cover. */
  viewportWidth: number
  viewportHeight: number
  topbarHeight: number
  /** The dock's tab bar, safe-area padding included. */
  dockBarHeight: number
  /** Width / height of the displayed preview; null while unknown. */
  photoAspect: number | null
  tool: MobileMode
  /** The Look deck's view; its contract view sizes like a list tool. */
  lookView?: MobileLookView
  deck: 'expanded' | 'collapsed'
  /** The export panel holds the deck instead of the tool's panel. */
  exportOpen: boolean
  /** Measured height of the current deck content, padding included. */
  deckNaturalHeight: number
  immersive: boolean
  hasImage: boolean
}

export interface MobileStageLayout {
  insetTop: number
  insetBottom: number
  deckHeight: number
  /** Where the photo sits, in shell coordinates. */
  photoRect: MobileStageRect
}

interface DeckBounds {
  min: number
  max: number
  /** The deck content fills the deck instead of sizing it. */
  fill: boolean
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function finitePositive(value: number) {
  return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * List tools (and Look's contract view) take what the photo leaves,
 * between 200px and the list cap. Look's strip is as tall as its content,
 * never above the list cap (taller content scrolls inside). The export
 * panel is as tall as its content too, and may pass the list cap down to
 * the photo's minimum share. A collapsed deck is 0.
 */
export function getMobileDeckBounds(
  input: Pick<
    MobileStageLayoutInput,
    | 'viewportHeight'
    | 'tool'
    | 'lookView'
    | 'deck'
    | 'exportOpen'
    | 'deckNaturalHeight'
  > &
    Partial<Pick<MobileStageLayoutInput, 'topbarHeight' | 'dockBarHeight'>>,
): DeckBounds {
  if (input.deck === 'collapsed') return { min: 0, max: 0, fill: false }
  const viewportHeight = finitePositive(input.viewportHeight)
  const listMax = Math.min(
    DECK_LIST_MAX_VIEWPORT_SHARE * viewportHeight,
    DECK_LIST_MAX_PX,
  )
  if (input.exportOpen) {
    const region = Math.max(
      0,
      viewportHeight -
        finitePositive(input.topbarHeight ?? 0) -
        finitePositive(input.dockBarHeight ?? 0),
    )
    const exportMax = Math.max(listMax, region * (1 - EXPORT_PHOTO_MIN_SHARE))
    const natural = clamp(finitePositive(input.deckNaturalHeight), 0, exportMax)
    return { min: natural, max: natural, fill: false }
  }
  if (isMobileListDeck(input.tool, input.exportOpen, input.lookView)) {
    return {
      min: Math.min(DECK_LIST_MIN_PX, listMax),
      max: listMax,
      fill: true,
    }
  }
  const natural = clamp(finitePositive(input.deckNaturalHeight), 0, listMax)
  return { min: natural, max: natural, fill: false }
}

function fitRect(
  aspect: number | null,
  top: number,
  width: number,
  height: number,
): MobileStageRect {
  if (aspect === null || width <= 0 || height <= 0) {
    return { top, left: 0, width, height }
  }
  const fittedWidth = Math.min(width, height * aspect)
  const fittedHeight = fittedWidth / aspect
  return {
    top: top + (height - fittedHeight) / 2,
    left: (width - fittedWidth) / 2,
    width: fittedWidth,
    height: fittedHeight,
  }
}

export function computeMobileStageLayout(
  input: MobileStageLayoutInput,
): MobileStageLayout {
  const viewportWidth = finitePositive(input.viewportWidth)
  const viewportHeight = finitePositive(input.viewportHeight)
  const topbar = clamp(finitePositive(input.topbarHeight), 0, viewportHeight)
  const dockBar = finitePositive(input.dockBarHeight)
  const measured = viewportWidth > 0 && viewportHeight > 0
  const aspect =
    measured &&
    input.photoAspect !== null &&
    Number.isFinite(input.photoAspect) &&
    input.photoAspect > 0
      ? input.photoAspect
      : null
  const bounds = getMobileDeckBounds(input)
  const restingDeck = bounds.fill ? bounds.max : bounds.min

  // Immersive and the empty state are full bleed: the photo fits the whole
  // shell. The deck keeps its size so a fading chrome does not reflow.
  if (input.immersive || !input.hasImage) {
    return {
      insetTop: 0,
      insetBottom: 0,
      deckHeight: input.hasImage ? restingDeck : 0,
      photoRect: fitRect(aspect, 0, viewportWidth, viewportHeight),
    }
  }

  const available = Math.max(0, viewportHeight - topbar - dockBar)

  // Without an aspect the photo cannot be anchored, so the stage takes the
  // whole region the chrome leaves and the frame centres the photo in it.
  if (aspect === null) {
    const insetBottom = Math.min(
      Math.max(0, viewportHeight - topbar),
      dockBar + restingDeck,
    )
    return {
      insetTop: topbar,
      insetBottom,
      deckHeight: restingDeck,
      photoRect: {
        top: topbar,
        left: 0,
        width: viewportWidth,
        height: Math.max(0, viewportHeight - topbar - insetBottom),
      },
    }
  }

  const photoNaturalHeight = viewportWidth / aspect
  const photoHeight = clamp(
    Math.min(photoNaturalHeight, available - bounds.min),
    0,
    available,
  )
  const deckHeight = bounds.fill
    ? clamp(available - photoHeight, bounds.min, bounds.max)
    : bounds.min
  const photoWidth = Math.min(viewportWidth, photoHeight * aspect)

  return {
    insetTop: topbar,
    insetBottom: Math.max(0, viewportHeight - topbar - photoHeight),
    deckHeight,
    photoRect: {
      top: topbar,
      left: (viewportWidth - photoWidth) / 2,
      width: photoWidth,
      height: photoHeight,
    },
  }
}

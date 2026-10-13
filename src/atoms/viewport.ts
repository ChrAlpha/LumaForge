import { atom } from 'jotai'

/** The window's inner width, kept current by `EventProvider`. */
export const viewportWidthAtom = atom(window.innerWidth)

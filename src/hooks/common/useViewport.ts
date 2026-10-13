import { useAtomValue } from 'jotai'
import { selectAtom } from 'jotai/utils'
import { useCallback } from 'react'

import { viewportWidthAtom } from '~/atoms/viewport'

/** Whether a viewport this wide gets the mobile `/raw` surface. */
export const isRawMobileViewport = (width: number) =>
  width <= 640 && width !== 0

export const useViewport = <T>(selector: (width: number) => T): T =>
  useAtomValue(
    selectAtom(
      viewportWidthAtom,
      useCallback((width) => selector(width), [selector]),
    ),
  )

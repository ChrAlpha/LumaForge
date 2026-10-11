import type { ExtractAtomValue } from 'jotai'
import { useAtomValue } from 'jotai'
import { selectAtom } from 'jotai/utils'
import { useCallback } from 'react'

import { viewportAtom } from '~/atoms/viewport'

export const useViewport = <T>(
  selector: (value: ExtractAtomValue<typeof viewportAtom>) => T,
): T =>
  useAtomValue(
    selectAtom(
      viewportAtom,
      useCallback((atomValue) => selector(atomValue), [selector]),
    ),
  )

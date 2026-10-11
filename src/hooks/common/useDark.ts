import { useAtomValue } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import { useLayoutEffect } from 'react'
import { useMediaQuery } from 'usehooks-ts'

import { nextFrame } from '~/lib/dom'

const useDarkQuery = () => useMediaQuery('(prefers-color-scheme: dark)')
type ColorMode = 'light' | 'dark' | 'system'
const themeAtom = atomWithStorage(
  'color-mode',
  'system' as ColorMode,
  undefined,
  {
    getOnInit: true,
  },
)

export const useThemeAtomValue = () => useAtomValue(themeAtom)

const useSyncThemeWebApp = () => {
  const colorMode = useAtomValue(themeAtom)
  const systemIsDark = useDarkQuery()
  useLayoutEffect(() => {
    const realColorMode: Exclude<ColorMode, 'system'> =
      colorMode === 'system' ? (systemIsDark ? 'dark' : 'light') : colorMode
    document.documentElement.dataset.theme = realColorMode
    disableTransition(['[role=switch]>*'])()
  }, [colorMode, systemIsDark])
}

export const useSyncThemeark = useSyncThemeWebApp

function disableTransition(disableTransitionExclude: string[] = []) {
  const css = document.createElement('style')
  css.append(
    document.createTextNode(
      `
*${disableTransitionExclude.map((s) => `:not(${s})`).join('')} {
  -webkit-transition: none !important;
  -moz-transition: none !important;
  -o-transition: none !important;
  -ms-transition: none !important;
  transition: none !important;
}
      `,
    ),
  )
  document.head.append(css)

  return () => {
    // Force restyle
    ;(() => window.getComputedStyle(document.body))()

    // Wait for next tick before removing
    nextFrame(() => {
      css.remove()
    })
  }
}

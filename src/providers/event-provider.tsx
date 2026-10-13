import { useStore } from 'jotai'
import type { FC } from 'react'
import { useLayoutEffect } from 'react'

import { viewportWidthAtom } from '~/atoms/viewport'

export const EventProvider: FC = () => {
  const store = useStore()
  useLayoutEffect(() => {
    let frame = 0
    const readViewport = () => {
      frame = 0
      store.set(viewportWidthAtom, window.innerWidth)
    }
    const onResize = () => {
      if (frame === 0) frame = requestAnimationFrame(readViewport)
    }

    readViewport()

    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      if (frame !== 0) cancelAnimationFrame(frame)
    }
  }, [store])

  return null
}

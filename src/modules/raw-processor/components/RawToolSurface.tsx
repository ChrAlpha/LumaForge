import { memo } from 'react'

import { isRawMobileViewport, useViewport } from '~/hooks/common'

import { DesktopRawToolSurface } from './DesktopRawToolSurface'
import { MobileRawToolSurface } from './mobile/MobileRawToolSurface'

/** Whether `/raw` is showing the mobile surface rather than the desktop one. */
export function useIsMobileRawSurface() {
  return useViewport(isRawMobileViewport)
}

/**
 * The desktop or the mobile tool surface, by viewport. Each reads the
 * workflow context, the store slices and the tool commands its provider
 * mounts above it, so it takes no props and renders only when what it reads
 * moves, never because the view around it rendered.
 */
export const RawToolSurface = memo(() => {
  const isMobileViewport = useIsMobileRawSurface()

  return isMobileViewport ? (
    // Photo-first scaffold is ALWAYS present on mobile, even before a RAW
    // is loaded, so the topbar + toolbar are consistent from the first screen.
    <div className="pointer-events-none fixed inset-0 z-30" data-raw-mobile-lab>
      <MobileRawToolSurface />
    </div>
  ) : (
    <DesktopRawToolSurface />
  )
})

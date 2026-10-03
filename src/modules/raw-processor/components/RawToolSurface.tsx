import { useViewport } from '~/hooks/common'

import { DesktopRawToolSurface } from './DesktopRawToolSurface'
import { MobileRawToolSurface } from './mobile/MobileRawToolSurface'
import type { RawToolSurfaceProps } from './RawWorkflowContext'
import {
  RawWorkflowProvider,
  useRawWorkflowContext,
} from './RawWorkflowContext'

const selectIsNarrowViewport = (v: { w: number }) => v.w <= 640 && v.w !== 0

/** Whether `/raw` is showing the mobile surface rather than the desktop one. */
export function useIsMobileRawSurface() {
  return useViewport(selectIsNarrowViewport)
}

type RawToolSurfaceComponentProps = Partial<RawToolSurfaceProps>

export function RawToolSurface(props: RawToolSurfaceComponentProps = {}) {
  const workflow = useRawWorkflowContext(
    hasToolSurfaceOverride(props) ? props : undefined,
  )
  const isMobileViewport = useIsMobileRawSurface()

  const content = isMobileViewport ? (
    // Photo-first scaffold is ALWAYS present on mobile, even before a RAW
    // is loaded, so the topbar + toolbar are consistent from the first screen.
    <div className="pointer-events-none fixed inset-0 z-30" data-raw-mobile-lab>
      <MobileRawToolSurface />
    </div>
  ) : (
    <DesktopRawToolSurface />
  )

  return <RawWorkflowProvider value={workflow}>{content}</RawWorkflowProvider>
}

export type { RawToolSurfaceProps } from './RawWorkflowContext'

function hasToolSurfaceOverride(
  props: RawToolSurfaceComponentProps,
): props is RawToolSurfaceProps {
  // Detect real test/storybook overrides by the presence of a structural
  // RawToolSurfaceProps field. Plain key-count checks misfire in dev because
  // tooling like `code-inspector-plugin` injects `data-*` attributes onto
  // every JSX call site, which would otherwise be treated as an override and
  // clobber the workflow context value.
  return 'histogram' in props
}

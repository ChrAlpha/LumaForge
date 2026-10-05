import { useInRouterContext, useLocation } from 'react-router'
import { Toaster as Sonner } from 'sonner'

import { useThemeAtomValue, useViewport } from '~/hooks/common'

type ToasterProps = React.ComponentProps<typeof Sonner>

const selectMobileToastPosition = (value: { w: number }) =>
  value.w < 1024 && value.w !== 0

// The viewport where /raw shows its mobile surface, with a persistent topbar.
const selectRawMobileSurface = (value: { w: number }) =>
  value.w <= 640 && value.w !== 0

const TOAST_EDGE_OFFSET = '16px'

/**
 * On mobile /raw the top-centre toast would cover the topbar and its Export
 * action. The topbar is the top safe area + 12px + one 44px row, so the
 * toast drops 8px below it.
 */
export const RAW_MOBILE_TOAST_TOP = 'calc(env(safe-area-inset-top) + 64px)'

const rawMobileToastOffset = {
  top: RAW_MOBILE_TOAST_TOP,
  right: TOAST_EDGE_OFFSET,
  bottom: TOAST_EDGE_OFFSET,
  left: TOAST_EDGE_OFFSET,
}

/**
 * Sonner slides a top toast in from a full toast height above its slot and
 * out the same way, which carried it across the topbar and over the Export
 * action on every entrance and exit. On mobile /raw the toaster clips
 * everything above the topbar's bottom edge (8px above its own top), so a
 * toast emerges from under the topbar and leaves the same way, and the
 * clipped part takes no taps.
 */
const RAW_MOBILE_TOASTER_CLASS = '[clip-path:inset(-8px_-100vw_-100vh_-100vw)]'

function isRawRoute(pathname: string) {
  return pathname.replace(/\/+$/, '') === '/raw'
}

const rawRouteToastClass =
  '[.luma-route-raw_&]:!rounded-md [.luma-route-raw_&]:!border-lf-on-photo-bord-soft [.luma-route-raw_&]:!bg-lf-on-photo-bg-strong [.luma-route-raw_&]:!text-lf-on-photo-ink [.luma-route-raw_&]:!shadow-lf-popover [.luma-route-raw_&]:!ring-lf-on-photo-bord-soft [.luma-route-raw_&]:!backdrop-blur-background'

const rawRouteTitleClass =
  '[.luma-route-raw_&]:!text-[0.78rem] [.luma-route-raw_&]:!font-semibold [.luma-route-raw_&]:!text-lf-on-photo-ink'

const rawRouteDescriptionClass =
  '[.luma-route-raw_&]:!text-[0.72rem] [.luma-route-raw_&]:!leading-relaxed [.luma-route-raw_&]:!text-lf-on-photo-ink/68'

const rawRouteIconClass = '[.luma-route-raw_&]:!text-lf-green'

const rawRouteCloseButtonClass =
  '[.luma-route-raw_&]:!size-7 [.luma-route-raw_&]:!min-h-7 [.luma-route-raw_&]:!min-w-7 [.luma-route-raw_&]:!rounded-md [.luma-route-raw_&]:!border-lf-on-photo-bord-soft [.luma-route-raw_&]:!bg-lf-on-photo-bg [.luma-route-raw_&]:!text-lf-on-photo-ink/64 [.luma-route-raw_&]:hover:!text-lf-on-photo-ink'

const rawRouteActionButtonClass =
  '[.luma-route-raw_&]:!rounded-md [.luma-route-raw_&]:!bg-lf-green [.luma-route-raw_&]:!text-lf-on-photo-ink [.luma-route-raw_&]:hover:!bg-lf-green-hover'

const rawRouteCancelButtonClass =
  '[.luma-route-raw_&]:!rounded-md [.luma-route-raw_&]:!border-lf-on-photo-bord-soft [.luma-route-raw_&]:!bg-lf-on-photo-bg [.luma-route-raw_&]:!text-lf-on-photo-ink/78 [.luma-route-raw_&]:hover:!bg-lf-on-photo-bg-strong'

function RoutedToaster(props: ToasterProps) {
  const { pathname } = useLocation()
  return <AppToaster {...props} rawRoute={isRawRoute(pathname)} />
}

/** The app's toaster; on mobile /raw it clears the topbar. */
export const Toaster = (props: ToasterProps) =>
  useInRouterContext() ? (
    <RoutedToaster {...props} />
  ) : (
    <AppToaster {...props} rawRoute={false} />
  )

function AppToaster({
  position,
  rawRoute,
  ...props
}: ToasterProps & { rawRoute: boolean }) {
  const theme = useThemeAtomValue()
  const isMobile = useViewport(selectMobileToastPosition)
  const rawMobileViewport = useViewport(selectRawMobileSurface)
  const rawMobile = rawRoute && rawMobileViewport
  // Sonner switches to `mobileOffset` below 600px; set both so the band
  // between 600px and the 640px mobile breakpoint clears the topbar too.
  const offset = rawMobile ? rawMobileToastOffset : TOAST_EDGE_OFFSET

  return (
    <Sonner
      theme={theme}
      position={position ?? (isMobile ? 'top-center' : 'bottom-left')}
      richColors={!isMobile}
      expand
      closeButton
      duration={isMobile ? 2200 : 3500}
      offset={offset}
      mobileOffset={offset}
      className={
        rawMobile
          ? `toaster group ${RAW_MOBILE_TOASTER_CLASS}`
          : 'toaster group'
      }
      toastOptions={{
        classNames: {
          // Card shell
          toast: `group pointer-events-auto flex gap-3 rounded-xl border border-border bg-background/80 backdrop-blur supports-backdrop-filter:bg-background/70 shadow-lg shadow-black/5 ring-1 ring-border max-sm:!border-white/15 max-sm:!bg-black/80 max-sm:!text-white max-sm:shadow-black/40 max-sm:!ring-white/10 ${rawRouteToastClass}`,
          // Title & description
          title: `text-text font-medium max-sm:!text-white ${rawRouteTitleClass}`,
          description: `text-text-tertiary text-sm leading-relaxed max-sm:!text-white/70 ${rawRouteDescriptionClass}`,
          // Icon & close button
          icon: `text-accent size-4 max-sm:text-accent ${rawRouteIconClass}`,
          closeButton: `min-h-11 min-w-11 text-text-quaternary transition-opacity duration-200 hover:text-text max-sm:!border-white/15 max-sm:!bg-black/80 max-sm:!text-white/70 max-sm:hover:!text-white ${rawRouteCloseButtonClass}`,
          // Action buttons
          actionButton: `rounded-md bg-accent text-background px-2.5 py-1 text-xs font-medium hover:bg-accent/90 ${rawRouteActionButtonClass}`,
          cancelButton: `rounded-md border border-border bg-fill px-2.5 py-1 text-xs font-medium text-text hover:bg-fill-secondary ${rawRouteCancelButtonClass}`,
        },
      }}
      {...props}
    />
  )
}

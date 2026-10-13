import type { FC } from 'react'
import { useLayoutEffect } from 'react'
import { Outlet, useLocation } from 'react-router'

import { SeoMetadata } from './components/common/SeoMetadata'
import { RootProviders } from './providers/root-providers'

function isRawRoutePath(pathname: string) {
  return pathname.replace(/\/+$/, '') === '/raw'
}

function isLandingRoutePath(pathname: string) {
  return pathname.replace(/\/+$/, '') === ''
}

export function syncRouteSubstrate(pathname: string) {
  const rawPath = isRawRoutePath(pathname)
  const landingPath = isLandingRoutePath(pathname)
  const root = document.documentElement
  root.dataset.lumaRoute = rawPath ? 'raw' : landingPath ? 'landing' : 'app'
  root.classList.toggle('luma-route-raw', rawPath)
  root.classList.toggle('luma-route-landing', landingPath)

  const themeColor = document.querySelector("meta[name='theme-color']")
  if (themeColor) {
    themeColor.setAttribute(
      'content',
      rawPath
        ? 'oklch(0.064 0.006 255)'
        : landingPath
          ? 'oklch(0.075 0.006 255)'
          : 'oklch(0.964 0.018 86)',
    )
  }
}

export const App: FC = () => {
  const routeLocation = useLocation()

  useLayoutEffect(() => {
    syncRouteSubstrate(routeLocation.pathname)
  }, [routeLocation.pathname])

  return (
    <RootProviders>
      <SeoMetadata />
      <Outlet />
    </RootProviders>
  )
}

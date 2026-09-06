import type { FC } from 'react'
import { useLayoutEffect } from 'react'
import { Outlet, useLocation } from 'react-router'

import { Footer } from './components/common/Footer'
import { SeoMetadata } from './components/common/SeoMetadata'
import { RootProviders } from './providers/root-providers'

export function shouldShowAppFooter(pathname: string) {
  const path = pathname.replace(/\/+$/, '')
  return path !== '' && path !== '/raw' && path !== '/transform-demo'
}

function isRawRoutePath(pathname: string) {
  return pathname.replace(/\/+$/, '') === '/raw'
}

function isLandingRoutePath(pathname: string) {
  return pathname.replace(/\/+$/, '') === ''
}

export function syncRouteSubstrate(pathname: string) {
  const rawPath = isRawRoutePath(pathname)
  const landingPath = isLandingRoutePath(pathname)
  const transformPath = pathname.replace(/\/+$/, '') === '/transform-demo'
  const root = document.documentElement
  root.dataset.lumaRoute = rawPath
    ? 'raw'
    : landingPath
      ? 'landing'
      : transformPath
        ? 'transform'
        : 'app'
  root.classList.toggle('luma-route-raw', rawPath)
  root.classList.toggle('luma-route-landing', landingPath)
  root.classList.toggle('luma-route-transform', transformPath)

  const themeColor = document.querySelector("meta[name='theme-color']")
  if (themeColor) {
    themeColor.setAttribute(
      'content',
      transformPath
        ? 'oklch(0.118 0.006 255)'
        : rawPath
          ? 'oklch(0.064 0.006 255)'
          : landingPath
            ? 'oklch(0.075 0.006 255)'
            : 'oklch(0.964 0.018 86)',
    )
  }
}

export const App: FC = () => {
  const routeLocation = useLocation()
  const showFooter = shouldShowAppFooter(routeLocation.pathname)

  useLayoutEffect(() => {
    syncRouteSubstrate(routeLocation.pathname)
  }, [routeLocation.pathname])

  return (
    <RootProviders>
      <SeoMetadata />
      <AppLayer />
      {showFooter && <Footer />}
    </RootProviders>
  )
}

const AppLayer = () => {
  const appIsReady = true
  return appIsReady ? <Outlet /> : <AppSkeleton />
}

const AppSkeleton = () => {
  return null
}
export default App

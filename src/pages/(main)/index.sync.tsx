/**
 * Landing page.
 * Route: /
 */

import type { SeoRouteHandle } from '~/lib/seo'
import { HOME_ROUTE_SEO } from '~/lib/seo'
import { LandingPage } from '~/modules/landing'

export const handle = {
  seo: HOME_ROUTE_SEO,
} satisfies SeoRouteHandle

export const loader = () => null

export const Component = () => <LandingPage />

export default Component

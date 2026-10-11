/**
 * RAW Processor page.
 * Route: /raw
 */

import type { SeoRouteHandle } from '~/lib/seo'
import { RAW_ROUTE_SEO } from '~/lib/seo'
import { RawProcessorView } from '~/modules/raw-processor'

export const handle = {
  seo: RAW_ROUTE_SEO,
} satisfies SeoRouteHandle

export const Component = () => {
  return <RawProcessorView />
}

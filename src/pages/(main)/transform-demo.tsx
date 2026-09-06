import type { SeoRouteHandle } from '~/lib/seo'
import { TransformDemoPage } from '~/modules/transform-demo/TransformDemoPage'

export const handle = {
  seo: {
    title: 'Transform demo | LumaForge',
    description: 'Explore local automatic perspective correction.',
    canonicalPath: '/transform-demo',
    robots: 'noindex, nofollow',
  },
} satisfies SeoRouteHandle

export const Component = () => <TransformDemoPage />
export default Component

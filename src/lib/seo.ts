export type DeployEnvironment = 'preview' | 'production'

export type RobotsDirective = 'index, follow' | 'noindex, nofollow'

export interface RouteSeoMetadata {
  title: string
  description: string
  canonicalPath: string
  robots?: RobotsDirective
  imageUrl?: string
  imageAlt?: string
  includeStructuredData?: boolean
}

export interface SeoRouteHandle {
  seo: RouteSeoMetadata
}

export interface SeoRuntimeOptions {
  siteUrl: string
  deployEnv: DeployEnvironment
}

interface ResolvedSeoMetadata {
  title: string
  description: string
  canonicalUrl: string
  robots: RobotsDirective
  imageUrl: string
  imageAlt: string
  structuredDataJson: string | null
}

const DEFAULT_OG_IMAGE = '/og-image.png'

const DEFAULT_OG_IMAGE_ALT =
  'LumaForge social preview card showing a local RAW photograph before and after tone and color finishing.'

export const SITE_NAME = 'LumaForge'
export const DEFAULT_SITE_URL = 'https://luma.ichr.me'
export const DEFAULT_DEPLOY_ENV: DeployEnvironment = 'production'

export const HOME_ROUTE_SEO: RouteSeoMetadata = {
  title: 'LumaForge | Browser-Local RAW Photo Lab',
  description:
    'Open one camera RAW locally, shape tone and color, inspect the histogram, compare the result, and export a full-resolution JPEG when the pipeline is reproducible.',
  canonicalPath: '/',
  robots: 'index, follow',
}

export const RAW_ROUTE_SEO: RouteSeoMetadata = {
  title: 'RAW Lab | LumaForge',
  description:
    'Open the browser-local RAW lab to adjust tone and color, compare the result, and export a trustworthy full-resolution JPEG.',
  canonicalPath: '/raw',
  robots: 'index, follow',
}

export const NOT_FOUND_ROUTE_SEO: RouteSeoMetadata = {
  title: 'Page Not Found | LumaForge',
  description:
    'The requested LumaForge page could not be found. Start from the browser-local RAW photo lab homepage instead.',
  canonicalPath: '/',
  robots: 'noindex, nofollow',
  includeStructuredData: false,
}

export const ERROR_ROUTE_SEO: RouteSeoMetadata = {
  title: 'Unexpected Error | LumaForge',
  description:
    'LumaForge hit an unexpected application error while loading the browser-local RAW photo lab.',
  canonicalPath: '/',
  robots: 'noindex, nofollow',
  includeStructuredData: false,
}

const SEO_BLOCK_PATTERN =
  /<title[^>]*data-lf-seo="true"[^>]*>[\s\S]*?<script[^>]*(?:data-lf-seo="true"[^>]*type="application\/ld\+json"|type="application\/ld\+json"[^>]*data-lf-seo="true")[^>]*>[\s\S]*?<\/script>/i

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function escapeJsonForHtml(value: unknown) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
}

export function normalizeSiteUrl(siteUrl: string) {
  return siteUrl.replace(/\/+$/g, '') || DEFAULT_SITE_URL
}

export function normalizeCanonicalPath(path: string) {
  const value = path.trim() || '/'
  if (value === '/') return '/'
  const normalized = value.startsWith('/') ? value : `/${value}`
  return normalized.replace(/\/+$/g, '')
}

export function resolveDeployEnvironment(
  value: string | undefined,
): DeployEnvironment {
  return value === 'preview' ? 'preview' : 'production'
}

function resolveCanonicalUrl(siteUrl: string, canonicalPath: string) {
  const normalizedSiteUrl = normalizeSiteUrl(siteUrl)
  const normalizedPath = normalizeCanonicalPath(canonicalPath)
  return normalizedPath === '/'
    ? `${normalizedSiteUrl}/`
    : `${normalizedSiteUrl}${normalizedPath}`
}

function resolveImageUrl(siteUrl: string, imageUrl: string) {
  if (/^https?:\/\//i.test(imageUrl)) return imageUrl

  const normalizedPath = imageUrl.startsWith('/') ? imageUrl : `/${imageUrl}`
  return `${normalizeSiteUrl(siteUrl)}${normalizedPath}`
}

function resolveRobotsDirective(
  robots: RobotsDirective | undefined,
  deployEnv: DeployEnvironment,
): RobotsDirective {
  if (deployEnv === 'preview') return 'noindex, nofollow'
  return robots ?? 'index, follow'
}

function createStructuredData(
  routeSeo: RouteSeoMetadata,
  resolved: Pick<
    ResolvedSeoMetadata,
    'description' | 'canonicalUrl' | 'imageUrl'
  >,
) {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: SITE_NAME,
    url: resolved.canonicalUrl,
    description: resolved.description,
    applicationCategory: 'PhotographyApplication',
    operatingSystem: 'Web',
    image: resolved.imageUrl,
    isAccessibleForFree: true,
    featureList:
      routeSeo.canonicalPath === '/raw'
        ? [
            'Progressive browser-local RAW preview',
            'Tone, color, saturation, vibrance, and eight-band HSL adjustments',
            'Optional declared LUT contracts',
            'Histogram and original-versus-processed comparison',
            'Reproducible full-resolution JPEG export',
          ]
        : [
            'Progressive browser-local RAW preview',
            'Tone, color, HSL, histogram, and compare workflow',
            'Optional LUT contract validation',
            'Fail-closed full-resolution JPEG export',
            'RAW file remains on the device',
          ],
  }
}

export function resolveSeoMetadata(
  routeSeo: RouteSeoMetadata,
  options: SeoRuntimeOptions,
): ResolvedSeoMetadata {
  const canonicalUrl = resolveCanonicalUrl(
    options.siteUrl,
    routeSeo.canonicalPath,
  )
  const robots = resolveRobotsDirective(routeSeo.robots, options.deployEnv)
  const imageUrl = resolveImageUrl(
    options.siteUrl,
    routeSeo.imageUrl ?? DEFAULT_OG_IMAGE,
  )
  const imageAlt = routeSeo.imageAlt ?? DEFAULT_OG_IMAGE_ALT
  const structuredDataJson =
    routeSeo.includeStructuredData === false || robots === 'noindex, nofollow'
      ? null
      : escapeJsonForHtml(
          createStructuredData(routeSeo, {
            description: routeSeo.description,
            canonicalUrl,
            imageUrl,
          }),
        )

  return {
    title: routeSeo.title,
    description: routeSeo.description,
    canonicalUrl,
    robots,
    imageUrl,
    imageAlt,
    structuredDataJson,
  }
}

export function createSeoBlock(
  routeSeo: RouteSeoMetadata,
  options: SeoRuntimeOptions,
) {
  const resolved = resolveSeoMetadata(routeSeo, options)
  const lines = [
    `<title data-lf-seo="true">${escapeHtml(resolved.title)}</title>`,
    `<meta name="description" content="${escapeHtml(resolved.description)}" data-lf-seo="true" />`,
    `<meta name="robots" content="${resolved.robots}" data-lf-seo="true" />`,
    `<link rel="canonical" href="${resolved.canonicalUrl}" data-lf-seo="true" />`,
    `<meta property="og:type" content="website" data-lf-seo="true" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" data-lf-seo="true" />`,
    `<meta property="og:title" content="${escapeHtml(resolved.title)}" data-lf-seo="true" />`,
    `<meta property="og:description" content="${escapeHtml(resolved.description)}" data-lf-seo="true" />`,
    `<meta property="og:url" content="${resolved.canonicalUrl}" data-lf-seo="true" />`,
    `<meta property="og:image" content="${resolved.imageUrl}" data-lf-seo="true" />`,
    `<meta property="og:image:alt" content="${escapeHtml(resolved.imageAlt)}" data-lf-seo="true" />`,
    `<meta name="twitter:card" content="summary_large_image" data-lf-seo="true" />`,
    `<meta name="twitter:title" content="${escapeHtml(resolved.title)}" data-lf-seo="true" />`,
    `<meta name="twitter:description" content="${escapeHtml(resolved.description)}" data-lf-seo="true" />`,
    `<meta name="twitter:image" content="${resolved.imageUrl}" data-lf-seo="true" />`,
    `<meta name="twitter:image:alt" content="${escapeHtml(resolved.imageAlt)}" data-lf-seo="true" />`,
  ]

  if (resolved.structuredDataJson) {
    lines.push(
      `<script type="application/ld+json" data-lf-seo="true">${resolved.structuredDataJson}</script>`,
    )
  } else {
    lines.push(
      '<script type="application/ld+json" data-lf-seo="true">{}</script>',
    )
  }

  return lines.join('\n    ')
}

export function replaceSeoBlock(
  html: string,
  routeSeo: RouteSeoMetadata,
  options: SeoRuntimeOptions,
) {
  const block = createSeoBlock(routeSeo, options)
  if (!SEO_BLOCK_PATTERN.test(html)) {
    throw new Error('Unable to locate the managed SEO block in the HTML.')
  }

  return html.replace(SEO_BLOCK_PATTERN, block)
}

function appendManagedMeta(
  head: HTMLHeadElement,
  attribute: 'name' | 'property',
  key: string,
  content: string,
) {
  const meta = document.createElement('meta')
  meta.setAttribute(attribute, key)
  meta.setAttribute('content', content)
  meta.dataset.lfSeo = 'true'
  head.append(meta)
}

function upsertManagedTitle(content: string) {
  const titleNodes = [...document.head.querySelectorAll('title')]
  const title = titleNodes[0] ?? document.createElement('title')

  title.textContent = content
  title.dataset.lfSeo = 'true'

  if (!title.isConnected) {
    document.head.append(title)
  }

  for (const extraTitle of titleNodes.slice(1)) {
    extraTitle.remove()
  }
}

export function applyDocumentSeo(
  routeSeo: RouteSeoMetadata,
  options: SeoRuntimeOptions,
) {
  const resolved = resolveSeoMetadata(routeSeo, options)
  document.head
    .querySelectorAll('[data-lf-seo="true"]:not(title)')
    .forEach((node) => {
      node.remove()
    })
  upsertManagedTitle(resolved.title)

  appendManagedMeta(document.head, 'name', 'description', resolved.description)
  appendManagedMeta(document.head, 'name', 'robots', resolved.robots)

  const canonical = document.createElement('link')
  canonical.rel = 'canonical'
  canonical.href = resolved.canonicalUrl
  canonical.dataset.lfSeo = 'true'
  document.head.append(canonical)

  appendManagedMeta(document.head, 'property', 'og:type', 'website')
  appendManagedMeta(document.head, 'property', 'og:site_name', SITE_NAME)
  appendManagedMeta(document.head, 'property', 'og:title', resolved.title)
  appendManagedMeta(
    document.head,
    'property',
    'og:description',
    resolved.description,
  )
  appendManagedMeta(document.head, 'property', 'og:url', resolved.canonicalUrl)
  appendManagedMeta(document.head, 'property', 'og:image', resolved.imageUrl)
  appendManagedMeta(
    document.head,
    'property',
    'og:image:alt',
    resolved.imageAlt,
  )
  appendManagedMeta(
    document.head,
    'name',
    'twitter:card',
    'summary_large_image',
  )
  appendManagedMeta(document.head, 'name', 'twitter:title', resolved.title)
  appendManagedMeta(
    document.head,
    'name',
    'twitter:description',
    resolved.description,
  )
  appendManagedMeta(document.head, 'name', 'twitter:image', resolved.imageUrl)
  appendManagedMeta(
    document.head,
    'name',
    'twitter:image:alt',
    resolved.imageAlt,
  )

  const structuredData = document.createElement('script')
  structuredData.type = 'application/ld+json'
  structuredData.dataset.lfSeo = 'true'
  structuredData.textContent = resolved.structuredDataJson ?? '{}'
  document.head.append(structuredData)
}

export function createRobotsTxt(options: SeoRuntimeOptions) {
  if (options.deployEnv === 'preview') {
    return 'User-agent: *\nDisallow: /\n'
  }

  return `User-agent: *\nAllow: /\n\nSitemap: ${normalizeSiteUrl(options.siteUrl)}/sitemap.xml\n`
}

export function createSitemapXml(
  routes: RouteSeoMetadata[],
  options: SeoRuntimeOptions,
) {
  const urls = routes.map((route) => {
    const canonicalUrl = resolveCanonicalUrl(
      options.siteUrl,
      route.canonicalPath,
    )
    return `  <url>\n    <loc>${canonicalUrl}</loc>\n  </url>`
  })

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n')
}

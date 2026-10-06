export type ProfileSourceType = 'catalog' | 'entry' | 'cube'

export type ProfileSourceErrorCode =
  | 'empty-url'
  | 'invalid-url'
  | 'unsupported-scheme'
  | 'credentialed-url'
  | 'unsupported-resource'

export interface ProfileSourceResource {
  id: string
  url: string
  type: ProfileSourceType
  label: string
  fromQuery: boolean
  isDefault?: boolean
}

export interface ProfileSourceParseIssue {
  raw: string
  code: ProfileSourceErrorCode
  message: string
}

interface ParsedProfileSourceUrl {
  url: URL
  normalizedUrl: string
  type: ProfileSourceType
}

interface LUTResourceQueryResult {
  resources: ProfileSourceResource[]
  issues: ProfileSourceParseIssue[]
}

class ProfileSourceUrlError extends Error {
  constructor(
    readonly code: ProfileSourceErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export function normalizeProfileSourceUrl(value: string): string {
  return parseProfileSourceUrl(value).normalizedUrl
}

export function classifyProfileSourceUrl(value: string): ProfileSourceType {
  return parseProfileSourceUrl(value).type
}

// Transport rule shared by every online profile URL (query sources, catalog
// roots, entries, CUBE and preview assets): absolute HTTPS, or HTTP on a
// loopback host, never with credentials. It says nothing about resource
// shape; each caller classifies the resource on its own terms.
export function isProfileTransportUrl(value: string | undefined): boolean {
  if (!value) return false

  try {
    validateTransportUrl(new URL(value))
    return true
  } catch {
    return false
  }
}

export function parseLUTResourceQuery(query: string): LUTResourceQueryResult {
  const params = new URLSearchParams(
    query.startsWith('?') ? query.slice(1) : query,
  )
  const resources: ProfileSourceResource[] = []
  const issues: ProfileSourceParseIssue[] = []
  const seenUrls = new Set<string>()

  for (const raw of params.getAll('luts')) {
    try {
      const parsed = parseProfileSourceUrl(raw)

      if (seenUrls.has(parsed.normalizedUrl)) {
        continue
      }

      seenUrls.add(parsed.normalizedUrl)
      resources.push({
        id: `lut-source-${resources.length + 1}`,
        url: parsed.normalizedUrl,
        type: parsed.type,
        label: createSourceLabel(parsed.url, parsed.type),
        fromQuery: true,
      })
    } catch (error) {
      issues.push(createParseIssue(raw, error))
    }
  }

  return { resources, issues }
}

export function createLUTResourceShareUrl(
  path: string,
  resources: readonly ProfileSourceResource[],
): string {
  const [pathname] = path.split('?')
  const params = new URLSearchParams()
  const normalizedUrls = Array.from(
    new Set(
      resources.map((resource) => normalizeProfileSourceUrl(resource.url)),
    ),
  ).sort((left, right) => left.localeCompare(right, 'en-US'))

  for (const url of normalizedUrls) {
    params.append('luts', url)
  }

  const query = params.toString()

  return query ? `${pathname}?${query}` : pathname
}

function parseProfileSourceUrl(value: string): ParsedProfileSourceUrl {
  const raw = value.trim()

  if (!raw) {
    throw new ProfileSourceUrlError('empty-url', 'Source URL is empty.')
  }

  const url = parseUrl(raw)

  validateTransportUrl(url)

  const type = classifySupportedUrl(url)

  return {
    url,
    normalizedUrl: url.href,
    type,
  }
}

function parseUrl(value: string): URL {
  try {
    return new URL(value)
  } catch {
    throw new ProfileSourceUrlError('invalid-url', 'Source URL is invalid.')
  }
}

function validateTransportUrl(url: URL): void {
  if (url.protocol === 'https:') {
    validateCredentials(url)
    return
  }

  if (url.protocol === 'http:' && isLocalHttpHost(url.hostname)) {
    validateCredentials(url)
    return
  }

  throw new ProfileSourceUrlError(
    'unsupported-scheme',
    'Source URL must use HTTPS, or HTTP on localhost for local development.',
  )
}

function validateCredentials(url: URL): void {
  if (url.username || url.password) {
    throw new ProfileSourceUrlError(
      'credentialed-url',
      'Source URL must not include credentials.',
    )
  }
}

function classifySupportedUrl(url: URL): ProfileSourceType {
  const path = url.pathname.toLowerCase()

  if (
    path.endsWith('/catalog.json') ||
    path.endsWith('/lumaforge-profiles.json')
  ) {
    return 'catalog'
  }

  if (
    path.endsWith('/manifest.json') ||
    /^\/releases\/[^/]+\/entries\/[^/]+\.json$/u.test(path)
  ) {
    return 'entry'
  }

  if (path.endsWith('.cube')) {
    return 'cube'
  }

  throw new ProfileSourceUrlError(
    'unsupported-resource',
    'Source URL must point to a profile catalog, profile entry, or CUBE LUT.',
  )
}

function isLocalHttpHost(hostname: string): boolean {
  const host = hostname.toLowerCase()

  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]'
  )
}

function createParseIssue(
  raw: string,
  error: unknown,
): ProfileSourceParseIssue {
  if (error instanceof ProfileSourceUrlError) {
    return {
      raw,
      code: error.code,
      message: error.message,
    }
  }

  return {
    raw,
    code: 'invalid-url',
    message: 'Source URL is invalid.',
  }
}

function createSourceLabel(url: URL, type: ProfileSourceType): string {
  if (type === 'catalog') {
    return `Catalog from ${url.hostname}`
  }

  if (type === 'entry') {
    return `Entry from ${url.hostname}`
  }

  return url.pathname.split('/').filter(Boolean).at(-1) ?? url.hostname
}

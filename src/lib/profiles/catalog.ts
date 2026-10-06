import type { LUTContractSelection } from '@lumaforge/luma-color-runtime'

import { mapProfileLUTContract } from './lut-contract'

export type OnlineProfileIssueCode =
  | 'invalid-catalog'
  | 'invalid-entry'
  | 'unsupported-entry'
  | 'unsupported-asset'
  | 'missing-sha256'
  | 'invalid-url'
  | 'unsupported-contract'

export interface OnlineProfileIssue {
  code: OnlineProfileIssueCode
  message: string
  entryId?: string
}

export type OnlineProfileResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: OnlineProfileIssue[] }

export interface OnlineLUTAsset {
  url: string
  sha256: string
  bytes?: number
  title?: string
}

export interface OnlineLUTPreviewAsset {
  url: string
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/avif'
  bytes?: number
  width?: number
  height?: number
  title?: string
}

export interface OnlineLUTEntry {
  id: string
  title: string
  sourceUrl: string
  sourceType: 'catalog-entry' | 'direct-cube'
  cube: OnlineLUTAsset
  preview?: OnlineLUTPreviewAsset
  trustedContract?: LUTContractSelection
  tags: string[]
  family?: string
}

export type OnlineCatalogEntry = OnlineLUTEntry

interface ValidatedAsset {
  url: string
  sha256: string
  bytes: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function readString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const field = value[key]

  return typeof field === 'string' ? field : undefined
}

function issue(
  code: OnlineProfileIssueCode,
  message: string,
  entryId?: string,
): OnlineProfileIssue {
  return { code, message, entryId }
}

function isRuntimeUrl(value: string | undefined): boolean {
  if (!value) return false

  try {
    const url = new URL(value)

    if (url.protocol === 'https:') return true

    if (url.protocol !== 'http:') return false

    const host = url.hostname.toLowerCase()

    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
  } catch {
    return false
  }
}

function hasCubeMediaTypeOrExtension(asset: Record<string, unknown>): boolean {
  const mediaType = readString(asset, 'mediaType')?.toLowerCase()
  const url = readString(asset, 'url')

  if (mediaType === 'application/x-cube-lut') return true

  try {
    return url ? new URL(url).pathname.toLowerCase().endsWith('.cube') : false
  } catch {
    return false
  }
}

function readPositiveNumber(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const field = value[key]

  return typeof field === 'number' && Number.isFinite(field) && field > 0
    ? field
    : undefined
}

function inferPreviewMediaType(
  asset: Record<string, unknown>,
): OnlineLUTPreviewAsset['mediaType'] | undefined {
  const mediaType = readString(asset, 'mediaType')?.toLowerCase()
  if (
    mediaType === 'image/jpeg' ||
    mediaType === 'image/png' ||
    mediaType === 'image/webp' ||
    mediaType === 'image/avif'
  ) {
    return mediaType
  }

  const url = readString(asset, 'url')
  if (!url) return undefined

  try {
    const pathname = new URL(url).pathname.toLowerCase()
    if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) {
      return 'image/jpeg'
    }
    if (pathname.endsWith('.png')) return 'image/png'
    if (pathname.endsWith('.webp')) return 'image/webp'
    if (pathname.endsWith('.avif')) return 'image/avif'
  } catch {
    return undefined
  }

  return undefined
}

function validatePreviewAsset(
  asset: unknown,
  entryTitle: string,
): OnlineLUTPreviewAsset | undefined {
  if (!isRecord(asset)) return undefined

  const role = readString(asset, 'role')
  if (role !== 'preview-image' && role !== 'thumbnail') return undefined

  const url = readString(asset, 'url')
  if (!isRuntimeUrl(url)) return undefined

  const mediaType = inferPreviewMediaType(asset)
  if (!mediaType) return undefined

  return {
    url: url!,
    mediaType,
    bytes: readPositiveNumber(asset, 'size'),
    width: readPositiveNumber(asset, 'width'),
    height: readPositiveNumber(asset, 'height'),
    title: readString(asset, 'title') ?? entryTitle,
  }
}

function selectPreviewAsset(
  entry: Record<string, unknown>,
  entryTitle: string,
): OnlineLUTPreviewAsset | undefined {
  const explicit = validatePreviewAsset(entry.previewAsset, entryTitle)
  if (explicit) return explicit

  const assets = Array.isArray(entry.assets) ? entry.assets : []

  for (const asset of assets) {
    const preview = validatePreviewAsset(asset, entryTitle)
    if (preview) return preview
  }

  return undefined
}

function validateCubeAsset(
  asset: unknown,
  entryId: string | undefined,
): OnlineProfileResult<ValidatedAsset> {
  if (!isRecord(asset)) {
    return {
      ok: false,
      issues: [
        issue('unsupported-asset', 'Primary CUBE asset is missing.', entryId),
      ],
    }
  }

  const issues: OnlineProfileIssue[] = []
  const role = readString(asset, 'role')
  const url = readString(asset, 'url')
  const sha256 = readString(asset, 'sha256')
  const size = asset.size

  if (role !== 'cube-lut') {
    issues.push(
      issue(
        'unsupported-asset',
        'Primary asset role must be cube-lut.',
        entryId,
      ),
    )
  }

  if (!sha256) {
    issues.push(
      issue('missing-sha256', 'Primary asset sha256 is missing.', entryId),
    )
  } else if (!/^[a-f0-9]{64}$/iu.test(sha256)) {
    issues.push(
      issue('unsupported-asset', 'Primary asset sha256 is invalid.', entryId),
    )
  }

  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
    issues.push(
      issue(
        'unsupported-asset',
        'Primary asset size must be positive.',
        entryId,
      ),
    )
  }

  if (!isRuntimeUrl(url)) {
    issues.push(
      issue(
        'invalid-url',
        'Primary asset URL must use HTTPS or localhost HTTP.',
        entryId,
      ),
    )
  }

  if (!hasCubeMediaTypeOrExtension(asset)) {
    issues.push(
      issue(
        'unsupported-asset',
        'Primary asset must be recognizable as a CUBE LUT.',
        entryId,
      ),
    )
  }

  if (issues.length > 0) {
    return { ok: false, issues }
  }

  return {
    ok: true,
    value: { url: url!, sha256: sha256!, bytes: size as number },
  }
}

function readTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  return value.filter((tag): tag is string => typeof tag === 'string')
}

function validateReleaseEntryFields(
  entry: Record<string, unknown>,
): OnlineProfileIssue[] {
  const entryId = readString(entry, 'id')
  const issues: OnlineProfileIssue[] = []

  if (
    !entryId ||
    !readString(entry, 'version') ||
    !readString(entry, 'title') ||
    !readString(entry, 'license')
  ) {
    issues.push(
      issue(
        'invalid-entry',
        'Release entry is missing required fields.',
        entryId,
      ),
    )
  }

  if (readString(entry, 'kind') !== 'lut') {
    issues.push(
      issue('unsupported-entry', 'Only LUT entries are supported.', entryId),
    )
  }

  if (entry.redistributionAllowed !== true) {
    issues.push(
      issue(
        'unsupported-entry',
        'Only redistributable entries are supported.',
        entryId,
      ),
    )
  }

  return issues
}

function validateCatalogEntryFields(
  entry: Record<string, unknown>,
): OnlineProfileIssue[] {
  const entryId = readString(entry, 'id')
  const issues: OnlineProfileIssue[] = []

  if (
    !entryId ||
    !readString(entry, 'version') ||
    !readString(entry, 'title') ||
    !readString(entry, 'license')
  ) {
    issues.push(
      issue(
        'invalid-entry',
        'Catalog entry is missing required fields.',
        entryId,
      ),
    )
  }

  return issues
}

function selectReleaseEntryAsset(
  entry: Record<string, unknown>,
  entryId: string | undefined,
): OnlineProfileResult<ValidatedAsset> {
  if (entry.primaryAsset !== undefined && entry.primaryAsset !== null) {
    return validateCubeAsset(entry.primaryAsset, entryId)
  }

  const assets = Array.isArray(entry.assets) ? entry.assets : []
  const candidate = assets.find((asset) => {
    if (!isRecord(asset)) return false

    return asset.role === 'cube-lut' && hasCubeMediaTypeOrExtension(asset)
  })

  return validateCubeAsset(candidate, entryId)
}

function buildEntry(
  entry: Record<string, unknown>,
  sourceUrl: string,
  asset: ValidatedAsset,
  trustedContract?: LUTContractSelection,
): OnlineLUTEntry {
  const title = readString(entry, 'title')!

  return {
    id: readString(entry, 'id')!,
    title,
    sourceUrl,
    sourceType: 'catalog-entry',
    cube: {
      url: asset.url,
      sha256: asset.sha256,
      bytes: asset.bytes,
      title,
    },
    preview: selectPreviewAsset(entry, title),
    trustedContract,
    tags: readTags(entry.tags),
    family: readString(entry, 'family'),
  }
}

export function parseReleaseCatalog(
  document: unknown,
  sourceUrl: string,
): OnlineProfileResult<OnlineCatalogEntry[]> {
  if (!isRuntimeUrl(sourceUrl)) {
    return {
      ok: false,
      issues: [issue('invalid-url', 'Catalog source URL is invalid.')],
    }
  }

  if (
    !isRecord(document) ||
    document.schemaVersion !== 1 ||
    !Array.isArray(document.entries)
  ) {
    return {
      ok: false,
      issues: [issue('invalid-catalog', 'Release catalog shape is invalid.')],
    }
  }

  const entries: OnlineCatalogEntry[] = []
  const issues: OnlineProfileIssue[] = []
  let sawLutEntry = false

  for (const entry of document.entries) {
    if (!isRecord(entry)) {
      issues.push(issue('invalid-entry', 'Catalog entry is invalid.'))
      continue
    }

    const entryId = readString(entry, 'id')
    const entryIssues: OnlineProfileIssue[] = []

    const kind = readString(entry, 'kind')
    if (kind !== 'lut') {
      issues.push(
        issue('unsupported-entry', 'Only LUT entries are supported.', entryId),
      )
      continue
    }

    sawLutEntry = true

    if (entry.redistributionAllowed !== true) {
      issues.push(
        issue(
          'unsupported-entry',
          'Only redistributable entries are supported.',
          entryId,
        ),
      )
      continue
    }

    entryIssues.push(...validateCatalogEntryFields(entry))

    const entryUrl = readString(entry, 'entryUrl')
    if (!isRuntimeUrl(entryUrl)) {
      entryIssues.push(
        issue(
          'invalid-url',
          'Catalog entry URL must be an absolute HTTPS or localhost HTTP URL.',
          entryId,
        ),
      )
    }

    const asset = validateCubeAsset(entry.primaryAsset, entryId)
    if (!asset.ok) {
      entryIssues.push(...asset.issues)
      issues.push(...entryIssues)
      continue
    }

    if (entryIssues.length > 0) {
      issues.push(...entryIssues)
      continue
    }

    if (entryUrl && isRuntimeUrl(entryUrl)) {
      const validatedAsset = asset.value
      entries.push(buildEntry(entry, entryUrl, validatedAsset))
    }
  }

  if (entries.length > 0) {
    return { ok: true, value: entries }
  }

  // Rows exist but none of them is a LUT: this is not a LUT catalog (for
  // example a camera/lens profile catalog). Report one catalog-level issue
  // instead of one per row. A catalog whose LUT rows merely failed
  // validation keeps reporting those issues.
  if (document.entries.length > 0 && !sawLutEntry) {
    return {
      ok: false,
      issues: [issue('invalid-catalog', 'Release catalog has no LUT entries.')],
    }
  }

  return {
    ok: false,
    issues:
      issues.length > 0
        ? issues
        : [
            issue(
              'unsupported-entry',
              'Catalog does not contain compatible redistributable CUBE LUT entries.',
            ),
          ],
  }
}

export function parseReleaseEntry(
  document: unknown,
  sourceUrl: string,
): OnlineProfileResult<OnlineLUTEntry> {
  if (!isRuntimeUrl(sourceUrl)) {
    return {
      ok: false,
      issues: [issue('invalid-url', 'Entry source URL is invalid.')],
    }
  }

  if (!isRecord(document)) {
    return {
      ok: false,
      issues: [issue('invalid-entry', 'Release entry shape is invalid.')],
    }
  }

  const entryId = readString(document, 'id')
  const issues = validateReleaseEntryFields(document)

  if (document.schemaVersion !== 1) {
    issues.push(
      issue('invalid-entry', 'Release entry schemaVersion must be 1.', entryId),
    )
  }

  if (readString(document, 'format') !== 'cube') {
    issues.push(
      issue(
        'unsupported-entry',
        'Only CUBE LUT entries are supported.',
        entryId,
      ),
    )
  }

  const entryUrl = readString(document, 'entryUrl')
  if (entryUrl && !isRuntimeUrl(entryUrl)) {
    issues.push(
      issue(
        'invalid-url',
        'Release entry URL must be an absolute HTTPS or localhost HTTP URL.',
        entryId,
      ),
    )
  }

  const asset = selectReleaseEntryAsset(document, entryId)
  if (!asset.ok) issues.push(...asset.issues)

  const contract = mapProfileLUTContract(document.lut)
  if (!contract.ok) {
    issues.push(
      ...contract.issues.map((contractIssue) => ({
        ...contractIssue,
        entryId,
      })),
    )
  }

  if (issues.length > 0) {
    return { ok: false, issues }
  }

  if (!asset.ok || !contract.ok) {
    return {
      ok: false,
      issues: [
        issue('invalid-entry', 'Release entry shape is invalid.', entryId),
      ],
    }
  }

  return {
    ok: true,
    value: buildEntry(document, sourceUrl, asset.value, contract.value),
  }
}

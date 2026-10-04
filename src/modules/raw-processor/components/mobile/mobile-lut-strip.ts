import type { UseOnlineLutSourcesResult } from '../../hooks/useOnlineLutSources'

type OnlineEntry = UseOnlineLutSourcesResult['state']['entries'][number]
type OnlineResource = UseOnlineLutSourcesResult['state']['resources'][number]

/** The LUT the session applies, as far as the strip needs to know it. */
export interface AppliedLut {
  /** Style name; the strip falls back to it for a file's title. */
  name: string
  /** SHA-256 of the applied .cube bytes. */
  sha256?: string | null
  /** The file or URL name the LUT came from. */
  sourceName?: string | null
}

/**
 * A catalog entry with no declared hash (a direct .cube URL) cannot be
 * matched by content up front, so the strip remembers which entry it loaded
 * and the hash the session reported for it.
 */
export interface LoadedLutEntry {
  entryId: string
  sha256: string
}

export type LutStripItem =
  | { kind: 'original'; key: 'original'; applied: boolean }
  | { kind: 'custom'; key: 'custom'; title: string }
  | {
      kind: 'source'
      key: string
      resourceId: string
      label: string
      /** Only drawn when more than one source has entries. */
      labelled: boolean
      entries: LutStripEntryItem[]
    }
  | { kind: 'import'; key: 'import' }

export interface LutStripEntryItem {
  key: string
  entry: OnlineEntry
  eyebrow: string
  applied: boolean
}

function sameSha(a: string | null | undefined, b: string | null | undefined) {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase())
}

/**
 * An entry is applied when its cube's SHA-256 is the applied style's. An
 * entry without a declared hash matches only the load the strip itself
 * recorded for it.
 */
export function isLutEntryApplied(
  entry: OnlineEntry,
  applied: AppliedLut | null | undefined,
  loaded: LoadedLutEntry | null | undefined,
) {
  if (!applied?.sha256) return false
  if (entry.cube.sha256) return sameSha(entry.cube.sha256, applied.sha256)
  return loaded?.entryId === entry.id && sameSha(loaded.sha256, applied.sha256)
}

function resourceLabel(resource: OnlineResource) {
  return resource.label || resource.url
}

/**
 * Strip order: Original, then the applied LUT when it is a file that no
 * catalog entry matches, then every online source's entries in source
 * order (a source label before each when more than one source has any),
 * then Import .cube.
 */
export function buildLutStripItems(input: {
  resources: readonly OnlineResource[]
  entries: readonly OnlineEntry[]
  applied: AppliedLut | null | undefined
  loaded?: LoadedLutEntry | null
}): LutStripItem[] {
  const sources = input.resources
    .map((resource) => {
      const label = resourceLabel(resource)
      const entries = input.entries
        .filter((entry) => entry.resourceId === resource.id)
        .map<LutStripEntryItem>((entry) => ({
          key: `${resource.id}:${entry.id}`,
          entry,
          eyebrow: entry.family || label,
          applied: isLutEntryApplied(entry, input.applied, input.loaded),
        }))
      return { resource, label, entries }
    })
    .filter((source) => source.entries.length > 0)

  const labelled = sources.length > 1
  const anyEntryApplied = sources.some((source) =>
    source.entries.some((item) => item.applied),
  )

  const items: LutStripItem[] = [
    { kind: 'original', key: 'original', applied: !input.applied },
  ]
  if (input.applied && !anyEntryApplied) {
    items.push({
      kind: 'custom',
      key: 'custom',
      title: input.applied.sourceName || input.applied.name,
    })
  }
  for (const source of sources) {
    items.push({
      kind: 'source',
      key: `source:${source.resource.id}`,
      resourceId: source.resource.id,
      label: source.label,
      labelled,
      entries: source.entries,
    })
  }
  items.push({ kind: 'import', key: 'import' })
  return items
}

/** The key of the tile that reads as applied, for scrolling it into view. */
export function getAppliedStripKey(items: readonly LutStripItem[]) {
  for (const item of items) {
    if (item.kind === 'original' && item.applied) return item.key
    if (item.kind === 'custom') return item.key
    if (item.kind === 'source') {
      const applied = item.entries.find((entry) => entry.applied)
      if (applied) return applied.key
    }
  }
  return null
}

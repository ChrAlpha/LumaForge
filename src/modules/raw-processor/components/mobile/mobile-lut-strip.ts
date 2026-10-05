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
      kind: 'group'
      key: string
      resourceId: string
      /**
       * The slim divider label before the group: the humanized family, or
       * the source label for entries without one. Null for a lone
       * family-less group, which has nothing to tell apart.
       */
      label: string | null
      entries: LutStripEntryItem[]
    }
  | { kind: 'import'; key: 'import' }

export interface LutStripEntryItem {
  key: string
  entry: OnlineEntry
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

/**
 * The name the applied look goes by everywhere it is named: a catalog look
 * by the title its catalog lists, a user's file by its file name, else the
 * LUT's own title. Null with no LUT applied.
 */
export function resolveAppliedLookTitle(input: {
  entries: readonly OnlineEntry[]
  applied: AppliedLut | null | undefined
  loaded?: LoadedLutEntry | null
}): string | null {
  const { applied } = input
  if (!applied) return null
  const entry = input.entries.find((candidate) =>
    isLutEntryApplied(candidate, applied, input.loaded),
  )
  return entry?.title || applied.sourceName || applied.name
}

function resourceLabel(resource: OnlineResource) {
  return resource.label || resource.url
}

/**
 * A family slug (`arri-look-library`, `fujifilm-film-simulation`) reads as
 * its first token: kept uppercase when it is a short mark of four letters
 * or fewer (ARRI), title case otherwise (Fujifilm). Null when the slug has
 * no token to show.
 */
export function humanizeLutFamily(
  family: string | null | undefined,
): string | null {
  const token = family?.trim().split(/[\s_-]+/)[0]
  if (!token) return null
  if (token.length <= 4) return token.toUpperCase()
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase()
}

/**
 * Strip order: Original, then the applied LUT when it is a file that no
 * catalog entry matches, then every online source's entries in source
 * order, then Import .cube. Consecutive entries of one source that share a
 * family label form a group with one divider before it; entries without a
 * family take the source label instead.
 */
export function buildLutStripItems(input: {
  resources: readonly OnlineResource[]
  entries: readonly OnlineEntry[]
  applied: AppliedLut | null | undefined
  loaded?: LoadedLutEntry | null
}): LutStripItem[] {
  const groups: Extract<LutStripItem, { kind: 'group' }>[] = []
  const familyLabelled = new Set<string>()
  for (const resource of input.resources) {
    const sourceLabel = resourceLabel(resource)
    let current: (typeof groups)[number] | null = null
    for (const entry of input.entries) {
      if (entry.resourceId !== resource.id) continue
      const family = humanizeLutFamily(entry.family)
      const label = family ?? sourceLabel
      const item: LutStripEntryItem = {
        key: `${resource.id}:${entry.id}`,
        entry,
        applied: isLutEntryApplied(entry, input.applied, input.loaded),
      }
      if (current && current.label === label) {
        current.entries.push(item)
      } else {
        current = {
          kind: 'group',
          key: `group:${resource.id}:${entry.id}`,
          resourceId: resource.id,
          label,
          entries: [item],
        }
        groups.push(current)
      }
      if (family) familyLabelled.add(current.key)
    }
  }
  const anyEntryApplied = groups.some((group) =>
    group.entries.some((item) => item.applied),
  )
  const custom = Boolean(input.applied && !anyEntryApplied)
  // A lone family-less group has nothing to tell apart, unless the file
  // tile (labelled My file) sits right before it.
  if (groups.length === 1 && !custom && !familyLabelled.has(groups[0].key)) {
    groups[0].label = null
  }

  const items: LutStripItem[] = [
    { kind: 'original', key: 'original', applied: !input.applied },
  ]
  if (input.applied && custom) {
    items.push({
      kind: 'custom',
      key: 'custom',
      title: input.applied.sourceName || input.applied.name,
    })
  }
  items.push(...groups)
  items.push({ kind: 'import', key: 'import' })
  return items
}

/** The strip entry that reads as applied, when a catalog entry does. */
export function getAppliedStripEntry(items: readonly LutStripItem[]) {
  for (const item of items) {
    if (item.kind !== 'group') continue
    const applied = item.entries.find((entry) => entry.applied)
    if (applied) return applied
  }
  return null
}

/** The key of the tile that reads as applied, for scrolling it into view. */
export function getAppliedStripKey(items: readonly LutStripItem[]) {
  for (const item of items) {
    if (item.kind === 'original' && item.applied) return item.key
    if (item.kind === 'custom') return item.key
  }
  return getAppliedStripEntry(items)?.key ?? null
}

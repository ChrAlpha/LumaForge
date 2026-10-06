export interface FamilyGroup<T> {
  family: string
  items: T[]
}

export interface GroupedEntries<T> {
  families: FamilyGroup<T>[]
  others: T[]
}

export function groupEntriesByFamily<T extends { family?: string | null }>(
  entries: readonly T[],
): GroupedEntries<T> {
  const families = new Map<string, T[]>()
  const others: T[] = []

  for (const entry of entries) {
    if (entry.family) {
      const bucket = families.get(entry.family)
      if (bucket) {
        bucket.push(entry)
      } else {
        families.set(entry.family, [entry])
      }
    } else {
      others.push(entry)
    }
  }

  return {
    families: Array.from(families, ([family, items]) => ({ family, items })),
    others,
  }
}

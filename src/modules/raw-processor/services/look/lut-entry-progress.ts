/** Bytes a catalog entry download has received, and its size when known. */
interface LutEntryByteProgress {
  receivedBytes: number
  totalBytes?: number
}

/**
 * Whole-percent progress of a catalog entry download, capped at 100. Null
 * while there is no progress or its total size is unknown, so a surface shows
 * an indeterminate load rather than a made-up bar.
 */
export function entryLoadPercent(
  progress: LutEntryByteProgress | null,
): number | null {
  if (!progress?.totalBytes) return null

  return Math.min(
    100,
    Math.round((progress.receivedBytes / progress.totalBytes) * 100),
  )
}

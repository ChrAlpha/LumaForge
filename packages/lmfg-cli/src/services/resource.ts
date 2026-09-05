import process from 'node:process'

export type ResourceUsage = { max_rss_bytes: number }

/** Peak resident set size of this process so far (Node reports kilobytes). */
export function captureResourceUsage(): ResourceUsage {
  return { max_rss_bytes: Math.round(process.resourceUsage().maxRSS * 1024) }
}

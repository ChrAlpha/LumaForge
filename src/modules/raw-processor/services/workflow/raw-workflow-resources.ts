import type { ExportResourceCleanupReason } from '~/lib/export/execution-profile'

/**
 * The owners of what a source holds while it is shown. Each keeps its own
 * state and makes its own release idempotent: the RAW host its session lease
 * and native generation, the export stage its controller, the resource
 * registry the delivered results, the preview stage the embedded URL. A
 * release only fences the outgoing work and calls them, in order. The GPU
 * pipelines are not among them: their own owners release them when the
 * preview unmounts or suspends.
 */
type SourceResourceOwners = {
  runtimeWorkSessionIdRef: { current: string | null }
  pendingLoadSessionIdRef: { current: string | null }
  previewCopyCanvasRef: { current: HTMLCanvasElement | null }
  abortExportWork: () => void
  abortRuntimeWork: () => void
  queueExportResultResourceDisposal: (
    reason?: ExportResourceCleanupReason,
  ) => void
  revokeCurrentEmbeddedPreviewUrl: () => void
}

function releaseSource(
  owners: SourceResourceOwners,
  disposeExportResults: () => void,
) {
  // The fences drop first, so a callback the outgoing load or restore still
  // has in flight, even one that settles while its owner is cancelled, finds
  // its session gone and writes nothing.
  owners.runtimeWorkSessionIdRef.current = null
  owners.pendingLoadSessionIdRef.current = null
  owners.abortExportWork()
  owners.abortRuntimeWork()
  disposeExportResults()
  owners.revokeCurrentEmbeddedPreviewUrl()
  owners.previewCopyCanvasRef.current = null
}

/**
 * Releases what the shown source holds when the session resets. The caller
 * clears the workflow state and drops the session afterwards.
 */
export function releaseSourceForReset(owners: SourceResourceOwners): void {
  releaseSource(owners, () =>
    owners.queueExportResultResourceDisposal('reset-session'),
  )
}

/**
 * Releases what the shown source holds when a new file replaces it. The
 * caller begins the new source's lease and publishes its session afterwards.
 */
export function releaseSourceForReplacement(
  owners: SourceResourceOwners,
): void {
  releaseSource(owners, () => owners.queueExportResultResourceDisposal())
}

/**
 * Releases what the shown source holds when the workflow unmounts, and
 * returns the load it fenced while that load was still pending. The caller
 * marks the workflow unmounted first and afterwards drops only that pending
 * session; a loaded one stays in the store.
 */
export function releaseSourceForUnmount(
  owners: SourceResourceOwners,
): string | null {
  const pendingLoadSessionId = owners.pendingLoadSessionIdRef.current
  releaseSource(owners, () => owners.queueExportResultResourceDisposal())
  return pendingLoadSessionId
}

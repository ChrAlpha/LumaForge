import type { PreviewColorExecutor } from '@lumaforge/render-engine/preview'

import type { ProcessingStatus } from '../../model/workflow'
import type { TransformExportBlock } from '../transform/transform-state'
import type { RawReasonCode } from './raw-reason'

export type ToolSurface = 'desktop' | 'mobile'

/**
 * The actions a tool surface offers, each with its own availability. They
 * are never folded into one compare or edit flag: the CPU preview can show
 * the original without a split, and a released preview locks every edit but
 * keeps Export, the delivered result and Restore.
 */
export type ToolAction =
  /**
   * Tone, color and HSL edits. On mobile it also gates the deck every tool
   * panel sits in, Transform's included.
   */
  | 'edit'
  /** How much of the applied LUT reaches the photo. */
  | 'strength'
  /** Loading, clearing or choosing the contract of a LUT. */
  | 'lutApplication'
  /** Showing the original in place of the processed photo: a peek or toggle. */
  | 'originalView'
  /** The RAW / final split and its handle. */
  | 'split'
  /** Putting the split back at its centre and the photo at fit. */
  | 'splitReset'
  /** Reaching the export controls at all. */
  | 'exportEntry'
  | 'fullExport'
  | 'hqExport'
  /** Share, download, manifest and copy of the delivered JPEG. */
  | 'delivery'
  /** Bringing the preview back after export released it. */
  | 'restorePreview'
  /** Transform's Upright modes, manual geometry and constrained crop. */
  | 'transformGeometry'
  /** Transform's guide lines and grid over the photo. */
  | 'transformOverlay'
  /** Putting Transform back to neutral. */
  | 'transformReset'

/**
 * Whether an action can run, and the surface reason when it cannot. A null
 * reason on a refused action means the surface policy has nothing to add:
 * the workflow names its own reason (an export it cannot reproduce, an HQ
 * preview not rendered yet), or there is simply nothing to act on.
 */
export type ActionAvailability =
  | { available: true; reason: null }
  | { available: false; reason: RawReasonCode | null }

export type ToolAvailability = Record<ToolAction, ActionAvailability>

/**
 * What the Transform preview observes of the frame it works on. When it
 * captures is the preview's own business; these are only the facts its
 * commands depend on.
 */
export interface TransformPreviewObservation {
  /**
   * A frame of this RAW can be captured now: the decoded photo is present,
   * the preview is not released, and the executor holds a frame to read
   * back (the CPU stage's current frame, or the WebGPU pipeline).
   */
  canCapture: boolean
  /** The Transform worker holds an analysed frame to answer geometry on. */
  workerReady: boolean
  /** The last frame could not be captured, analysed or kept. */
  captureFailed: boolean
  /** The preview shows an answer on a frame of the photo as it now looks. */
  current: boolean
}

export interface ToolAvailabilityInput {
  surface: ToolSurface
  /** A source with something on screen to edit. */
  hasImage: boolean
  status: ProcessingStatus
  executor: PreviewColorExecutor
  /** Export holds the decoded preview released. */
  previewSuspended: boolean
  /** A committed Transform the preview shows. */
  transformActive: boolean
  /** Why full resolution cannot reproduce the Transform asked for yet. */
  transformExportBlock: TransformExportBlock | null
  hasAppliedLut: boolean
  /** The workflow's own full-resolution readiness, before Transform. */
  canExport: boolean
  /** The workflow's only full-resolution block is the LUT colour contract. */
  lutContractBlocksExport: boolean
  /** The workflow's own HQ preview readiness, before Transform. */
  canPreviewExport: boolean
  hasExportResult: boolean
  /** The Transform preview, where the surface has a Transform tool. */
  transformPreview?: TransformPreviewObservation | null
}

const AVAILABLE: ActionAvailability = { available: true, reason: null }

function refused(reason: RawReasonCode | null): ActionAvailability {
  return { available: false, reason }
}

function fromReason(reason: RawReasonCode | null | undefined) {
  return reason ? refused(reason) : AVAILABLE
}

function busyReason(status: ProcessingStatus): RawReasonCode | null {
  switch (status) {
    case 'warming': {
      return 'runtime-warming'
    }
    case 'loading': {
      return 'source-loading'
    }
    case 'decoding': {
      return 'preview-decoding'
    }
    case 'processing': {
      return 'look-processing'
    }
    case 'exporting': {
      return 'export-running'
    }
    default: {
      return null
    }
  }
}

/**
 * Transform waits out the stages that replace the photo its frame is read
 * from, but keeps its controls while the runtime warms or the look
 * reprocesses: the frame follows the colour on its own.
 */
function transformLockReason(status: ProcessingStatus): RawReasonCode | null {
  return status === 'loading' || status === 'decoding' || status === 'exporting'
    ? busyReason(status)
    : null
}

const TRANSFORM_EXPORT_REASON: Record<TransformExportBlock, RawReasonCode> = {
  pending: 'transform-pending',
  invalid: 'transform-invalid',
  unavailable: 'transform-unavailable',
}

/**
 * What each tool surface action can do right now, from the facts the tool
 * provider already holds. Pure: it reads no React state, router, i18n or
 * runtime, and its reasons are codes, never sentences.
 *
 * The two surfaces differ while the pipeline decodes or processes. Desktop
 * keeps its controls and locks them only for an export; mobile hands the
 * stage over to the progress handoff and waits for any busy stage. Before a
 * source, desktop keeps the sample compare's split and stages a LUT, while
 * mobile has no dock or lens to act through. Transform's actions follow
 * its own frame on both surfaces alike; on mobile the deck that holds the
 * Transform panel is still reached only where `edit` is available, so it
 * stays out of reach while the runtime warms or the look reprocesses.
 */
export function deriveToolAvailability(
  input: ToolAvailabilityInput,
): ToolAvailability {
  const {
    surface,
    hasImage,
    status,
    previewSuspended,
    transformActive,
    transformExportBlock,
    transformPreview,
  } = input
  const busy = busyReason(status)
  const exporting = status === 'exporting'
  const cpu = input.executor === 'cpu'
  const mobile = surface === 'mobile'
  // Desktop locks its controls only for an export; mobile for any busy stage.
  const editLock = mobile ? busy : exporting ? busy : null

  const edit = fromReason(
    !hasImage ? 'no-source' : previewSuspended ? 'preview-released' : editLock,
  )
  const strength = edit.available
    ? fromReason(input.hasAppliedLut ? null : 'no-lut')
    : edit
  const lutApplication =
    mobile && !hasImage
      ? refused('no-source')
      : fromReason(previewSuspended ? 'preview-released' : editLock)

  // A committed Transform shows the processed photo alone, so neither the
  // original nor the split has anything to compare it with.
  const originalView = fromReason(
    !hasImage
      ? 'no-source'
      : previewSuspended
        ? 'preview-released'
        : mobile && busy
          ? busy
          : transformActive
            ? 'transform-compare'
            : null,
  )
  // The CPU preview has no split surface. Before a source the desktop stage
  // still draws the sample compare, whose split is its own, and a released
  // preview without a photo has no handoff to replace it.
  const split = fromReason(
    mobile && !hasImage
      ? 'no-source'
      : previewSuspended && hasImage
        ? 'preview-released'
        : (mobile || exporting) && busy
          ? busy
          : transformActive
            ? 'transform-compare'
            : hasImage && cpu
              ? 'cpu-preview'
              : null,
  )
  const splitReset = !split.available
    ? split
    : !hasImage
      ? refused('no-source')
      : AVAILABLE

  // Desktop keeps its export block on screen; mobile reaches export only
  // through the topbar action, which waits for a stage that is not export.
  const exportEntry = fromReason(
    !mobile ? null : !hasImage ? 'no-source' : exporting ? null : busy,
  )
  // Transform names the block only where the workflow has nothing earlier
  // to say: an export that could otherwise run, or one held by the contract.
  const fullExport = !exportEntry.available
    ? exportEntry
    : busy
      ? refused(busy)
      : transformExportBlock &&
          (input.canExport || input.lutContractBlocksExport)
        ? refused(TRANSFORM_EXPORT_REASON[transformExportBlock])
        : input.canExport
          ? AVAILABLE
          : refused(null)
  // The HQ preview never applies Transform.
  const hqExport = !exportEntry.available
    ? exportEntry
    : busy
      ? refused(busy)
      : transformActive || transformExportBlock
        ? refused('transform-hq-export')
        : input.canPreviewExport
          ? AVAILABLE
          : refused(null)
  const delivery = !exportEntry.available
    ? exportEntry
    : input.hasExportResult
      ? AVAILABLE
      : refused(null)
  const restorePreview = !previewSuspended
    ? refused(null)
    : !hasImage
      ? refused('no-source')
      : fromReason(busy)

  // Transform answers geometry on a frame of the photo, so its controls
  // wait for one the worker holds. Reset only clears the intent, and stays
  // open when the frame failed. The guides draw over the current answer.
  const transformLock = previewSuspended
    ? 'preview-released'
    : transformLockReason(status)
  const frameReason =
    !transformPreview ||
    !transformPreview.canCapture ||
    transformPreview.captureFailed
      ? 'transform-unavailable'
      : null
  const transformGeometry = !transformPreview
    ? refused(null)
    : fromReason(
        !hasImage
          ? 'no-source'
          : (transformLock ??
              frameReason ??
              (transformPreview.workerReady ? null : 'transform-pending')),
      )
  const transformOverlay = !transformPreview
    ? refused(null)
    : fromReason(
        !hasImage
          ? 'no-source'
          : (transformLock ??
              (transformPreview.current
                ? null
                : (frameReason ?? 'transform-pending'))),
      )
  const transformReset = !transformPreview
    ? refused(null)
    : fromReason(transformLock)

  return {
    edit,
    strength,
    lutApplication,
    originalView,
    split,
    splitReset,
    exportEntry,
    fullExport,
    hqExport,
    delivery,
    restorePreview,
    transformGeometry,
    transformOverlay,
    transformReset,
  }
}

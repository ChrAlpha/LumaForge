import type { PreviewColorExecutor } from '@lumaforge/render-engine/preview'

import type { TransformExportBlock } from '../../hooks/useRawTransformFeature'
import type { ProcessingStatus } from '../../model/workflow'
import type { RawReasonCode } from './raw-reason'

export type ToolSurface = 'desktop' | 'mobile'

/**
 * The actions a tool surface offers, each with its own availability. They
 * are never folded into one compare or edit flag: the CPU preview can show
 * the original without a split, and a released preview locks every edit but
 * keeps Export, the delivered result and Restore.
 */
export type ToolAction =
  /** Tone, color, HSL and Transform edits. */
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
 * mobile has no dock or lens to act through.
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
  }
}

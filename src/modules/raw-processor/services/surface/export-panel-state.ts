import type { Translate } from '~/lib/i18n'

import type { ExportResultKind } from '../../model/export-result'
import type { FullExportActionReason, HqExportActionReason } from './raw-reason'
import {
  fullExportActionReasonText,
  hqExportActionReasonText,
} from './raw-reason'

export type ExportPanelKind = 'full' | 'hq'

export interface ExportPanelInput<Note> {
  canExport: boolean
  disabledReason?: FullExportActionReason
  canPreviewExport?: boolean
  previewExportDisabledReason?: HqExportActionReason
  isProcessing: boolean
  /** A full-resolution or HQ preview export is running. */
  isExporting: boolean
  /** The button that started the export the panel last ran. */
  startedKind: ExportPanelKind
  interruptionNote?: Note | null
  resultKind?: ExportResultKind
}

export interface ExportPanelState<Note> {
  /** Which export is running, or null when none is. */
  runningKind: ExportPanelKind | null
  /** Why full resolution is refused, or null when it is not. */
  fullReason: string | null
  /** Why the HQ preview is refused, when the full reason does not say it. */
  previewReason: string | null
  /** The HQ preview is refused for the reason the full line states. */
  previewRepeatsFull: boolean
  /** The interruption hint, held back while anything is processing. */
  interruptionNote: Note | null
  /** The kind the result names; a result that names none takes no label. */
  resultKind: ExportResultKind | null
}

/**
 * What both export panels state from one set of export decisions. Each
 * surface paints it its own way; neither decides it again.
 */
export function deriveExportPanelState<Note>(
  input: ExportPanelInput<Note>,
  t: Translate,
): ExportPanelState<Note> {
  // A busy stage refuses with its own reason (loading, decoding), which
  // stays readable; a running export shows on its button instead.
  const fullReason =
    input.canExport || input.isExporting
      ? null
      : input.disabledReason
        ? fullExportActionReasonText(input.disabledReason, t)
        : t('raw.exportSourceLoading')
  // The HQ preview can be refused on its own terms while full resolution is
  // fine (a committed Transform does exactly that). A reason the full line
  // already states is not repeated.
  const previewText =
    input.canPreviewExport ||
    input.isExporting ||
    !input.previewExportDisabledReason
      ? null
      : hqExportActionReasonText(input.previewExportDisabledReason, t)
  return {
    runningKind: input.isExporting ? input.startedKind : null,
    fullReason,
    previewReason: previewText === fullReason ? null : previewText,
    previewRepeatsFull: previewText !== null && previewText === fullReason,
    // The next export the user starts uses the current RAW and edits on a
    // safer plan; a running export already took it.
    interruptionNote: input.isProcessing
      ? null
      : (input.interruptionNote ?? null),
    resultKind: input.resultKind ?? null,
  }
}

/** Export progress as a whole percent in 0-100, or null when unknown. */
export function exportProgressPercent(progress: number | undefined) {
  return typeof progress === 'number' && Number.isFinite(progress)
    ? Math.round(Math.min(100, Math.max(0, progress)))
    : null
}

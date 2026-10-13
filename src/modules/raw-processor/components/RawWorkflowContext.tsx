import type {
  HSLBandId,
  HSLBandShift,
  LUTColorProfile,
  LUTContractResolution,
  PreviewHistogramState,
} from '@lumaforge/luma-color-runtime'
import { createContext, useContext } from 'react'

import type { MessageKey } from '~/lib/i18n'
import type { ImageMetadata } from '~/lib/raw/decoder'
import type { PipelineStats } from '~/lib/webgpu/raw-processing-pipeline'

import type { UseOnlineLutSourcesResult } from '../hooks/useOnlineLutSources'
import type { RawTransformFeature } from '../hooks/useRawTransformFeature'
import type {
  ExportResult,
  ExportShareCapability,
} from '../model/export-result'
import type { LUTContractSelectionState, SupportLevel } from '../model/session'
import type { DeliveredExportSize } from '../services/export/delivered-export-size'
import type {
  ToolAvailability,
  ToolSurface,
} from '../services/surface/derive-tool-availability'
import type {
  FullExportActionReason,
  HqExportActionReason,
  PreviewLookReason,
} from '../services/surface/raw-reason'
import type { ColorValue } from './color-fields'
import type { CpuPreviewNotice } from './CpuPreviewBanner'
import type { RawRuntimeReadinessState } from './raw-runtime-readiness'
import type { ToneValue } from './tone-fields'

/**
 * The loaded source's previous export was interrupted, so the next export the
 * user starts takes a safer plan. A read-only note: it names no source or
 * dimensions, and nothing about it starts an export or asks for a file.
 */
export type ExportInterruptionNote = { kind: 'interrupted' }

/** The one copy every export surface shows for a note. */
export const EXPORT_INTERRUPTION_NOTE_COPY = {
  interrupted: 'raw.export.interrupted',
} as const satisfies Record<ExportInterruptionNote['kind'], MessageKey>

/**
 * What the workflow hands a tool surface beside the store slices and the
 * tool commands: what each action can do, the export decisions with their
 * reasons, and the facts the surfaces show. Adjustments, the workflow stage
 * and its progress are read from the store (`useRawToolAdjustments`,
 * `useRawToolStatus`, `useRawToolProgress`), and every command from
 * `useRawToolCommands`.
 */
/** The LUT the session applies, as far as the surfaces need to know it. */
export interface AppliedLut {
  /** Style name; the strip falls back to it for a file's title. */
  name: string
  /** SHA-256 of the applied .cube bytes. */
  sha256?: string | null
  /** The file or URL name the LUT came from. */
  sourceName?: string | null
}

export interface RawWorkflowSurfaceState {
  transform?: RawTransformFeature
  /**
   * What each action can do right now on each surface, from the shared
   * action policy. A surface disables a control from its action here; the
   * commands it calls are the real ones and refuse on their own.
   */
  toolAvailability: Record<ToolSurface, ToolAvailability>
  viewMode: 'processed' | 'original' | 'compare'
  /**
   * The stage can render a RAW / final comparison. False in the CPU preview,
   * which has no split surface; a committed Transform is reported separately.
   */
  compareSupported: boolean
  /** The HQ preview export can start now, as the action policy decides. */
  canPreviewExport: boolean
  /** Why the HQ preview export is refused; unset while it can start. */
  previewExportDisabledReason?: HqExportActionReason
  /** The full-resolution export can start now, as the action policy decides. */
  canExport: boolean
  /** Why the full-resolution export is refused; unset while it can start. */
  disabledReason?: FullExportActionReason
  /**
   * Full-resolution export is blocked by the applied LUT's colour contract,
   * so choosing a contract is the way forward.
   */
  exportBlockedByLutContract: boolean
  /**
   * The frame a full-resolution export will write (Transform included);
   * null or unset while unknown.
   */
  deliveredExportSize: DeliveredExportSize | null
  isProcessing: boolean
  runtimeReadinessState?: RawRuntimeReadinessState
  previewSuspended: boolean
  exportResult: ExportResult | null
  exportShareCapability: ExportShareCapability
  /** Set while the loaded source's previous export was interrupted. */
  interruptionNote: ExportInterruptionNote | null
  hasImage: boolean
  fileName: string
  currentLutName: string | null
  /**
   * The applied LUT's identity (name, .cube SHA-256, source name), so a
   * surface can tell which catalog entry, if any, is the applied look.
   */
  appliedLut: AppliedLut | null
  lutProfileSelection?: LUTContractSelectionState | null
  lutProfileResolution?: LUTContractResolution | null
  /**
   * Why the processed preview does not draw the selected look (a contract
   * export refuses, or a built-in style on the CPU preview); null when it
   * draws the look as selected. The selection and strength stay unchanged.
   */
  previewLookReason: PreviewLookReason | null
  onlineLutSources?: UseOnlineLutSourcesResult
  supportLevel: SupportLevel
  metadata: ImageMetadata | null
  previewFrameEl?: HTMLDivElement | null
  /**
   * Width / height of what the stage is displaying: the Transform result
   * while its overlay is up, otherwise the decoded preview. Null while no
   * decoded preview is held (before decode, or released for export).
   */
  previewAspect: number | null
  /** Set while the CPU preview notice is showing; mobile renders it. */
  cpuPreviewNotice?: CpuPreviewNotice
}

/**
 * The tool commands, the same object for as long as their provider is
 * mounted. Each one decides when it is called, from what the provider last
 * rendered: an edit refuses while the preview is released, and each export
 * runs only where the action policy allows it. A surface reads availability
 * to disable a control, never to choose which command to hold.
 */
export interface RawToolCommands {
  /** Set how much of the look reaches the photo, 0..1. */
  onIntensityChange: (value: number) => void
  onToneChange: (value: Partial<ToneValue>) => void
  onToneReset: () => void
  onColorChange: (value: Partial<ColorValue>) => void
  onColorReset: () => void
  onSelectiveColorChange: (
    band: HSLBandId,
    shift: Partial<HSLBandShift>,
  ) => void
  onSelectiveColorReset: () => void
  /** Resolves once the load settles, applied or not. */
  onLutLoad: (files: File[]) => void | Promise<unknown>
  onLutClear: () => void
  onLutProfileSelect: (profile: LUTColorProfile) => void
  onViewModeChange: (mode: 'processed' | 'original' | 'compare') => void
  onCompareSplitChange: (split: number) => void
  onCompareReset: () => void
  /** Starts the full-resolution export; it takes no choices. */
  onExport: () => void
  onPreviewExport: () => void | Promise<void>
  onShareExport: () => void
  onDownloadExport: () => void
  onDownloadExportManifest: () => void
  onCopyExport: () => void
  onReplaceFile: () => void
  onResetSession: () => void
  onPrepareRuntime: () => void
}

/** What the surfaces show of the preview pipeline: its sizes and timing. */
export type RawPreviewStats = Pick<
  PipelineStats,
  'processTime' | 'inputSize' | 'previewSize'
>

export const RawWorkflowContext = createContext<RawWorkflowSurfaceState | null>(
  null,
)
export const RawToolCommandsContext = createContext<RawToolCommands | null>(
  null,
)
/**
 * The preview histogram and the preview stats move with every preview
 * render, so each travels apart from the workflow context: a new histogram
 * or timing renders what names it, not every surface reading the workflow.
 * Without a provider there is no photo, so nothing to measure.
 */
export const RawPreviewHistogramContext = createContext<PreviewHistogramState>({
  state: 'unavailable',
  reason: 'no-image',
})
export const RawPreviewStatsContext = createContext<RawPreviewStats | null>(
  null,
)

export function useRawToolCommands(): RawToolCommands {
  const commands = useContext(RawToolCommandsContext)
  if (!commands) {
    throw new Error('RawToolCommandsContext is missing')
  }
  return commands
}

export function useRawWorkflowContext(): RawWorkflowSurfaceState {
  const value = useContext(RawWorkflowContext)
  if (!value) {
    throw new Error('RawWorkflowContext is missing')
  }
  return value
}

export function useRawPreviewHistogram(): PreviewHistogramState {
  return useContext(RawPreviewHistogramContext)
}

/** Null before the first preview render. */
export function useRawPreviewStats(): RawPreviewStats | null {
  return useContext(RawPreviewStatsContext)
}

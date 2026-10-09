import type {
  HSLBandId,
  HSLBandShift,
  LUTColorProfile,
  LUTContractResolution,
  PreviewHistogramState,
} from '@lumaforge/luma-color-runtime'
import type { ComponentProps, ReactNode } from 'react'
import { createContext, useContext } from 'react'

import type { MessageKey } from '~/lib/i18n'

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
import type { AppliedLut } from './mobile/mobile-lut-strip'
import type { RawRuntimeReadinessState } from './raw-runtime-readiness'
import type { ToneValue } from './tone-fields'
import type { FileFactsTool } from './tools/FileFactsTool'
import type { HSLToolValue } from './tools/HSLTool'

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

export interface RawToolSurfaceProps {
  transform?: RawTransformFeature
  /**
   * What each action can do right now on each surface, from the shared
   * action policy. A surface disables a control from its action here; the
   * commands it calls are the real ones and refuse on their own.
   */
  toolAvailability: Record<ToolSurface, ToolAvailability>
  /** How much of the look reaches the photo, 0..1. */
  activeIntensity: number
  tone: ToneValue
  color: ColorValue
  selectiveColor: HSLToolValue | undefined
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
  onCompareReset: () => void
  viewMode: 'processed' | 'original' | 'compare'
  onViewModeChange: (mode: 'processed' | 'original' | 'compare') => void
  compareSplit: number
  onCompareSplitChange: (split: number) => void
  /**
   * The stage can render a RAW / final comparison. False in the CPU preview,
   * which has no split surface; a committed Transform is reported separately.
   */
  compareSupported?: boolean
  /** Resolves once the load settles, applied or not. */
  onLutLoad: (files: File[]) => void | Promise<unknown>
  onLutClear: () => void
  onLutProfileSelect: (profile: LUTColorProfile) => void
  /** Starts the full-resolution export; it takes no choices. */
  onExport: () => void
  /** The HQ preview export can start now, as the action policy decides. */
  canPreviewExport?: boolean
  /** Why the HQ preview export is refused; unset while it can start. */
  previewExportDisabledReason?: HqExportActionReason
  onPreviewExport?: () => void | Promise<void>
  /** The full-resolution export can start now, as the action policy decides. */
  canExport: boolean
  /** Why the full-resolution export is refused; unset while it can start. */
  disabledReason?: FullExportActionReason
  /**
   * Full-resolution export is blocked by the applied LUT's colour contract,
   * so choosing a contract is the way forward.
   */
  exportBlockedByLutContract?: boolean
  /**
   * The frame a full-resolution export will write (Transform included);
   * null or unset while unknown.
   */
  deliveredExportSize?: DeliveredExportSize | null
  isProcessing: boolean
  isExporting?: boolean
  /** Workflow progress, 0-100; the export action reads it while exporting. */
  progress?: number
  runtimeReadinessState?: RawRuntimeReadinessState
  onPrepareRuntime?: () => void
  previewSuspended?: boolean
  exportResult: ExportResult | null
  exportShareCapability: ExportShareCapability
  histogram: PreviewHistogramState
  /** Set while the loaded source's previous export was interrupted. */
  interruptionNote?: ExportInterruptionNote | null
  onShareExport: () => void
  onDownloadExport: () => void
  onDownloadExportManifest?: () => void
  onCopyExport: () => void
  hasImage: boolean
  fileName: string
  onReplaceFile: () => void
  onResetSession: () => void
  currentLutName?: string | null
  /**
   * The applied LUT's identity (name, .cube SHA-256, source name), so a
   * surface can tell which catalog entry, if any, is the applied look.
   */
  appliedLut?: AppliedLut | null
  lutProfileSelection?: LUTContractSelectionState | null
  lutProfileResolution?: LUTContractResolution | null
  /**
   * Why the processed preview does not draw the selected look (a contract
   * export refuses, or a built-in style on the CPU preview); null when it
   * draws the look as selected. The selection and strength stay unchanged.
   */
  previewLookReason?: PreviewLookReason | null
  onlineLutSources?: UseOnlineLutSourcesResult
  supportLevel: SupportLevel
  metadata: ComponentProps<typeof FileFactsTool>['metadata']
  stats: ComponentProps<typeof FileFactsTool>['stats']
  previewFrameEl?: HTMLDivElement | null
  /**
   * Width / height of what the stage is displaying: the Transform result
   * while its overlay is up, otherwise the decoded preview. Null while no
   * decoded preview is held (before decode, or released for export).
   */
  previewAspect?: number | null
  /** Set while the CPU preview notice is showing; mobile renders it. */
  cpuPreviewNotice?: CpuPreviewNotice
}

/** The commands a tool surface calls, by the props they are handed as. */
type RawToolCommandName =
  | 'onIntensityChange'
  | 'onToneChange'
  | 'onToneReset'
  | 'onColorChange'
  | 'onColorReset'
  | 'onSelectiveColorChange'
  | 'onSelectiveColorReset'
  | 'onLutLoad'
  | 'onLutClear'
  | 'onLutProfileSelect'
  | 'onViewModeChange'
  | 'onCompareSplitChange'
  | 'onCompareReset'
  | 'onExport'
  | 'onPreviewExport'
  | 'onShareExport'
  | 'onDownloadExport'
  | 'onDownloadExportManifest'
  | 'onCopyExport'
  | 'onReplaceFile'
  | 'onResetSession'
  | 'onPrepareRuntime'

/**
 * The tool commands, the same object for as long as their provider is
 * mounted. Each one decides when it is called, from what the provider last
 * rendered: an edit refuses while the preview is released, and each export
 * runs only where the action policy allows it. A surface reads availability
 * to disable a control, never to choose which command to hold.
 */
export type RawToolCommands = Required<
  Pick<RawToolSurfaceProps, RawToolCommandName>
>

const RawWorkflowContext = createContext<RawToolSurfaceProps | null>(null)
const RawToolCommandsContext = createContext<RawToolCommands | null>(null)

export function RawToolCommandsProvider({
  commands,
  children,
}: {
  commands: RawToolCommands
  children: ReactNode
}) {
  return (
    <RawToolCommandsContext.Provider value={commands}>
      {children}
    </RawToolCommandsContext.Provider>
  )
}

export function useRawToolCommands(): RawToolCommands {
  const commands = useContext(RawToolCommandsContext)
  if (!commands) {
    throw new Error('RawToolCommandsProvider is missing')
  }
  return commands
}

export function RawWorkflowProvider({
  value,
  children,
}: {
  value: RawToolSurfaceProps
  children: ReactNode
}) {
  return (
    <RawWorkflowContext.Provider value={value}>
      {children}
    </RawWorkflowContext.Provider>
  )
}

export function useRawWorkflowContext(
  override?: RawToolSurfaceProps,
): RawToolSurfaceProps {
  const value = useContext(RawWorkflowContext)

  if (override && Object.keys(override).length > 0) {
    return override
  }

  if (!value) {
    throw new Error('RawWorkflowProvider is missing')
  }

  return value
}

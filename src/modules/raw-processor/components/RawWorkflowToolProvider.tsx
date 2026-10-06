import type { ReactNode } from 'react'
import { useEffect, useMemo, useRef } from 'react'

import type { MessageKey } from '~/lib/i18n'
import { useI18n } from '~/lib/i18n'

import type { UseOnlineLutSourcesResult } from '../hooks/useOnlineLutSources'
import type {
  RawTransformFeature,
  TransformExportBlock,
} from '../hooks/useRawTransformFeature'
import type { UseRawWorkflowReturn } from '../hooks/useRawWorkflow.types'
import { deriveLutContractExportReason } from '../model/derive-session'
import type { LutLoadOutcome } from '../services/look/orchestrate-lut-load'
import { deriveToolAvailability } from '../services/surface/derive-tool-availability'
import { resolvePreviewLookReason } from '../services/surface/raw-reason'
import type { CpuPreviewNotice } from './CpuPreviewBanner'
import type { RawRuntimeReadinessState } from './raw-runtime-readiness'
import type {
  ExportInterruptionNote,
  RawToolSurfaceProps,
} from './RawWorkflowContext'
import { RawWorkflowProvider } from './RawWorkflowContext'

interface RawWorkflowToolProviderProps {
  transform?: RawTransformFeature
  workflow: UseRawWorkflowReturn
  onlineLutSources: UseOnlineLutSourcesResult
  isCpuMode: boolean
  cpuPreviewNotice?: CpuPreviewNotice
  isProcessing: boolean
  runtimeReadinessState: RawRuntimeReadinessState
  previewFrameEl: HTMLDivElement | null
  onReplaceFile: () => void
  onResetSession: () => void
  onCompareReset: () => void
  onLutDrop: (files: File[]) => void
  onExport: RawToolSurfaceProps['onExport']
  /** Unused: an interrupted export offers no file picker. */
  onRecoverExportSource?: () => void
  onPrepareRuntime: () => void
  children: ReactNode
}

/** The Transform tool's own wording for each reason it blocks export. */
const TRANSFORM_EXPORT_BLOCK_COPY: Record<TransformExportBlock, MessageKey> = {
  pending: 'raw.transform.preparing',
  invalid: 'transform.error.transform',
  unavailable: 'raw.transform.unavailable',
}

function getAspect(size: { width: number; height: number } | null | undefined) {
  return size && size.width > 0 && size.height > 0
    ? size.width / size.height
    : null
}

const INTERRUPTED_NOTE: ExportInterruptionNote = { kind: 'interrupted' }

/**
 * The note for the loaded source's interruption hint. It names no source,
 * dimensions or attempt, and it is not a recovery entry: only the explicit
 * Export starts an export.
 */
function toInterruptionNote(
  exportInterrupted: boolean | undefined,
): ExportInterruptionNote | null {
  return exportInterrupted ? INTERRUPTED_NOTE : null
}

/** `edit`, refused whenever `refused` reads true at the moment it is called. */
function unlessRefused<Args extends unknown[], Result>(
  refused: { readonly current: boolean },
  edit: (...args: Args) => Result,
) {
  return (...args: Args): Result | undefined =>
    refused.current ? undefined : edit(...args)
}

export function RawWorkflowToolProvider({
  transform,
  workflow,
  onlineLutSources,
  isCpuMode,
  cpuPreviewNotice,
  isProcessing,
  runtimeReadinessState,
  previewFrameEl,
  onReplaceFile,
  onResetSession,
  onCompareReset,
  onLutDrop,
  onExport,
  onPrepareRuntime,
  children,
}: RawWorkflowToolProviderProps) {
  const { t } = useI18n()
  const previewSuspended = workflow.previewSuspended === true
  // While export holds the preview released, an edit would discard the
  // delivered JPEG, so edits refuse until the preview is restored. The state
  // is read when an edit is called: a scrub, a deferred strength step or a
  // panel still leaving the screen is refused through the callbacks it holds
  // from an earlier render. Delivery, Export and Restore stay open.
  const editsRefusedRef = useRef(previewSuspended)
  editsRefusedRef.current = previewSuspended
  const {
    setIntensity,
    setToneParams,
    resetTone,
    setColorParams,
    resetColor,
    setSelectiveColorBand,
    resetSelectiveColor,
    clearLUT,
    selectLUTProfile,
  } = workflow
  const edits = useMemo(
    () => ({
      onIntensityChange: unlessRefused(editsRefusedRef, setIntensity),
      onToneChange: unlessRefused(editsRefusedRef, setToneParams),
      onToneReset: unlessRefused(editsRefusedRef, resetTone),
      onColorChange: unlessRefused(editsRefusedRef, setColorParams),
      onColorReset: unlessRefused(editsRefusedRef, resetColor),
      onSelectiveColorChange: unlessRefused(
        editsRefusedRef,
        setSelectiveColorBand,
      ),
      onSelectiveColorReset: unlessRefused(
        editsRefusedRef,
        resetSelectiveColor,
      ),
      onLutLoad: unlessRefused(editsRefusedRef, onLutDrop),
      onLutClear: unlessRefused(editsRefusedRef, clearLUT),
      onLutProfileSelect: unlessRefused(editsRefusedRef, selectLUTProfile),
    }),
    [
      clearLUT,
      onLutDrop,
      resetColor,
      resetSelectiveColor,
      resetTone,
      selectLUTProfile,
      setColorParams,
      setIntensity,
      setSelectiveColorBand,
      setToneParams,
    ],
  )
  const editableTransform = useMemo(
    () =>
      transform && {
        ...transform,
        setMode: unlessRefused(editsRefusedRef, transform.setMode),
        setManual: unlessRefused(editsRefusedRef, transform.setManual),
        setConstrainCrop: unlessRefused(
          editsRefusedRef,
          transform.setConstrainCrop,
        ),
        reset: unlessRefused(editsRefusedRef, transform.reset),
      },
    [transform],
  )
  // A catalog look applies on load, so a load is refused with the outcome
  // the one-load lock already uses, and one still downloading is cancelled.
  const editableOnlineLutSources = useMemo(
    () => ({
      ...onlineLutSources,
      loadEntry: (entryId: string) =>
        editsRefusedRef.current
          ? Promise.resolve<LutLoadOutcome>('aborted')
          : onlineLutSources.loadEntry(entryId),
    }),
    [onlineLutSources],
  )
  const { loadingEntryId, cancelEntryLoad } = onlineLutSources
  useEffect(() => {
    if (previewSuspended && loadingEntryId) cancelEntryLoad()
  }, [cancelEntryLoad, loadingEntryId, previewSuspended])
  const transformActive = transform?.active === true
  // Until the session holds the geometry the preview rendered, neither
  // export may run: full resolution would write another framing, and the HQ
  // preview never applies Transform. Every export surface reads these facts,
  // and the callbacks refuse too, so no surface can route around them.
  const transformExportBlock = transform?.exportBlock ?? null
  const lutContractExportReason = deriveLutContractExportReason(
    workflow.activeStyle,
  )
  // Transform names the block only where the workflow has nothing earlier to
  // say: an export that could otherwise run, or one held by the LUT contract.
  const transformExportReason =
    transformExportBlock &&
    (workflow.canExport ||
      workflow.exportDisabledReason === undefined ||
      workflow.exportDisabledReason === lutContractExportReason)
      ? t(TRANSFORM_EXPORT_BLOCK_COPY[transformExportBlock])
      : undefined
  const canExport = workflow.canExport && !transformExportBlock
  // What each surface may offer, from the one action policy. A refused
  // compare command is refused by the workflow itself when it runs, so the
  // surfaces receive the real commands and read their availability here.
  const {
    hasImage,
    status,
    currentLutName,
    canExport: workflowCanExport,
    exportDisabledReason,
    canPreviewExport: workflowCanPreviewExport,
    exportResult,
  } = workflow
  const toolAvailability = useMemo(() => {
    const facts = {
      hasImage,
      status,
      executor: isCpuMode ? ('cpu' as const) : ('webgpu' as const),
      previewSuspended,
      transformActive,
      transformExportBlock,
      hasAppliedLut: Boolean(currentLutName),
      canExport: workflowCanExport,
      lutContractBlocksExport:
        !workflowCanExport &&
        lutContractExportReason !== undefined &&
        exportDisabledReason === lutContractExportReason,
      canPreviewExport: workflowCanPreviewExport,
      hasExportResult: exportResult != null,
    }
    return {
      desktop: deriveToolAvailability({ ...facts, surface: 'desktop' }),
      mobile: deriveToolAvailability({ ...facts, surface: 'mobile' }),
    }
  }, [
    currentLutName,
    exportDisabledReason,
    exportResult,
    hasImage,
    isCpuMode,
    lutContractExportReason,
    previewSuspended,
    status,
    transformActive,
    transformExportBlock,
    workflowCanExport,
    workflowCanPreviewExport,
  ])
  const disabledReason = transformExportReason ?? workflow.exportDisabledReason
  const previewExportBlocked = transformActive || Boolean(transformExportBlock)
  const decodedPreviewSize = workflow.decodedImageRef.current
    ? {
        width: workflow.decodedImageRef.current.width,
        height: workflow.decodedImageRef.current.height,
      }
    : null
  const transformFrame = transform?.showOverlay
    ? transform.demo.result?.frame
    : undefined
  const previewAspect =
    getAspect(transformFrame) ?? getAspect(decodedPreviewSize)
  // What the processed preview draws for the selected look, from the policy
  // its executor follows. Without a photo there is no preview to describe.
  const { params, lutData } = workflow
  const previewLookReason = useMemo(
    () =>
      hasImage
        ? resolvePreviewLookReason({
            intent: params,
            lut: lutData,
            executor: isCpuMode ? 'cpu' : 'webgpu',
          })
        : null,
    [hasImage, isCpuMode, lutData, params],
  )
  const toolStats = workflow.stats
    ? {
        processTime: workflow.stats.processTime,
        inputSize: workflow.stats.inputSize,
        previewSize: decodedPreviewSize ?? workflow.stats.previewSize,
      }
    : null

  return (
    <RawWorkflowProvider
      value={{
        transform: editableTransform,
        activeIntensity: workflow.activeIntensity,
        tone: {
          userExposureEv: workflow.params.userExposureEv,
          userContrast: workflow.params.userContrast,
          userHighlights: workflow.params.userHighlights,
          userShadows: workflow.params.userShadows,
          userWhites: workflow.params.userWhites,
          userBlacks: workflow.params.userBlacks,
        },
        color: {
          userTemperature: workflow.params.userTemperature,
          userTint: workflow.params.userTint,
          userSaturation: workflow.params.userSaturation,
          userVibrance: workflow.params.userVibrance,
        },
        selectiveColor: workflow.params.selectiveColor,
        ...edits,
        fileName: workflow.sourceFileName,
        onReplaceFile,
        onResetSession,
        toolAvailability,
        onCompareReset,
        // What the stage shows: the CPU preview has no split surface but
        // can still show the original, and a committed Transform shows the
        // processed photo alone.
        viewMode: transformActive
          ? 'processed'
          : isCpuMode && workflow.viewMode === 'compare'
            ? 'processed'
            : workflow.viewMode,
        onViewModeChange: workflow.setViewMode,
        compareSplit: workflow.compareSplit,
        compareSupported: !isCpuMode,
        onCompareSplitChange: workflow.setCompareSplit,
        currentLutName: workflow.currentLutName,
        appliedLut:
          workflow.activeStyle?.kind === 'custom'
            ? {
                name: workflow.activeStyle.name,
                sha256: workflow.activeStyle.lutAsset?.sha256 ?? null,
                sourceName: workflow.activeStyle.lutAsset?.sourceName ?? null,
              }
            : null,
        lutProfileSelection: workflow.lutProfileSelection,
        lutProfileResolution:
          workflow.activeStyle?.kind === 'custom'
            ? workflow.activeStyle.lutAsset?.profileResolution
            : null,
        previewLookReason,
        onlineLutSources: editableOnlineLutSources,
        // Full resolution reproduces a committed geometry, so it stays
        // available once the preview has rendered it.
        onExport: transformExportBlock ? () => {} : onExport,
        onPreviewExport: previewExportBlocked
          ? () => {}
          : workflow.exportPreviewImage,
        canExport,
        disabledReason,
        // Only when the contract is the reason export states; an earlier
        // gate (the source still loading, or Transform) would make the
        // action a detour.
        exportBlockedByLutContract:
          !canExport &&
          lutContractExportReason !== undefined &&
          disabledReason === lutContractExportReason,
        deliveredExportSize: workflow.deliveredExportSize ?? null,
        canPreviewExport: !previewExportBlocked && workflow.canPreviewExport,
        previewExportDisabledReason: previewExportBlocked
          ? t('raw.transform.hqExportReason')
          : workflow.previewExportDisabledReason,
        isProcessing,
        isExporting: workflow.status === 'exporting',
        progress: workflow.progress,
        runtimeReadinessState,
        onPrepareRuntime,
        previewSuspended,
        exportResult: workflow.exportResult,
        exportShareCapability: workflow.exportShareCapability,
        interruptionNote: toInterruptionNote(workflow.exportInterrupted),
        onShareExport: workflow.shareExportResult,
        onDownloadExport: workflow.downloadExportResult,
        onDownloadExportManifest: workflow.downloadExportManifest,
        onCopyExport: workflow.copyExportResult,
        hasImage: workflow.hasImage,
        supportLevel: workflow.supportLevel,
        metadata: workflow.loadedImage.metadata,
        stats: toolStats,
        histogram: transformActive
          ? {
              state: 'unsupported',
              reason: t('raw.transform.histogramUnavailable'),
            }
          : isCpuMode
            ? {
                state: 'unsupported',
                reason: t('raw.preview.cpuDegraded.banner'),
              }
            : (workflow.histogram ?? {
                state: 'unavailable',
                reason: 'no-image',
              }),
        previewFrameEl: transformActive ? null : previewFrameEl,
        previewAspect,
        cpuPreviewNotice,
      }}
    >
      {children}
    </RawWorkflowProvider>
  )
}

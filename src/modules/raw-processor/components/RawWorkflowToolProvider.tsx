import type { ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useI18n } from '~/lib/i18n'

import type { UseOnlineLutSourcesResult } from '../hooks/useOnlineLutSources'
import type { RawTransformFeature } from '../hooks/useRawTransformFeature'
import type { UseRawWorkflowReturn } from '../hooks/useRawWorkflow.types'
import { deriveLutContractExportRefusal } from '../model/derive-session'
import type { LutLoadOutcome } from '../services/look/orchestrate-lut-load'
import type { ActionAvailability } from '../services/surface/derive-tool-availability'
import { deriveToolAvailability } from '../services/surface/derive-tool-availability'
import type { ExportActionReason } from '../services/surface/raw-reason'
import { resolvePreviewLookReason } from '../services/surface/raw-reason'
import type { CpuPreviewNotice } from './CpuPreviewBanner'
import type { RawRuntimeReadinessState } from './raw-runtime-readiness'
import type {
  ExportInterruptionNote,
  RawToolCommands,
} from './RawWorkflowContext'
import {
  RawToolCommandsProvider,
  RawWorkflowProvider,
} from './RawWorkflowContext'

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
  onExport: RawToolCommands['onExport']
  onPrepareRuntime: () => void
  children: ReactNode
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

/**
 * Why an export action the policy refuses is refused: the policy's own
 * reason when it names one, otherwise the workflow's.
 */
function exportActionReason<WorkflowReason>(
  action: ActionAvailability,
  workflowReason: WorkflowReason | undefined,
): ExportActionReason<WorkflowReason> | undefined {
  if (action.available) return undefined
  if (action.reason) return { source: 'surface', code: action.reason }
  return workflowReason === undefined
    ? undefined
    : { source: 'workflow', reason: workflowReason }
}

/** `edit`, refused whenever `refused` reads true at the moment it is called. */
function unlessRefused<Args extends unknown[], Result>(
  refused: { readonly current: boolean },
  edit: (...args: Args) => Result,
) {
  return (...args: Args): Result | undefined =>
    refused.current ? undefined : edit(...args)
}

/** What the tool commands call, as the provider last rendered it. */
interface ToolCommandTargets {
  workflow: UseRawWorkflowReturn
  onLutDrop: (files: File[]) => void
  onExport: () => void
  onCompareReset: () => void
  onReplaceFile: () => void
  onResetSession: () => void
  onPrepareRuntime: () => void
  /** The action policy's full-resolution and HQ preview export decisions. */
  fullExportAvailable: boolean
  hqExportAvailable: boolean
}

/**
 * Commands that keep their identity for the provider's lifetime. Each reads
 * its target when it is called, so a callback held from an earlier render
 * reaches the current workflow and the current decisions: edits refuse while
 * `editsRefused` reads true, and each export runs only where the action
 * policy allows it.
 */
function createToolCommands(
  latest: { readonly current: ToolCommandTargets },
  editsRefused: { readonly current: boolean },
): RawToolCommands {
  const edit = <Args extends unknown[], Result>(
    target: (targets: ToolCommandTargets) => (...args: Args) => Result,
  ) =>
    unlessRefused(editsRefused, (...args: Args) =>
      target(latest.current)(...args),
    )
  const forward =
    <Args extends unknown[], Result>(
      target: (targets: ToolCommandTargets) => (...args: Args) => Result,
    ) =>
    (...args: Args): Result =>
      target(latest.current)(...args)
  return {
    onIntensityChange: edit((to) => to.workflow.setIntensity),
    onToneChange: edit((to) => to.workflow.setToneParams),
    onToneReset: edit((to) => to.workflow.resetTone),
    onColorChange: edit((to) => to.workflow.setColorParams),
    onColorReset: edit((to) => to.workflow.resetColor),
    onSelectiveColorChange: edit((to) => to.workflow.setSelectiveColorBand),
    onSelectiveColorReset: edit((to) => to.workflow.resetSelectiveColor),
    onLutLoad: edit((to) => to.onLutDrop),
    onLutClear: edit((to) => to.workflow.clearLUT),
    onLutProfileSelect: edit((to) => to.workflow.selectLUTProfile),
    onViewModeChange: forward((to) => to.workflow.setViewMode),
    onCompareSplitChange: forward((to) => to.workflow.setCompareSplit),
    onCompareReset: forward((to) => to.onCompareReset),
    onExport: () => {
      const targets = latest.current
      if (targets.fullExportAvailable) targets.onExport()
    },
    onPreviewExport: () => {
      const targets = latest.current
      return targets.hqExportAvailable
        ? targets.workflow.exportPreviewImage()
        : undefined
    },
    onShareExport: forward((to) => to.workflow.shareExportResult),
    onDownloadExport: forward((to) => to.workflow.downloadExportResult),
    onDownloadExportManifest: forward(
      (to) => to.workflow.downloadExportManifest,
    ),
    onCopyExport: forward((to) => to.workflow.copyExportResult),
    onReplaceFile: forward((to) => to.onReplaceFile),
    onResetSession: forward((to) => to.onResetSession),
    onPrepareRuntime: forward((to) => to.onPrepareRuntime),
  }
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
  // Filled in below, once the action policy has decided this render; the
  // commands read it only when they are called.
  const commandTargetsRef = useRef<ToolCommandTargets>(null!)
  const [commands] = useState(() =>
    createToolCommands(commandTargetsRef, editsRefusedRef),
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
  // preview never applies Transform. The action policy decides both exports
  // from this fact, every export surface reads its decision, and the
  // callbacks refuse too, so no surface can route around it.
  const transformExportBlock = transform?.exportBlock ?? null
  // What each surface may offer, from the one action policy. A refused
  // compare command is refused by the workflow itself when it runs, so the
  // surfaces receive the real commands and read their availability here.
  const {
    hasImage,
    status,
    currentLutName,
    canExport: workflowCanExport,
    exportRefusal,
    canPreviewExport: workflowCanPreviewExport,
    previewExportRefusal,
    exportResult,
  } = workflow
  // The workflow's refusal is the applied LUT's colour contract, and only
  // that: choosing a contract is then the way forward.
  const lutContractRefusal = deriveLutContractExportRefusal(
    workflow.activeStyle,
  )
  const lutContractBlocksExport =
    !workflowCanExport &&
    lutContractRefusal !== undefined &&
    exportRefusal?.code === lutContractRefusal.code
  // What the Transform preview observes of its frame. Its capture schedule
  // stays with the preview; the tool's commands read only these facts.
  const hasTransform = transform !== undefined
  const transformCanCapture = transform?.available === true
  const transformWorkerReady = transform?.demo.ready === true
  const transformCaptureFailed = transform?.captureError === true
  const transformCurrent = transform?.current === true
  const transformPreview = useMemo(
    () =>
      hasTransform
        ? {
            canCapture: transformCanCapture,
            workerReady: transformWorkerReady,
            captureFailed: transformCaptureFailed,
            current: transformCurrent,
          }
        : null,
    [
      hasTransform,
      transformCanCapture,
      transformCaptureFailed,
      transformCurrent,
      transformWorkerReady,
    ],
  )
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
      lutContractBlocksExport,
      canPreviewExport: workflowCanPreviewExport,
      hasExportResult: exportResult != null,
      transformPreview,
    }
    return {
      desktop: deriveToolAvailability({ ...facts, surface: 'desktop' }),
      mobile: deriveToolAvailability({ ...facts, surface: 'mobile' }),
    }
  }, [
    currentLutName,
    exportResult,
    hasImage,
    isCpuMode,
    lutContractBlocksExport,
    previewSuspended,
    status,
    transformActive,
    transformExportBlock,
    transformPreview,
    workflowCanExport,
    workflowCanPreviewExport,
  ])
  // Both surfaces refuse full and HQ export alike once they reach their
  // export controls, and desktop always reaches them, so its decisions are
  // the ones every export panel states. Transform names a block only where
  // the workflow has nothing earlier to say.
  const { fullExport, hqExport } = toolAvailability.desktop
  commandTargetsRef.current = {
    workflow,
    onLutDrop,
    onExport,
    onCompareReset,
    onReplaceFile,
    onResetSession,
    onPrepareRuntime,
    fullExportAvailable: fullExport.available,
    hqExportAvailable: hqExport.available,
  }
  const disabledReason = exportActionReason(fullExport, exportRefusal)
  const previewExportDisabledReason = exportActionReason(
    hqExport,
    previewExportRefusal,
  )
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
        fileName: workflow.sourceFileName,
        toolAvailability,
        // What the stage shows: the CPU preview has no split surface but
        // can still show the original, and a committed Transform shows the
        // processed photo alone.
        viewMode: transformActive
          ? 'processed'
          : isCpuMode && workflow.viewMode === 'compare'
            ? 'processed'
            : workflow.viewMode,
        compareSplit: workflow.compareSplit,
        compareSupported: !isCpuMode,
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
        canExport: fullExport.available,
        disabledReason,
        // Only when the contract is the reason export states; an earlier
        // gate (the source still loading, or Transform) would make the
        // action a detour.
        exportBlockedByLutContract:
          lutContractBlocksExport && disabledReason?.source === 'workflow',
        deliveredExportSize: workflow.deliveredExportSize ?? null,
        canPreviewExport: hqExport.available,
        previewExportDisabledReason,
        isProcessing,
        runtimeReadinessState,
        previewSuspended,
        exportResult: workflow.exportResult,
        exportShareCapability: workflow.exportShareCapability,
        interruptionNote: toInterruptionNote(workflow.exportInterrupted),
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
      <RawToolCommandsProvider commands={commands}>
        {children}
      </RawToolCommandsProvider>
    </RawWorkflowProvider>
  )
}

import type {
  ColorGraphIntent,
  LUTData,
  RawRenderExposure,
} from '@lumaforge/luma-color-runtime'
import type { MutableRefObject } from 'react'
import { useMemo } from 'react'

import type { DecodedImage } from '~/lib/raw/decoder'
import type { PipelineStats } from '~/lib/webgpu/raw-processing-pipeline'

import type {
  ExportShareCapability,
  FullResExportReason,
  HqPreviewExportReasonCode,
} from '../../../model/export-result'
import type { DisplaySource, ImageSession } from '../../../model/session'
import type { ProcessingStatus } from '../../../model/workflow'
import { resolveDeliveredExportSize } from '../../../services/export/delivered-export-size'
import { deriveFullResExportReadiness } from '../../../services/export/export-readiness'
import type { SourceInterruptionHint } from '../../../services/export/export-recovery'
import { isInterruptedSource } from '../../../services/export/export-recovery'
import {
  resolveExportShareButtonCapability,
  unavailableExportShare,
} from '../../../services/export/export-result-actions'
import { resolveHqPreviewLookRefusal } from '../../../services/export/hq-preview-look'

type UseExportDerivedStateInput = {
  session: ImageSession | null
  exportInterruption: SourceInterruptionHint | null
  decodedImageRef: MutableRefObject<DecodedImage | null>
  embeddedPreviewUrl: string | null
  status: ProcessingStatus
  hasImage: boolean
  displaySource: DisplaySource
  sourceFile: File | null
  rawRenderExposure: RawRenderExposure | null
  /** The selected look and user color the preview pipeline holds. */
  params: ColorGraphIntent
  /** The selected custom LUT's data the preview pipeline holds. */
  lutData: LUTData | null
  stats: PipelineStats | null
}

export function useExportDerivedState({
  session,
  exportInterruption,
  decodedImageRef,
  embeddedPreviewUrl,
  status,
  hasImage,
  displaySource,
  sourceFile,
  rawRenderExposure,
  params,
  lutData,
  stats,
}: UseExportDerivedStateInput) {
  // The HQ JPEG is the WebGPU preview's render, so it refuses while that
  // preview leaves out the selected look its name would claim. Only that
  // answer reaches the state below, so a scrub that keeps it rebuilds none
  // of the export decisions.
  const hqPreviewLookRefusal = useMemo(
    () => resolveHqPreviewLookRefusal({ intent: params, lut: lutData }),
    [lutData, params],
  )
  return useMemo(() => {
    const fullResExportReadiness = deriveFullResExportReadiness({
      sourceFile,
      session,
      rawRenderExposure,
    })
    const canExport = fullResExportReadiness.canExport
    const exportRefusal: FullResExportReason | undefined =
      fullResExportReadiness.canExport
        ? undefined
        : fullResExportReadiness.refusal
    const exportResult = session?.exportState.result ?? null
    const exportShareCapability: ExportShareCapability = exportResult
      ? resolveExportShareButtonCapability()
      : unavailableExportShare('no-result')
    // Read-only, and only for the loaded source the hint was read for.
    const exportInterrupted = isInterruptedSource(
      exportInterruption,
      sourceFile,
    )
    const exportState = session?.exportState
    const activeExportPlan =
      exportState?.status === 'exporting' ||
      (exportState?.status === 'ready' && exportState.result)
        ? exportState.activePlan
        : undefined
    const exportPlanSuspendsPreview = Boolean(activeExportPlan)
    const previewEvacuatedForReadyExport =
      exportState?.status === 'ready' &&
      Boolean(exportState.result) &&
      !decodedImageRef.current &&
      !embeddedPreviewUrl
    const previewSuspended =
      exportPlanSuspendsPreview &&
      (status === 'exporting' || previewEvacuatedForReadyExport)
    const hqPreviewImage = decodedImageRef.current
    const canPreviewExport =
      !session?.exportGeometry &&
      status === 'ready' &&
      !previewSuspended &&
      !hqPreviewLookRefusal &&
      displaySource === 'bounded-hq' &&
      hqPreviewImage?.source === 'bounded-hq' &&
      Boolean(stats?.inputSize)
    const previewExportRefusal: HqPreviewExportReasonCode | undefined =
      session?.exportGeometry
        ? 'transform-held'
        : !hasImage
          ? 'no-source'
          : previewSuspended
            ? 'preview-released'
            : hqPreviewLookRefusal
              ? 'look-dropped'
              : displaySource !== 'bounded-hq' ||
                  hqPreviewImage?.source !== 'bounded-hq'
                ? 'hq-preview-pending'
                : !stats?.inputSize
                  ? 'not-ready'
                  : undefined

    const deliveredExportSize = resolveDeliveredExportSize({
      fullResCapability: session?.exportState.fullResCapability,
      exportGeometry: session?.exportGeometry,
    })

    return {
      canExport,
      exportRefusal,
      deliveredExportSize,
      exportResult,
      exportShareCapability,
      exportInterrupted,
      previewSuspended,
      canPreviewExport,
      previewExportRefusal,
    }
  }, [
    decodedImageRef,
    displaySource,
    exportInterruption,
    embeddedPreviewUrl,
    hasImage,
    hqPreviewLookRefusal,
    rawRenderExposure,
    session,
    sourceFile,
    stats,
    status,
  ])
}

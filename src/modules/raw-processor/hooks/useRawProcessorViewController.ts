import { useCallback, useEffect, useState } from 'react'

import type { PipelineStats, RawProcessingPipeline } from '~/lib/gl/pipeline'
import { useI18n } from '~/lib/i18n'

import { RAW_FILE_ACCEPT } from '../components/Dropzone'
import { useRawRuntimeReadiness } from './stages/ingest/useRawRuntimeReadiness'
import { useCapabilityGate } from './useCapabilityGate'
import { useHiddenFilePicker } from './useHiddenFilePicker'
import { useOnlineLutSources } from './useOnlineLutSources'
import type { UseRawWorkflowReturn } from './useRawWorkflow.types'

type RawRouteLocation = {
  search: string
  pathname: string
}

interface UseRawProcessorViewControllerInput {
  rawRouteLocation: RawRouteLocation
  workflow: UseRawWorkflowReturn
}

export function useRawProcessorViewController({
  rawRouteLocation,
  workflow,
}: UseRawProcessorViewControllerInput) {
  const { t } = useI18n()
  const {
    status,
    hasImage,
    loadFile,
    loadLUT,
    loadOnlineLUT,
    setViewMode,
    setCompareSplit,
    exportImage,
    recoverInterruptedExport,
    reset,
    updateStats,
    pipelineRef,
  } = workflow
  const onlineLutSources = useOnlineLutSources({
    search: rawRouteLocation.search,
    pathname: rawRouteLocation.pathname,
    loadOnlineLUT,
  })
  const { runtimeReadinessState, triggerRawRuntimePrewarm } =
    useRawRuntimeReadiness()
  const [resetConfirmationOpen, setResetConfirmationOpen] = useState(false)
  const [cpuPreviewBannerDismissed, setCpuPreviewBannerDismissed] =
    useState(false)
  const [previewFrameEl, setPreviewFrameEl] = useState<HTMLDivElement | null>(
    null,
  )

  const handleFileDrop = useCallback(
    (files: File[]) => {
      if (files.length > 0) {
        loadFile(files[0])
      }
    },
    [loadFile],
  )

  const handleLutDrop = useCallback(
    (files: File[]) => {
      if (files.length > 0) {
        loadLUT(files[0])
      }
    },
    [loadLUT],
  )

  const handleExport = useCallback(
    (options: {
      quality: 'standard' | 'high'
      fidelity: 'safe' | 'balanced' | 'max'
    }) => {
      exportImage(options)
    },
    [exportImage],
  )

  const replacePicker = useHiddenFilePicker({
    accept: RAW_FILE_ACCEPT.join(','),
    onFile: (file) => {
      void loadFile(file)
    },
  })

  const recoveryPicker = useHiddenFilePicker({
    accept: RAW_FILE_ACCEPT.join(','),
    onFile: (file) => {
      void recoverInterruptedExport(file)
    },
  })

  const handleReplaceFile = useCallback(() => {
    replacePicker.open()
  }, [replacePicker])

  const handleRecoveryFileSelect = useCallback(() => {
    recoveryPicker.open()
  }, [recoveryPicker])

  const handleStatsUpdate = useCallback(
    (newStats: PipelineStats) => {
      updateStats(newStats)
    },
    [updateStats],
  )

  const handlePipelineChange = useCallback(
    (pipeline: RawProcessingPipeline | null) => {
      pipelineRef.current = pipeline
    },
    [pipelineRef],
  )

  const handleCompareReset = useCallback(() => {
    setViewMode('compare')
    setCompareSplit(0.5)
  }, [setCompareSplit, setViewMode])

  const requestSessionReset = useCallback(() => {
    setResetConfirmationOpen(true)
  }, [])

  const confirmSessionReset = useCallback(() => {
    setResetConfirmationOpen(false)
    reset()
  }, [reset])

  useEffect(() => {
    if (!hasImage) setResetConfirmationOpen(false)
  }, [hasImage])

  const isProcessing =
    status === 'warming' ||
    status === 'loading' ||
    status === 'decoding' ||
    status === 'processing' ||
    status === 'exporting'
  const capability = useCapabilityGate()
  const isCpuMode = capability.ready && capability.previewMode === 'cpu'
  const unsupportedReason =
    capability.ready && capability.supportStatus === 'unsupported'
      ? t('raw.unsupported.coi')
      : t('raw.unsupported.gpu')
  const cpuPreviewReason =
    capability.supportStatus === 'degraded'
      ? capability.reason
      : 'webgpu-unavailable'

  return {
    workflow,
    onlineLutSources,
    runtimeReadinessState,
    triggerRawRuntimePrewarm,
    resetConfirmationOpen,
    setResetConfirmationOpen,
    cpuPreviewBannerDismissed,
    setCpuPreviewBannerDismissed,
    previewFrameEl,
    setPreviewFrameEl,
    handleFileDrop,
    handleLutDrop,
    handleExport,
    handleReplaceFile,
    handleRecoveryFileSelect,
    handleStatsUpdate,
    handlePipelineChange,
    handleCompareReset,
    requestSessionReset,
    confirmSessionReset,
    replacePicker,
    recoveryPicker,
    isProcessing,
    capability,
    isCpuMode,
    unsupportedReason,
    cpuPreviewReason,
  }
}

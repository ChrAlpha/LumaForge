import { useI18n } from '~/lib/i18n'

import { useRawWorkflowContext } from '../RawWorkflowContext'
import { MobileExportPanel } from './MobileExportPanel'
import { MobileLabChrome } from './MobileLabChrome'

export function MobileRawToolSurface() {
  const props = useRawWorkflowContext()
  const { t } = useI18n()
  const previewSuspended = props.previewSuspended === true
  const lutDropDisabled = props.isExporting === true || previewSuspended
  const mobileEditorDisabled =
    !props.hasImage || props.isProcessing || previewSuspended
  const hasAppliedLut = Boolean(props.currentLutName)
  const mobileStrengthDisabled = mobileEditorDisabled || !hasAppliedLut
  const cameraName =
    props.metadata &&
    `${props.metadata.make ?? ''} ${props.metadata.model ?? ''}`.trim()
  const fileMeta = [
    cameraName || undefined,
    props.supportLevel === 'official'
      ? t('raw.mobile.more.officialSupport')
      : undefined,
  ]
    .filter(Boolean)
    .join(' · ')
  const renderTime = props.stats
    ? `${Math.round(props.stats.processTime)} ms`
    : '—'
  const lutResolved =
    props.lutProfileResolution?.kind === 'confirmed'
      ? props.lutProfileResolution.profile.role
      : props.lutProfileResolution
        ? t('raw.histogram.notLoaded')
        : '—'

  return (
    <MobileLabChrome
      hasImage={props.hasImage}
      tone={props.tone}
      color={props.color}
      selectiveColor={props.selectiveColor}
      onToneChange={props.onToneChange}
      onToneReset={props.onToneReset}
      onColorChange={props.onColorChange}
      onColorReset={props.onColorReset}
      onSelectiveColorChange={props.onSelectiveColorChange}
      onSelectiveColorReset={props.onSelectiveColorReset}
      viewMode={props.viewMode}
      onViewModeChange={props.onViewModeChange}
      histogram={props.histogram}
      fileName={props.fileName}
      fileMeta={fileMeta || props.fileName}
      supportLevel={props.supportLevel}
      onReplaceFile={props.onReplaceFile}
      onResetSession={props.onResetSession}
      isProcessing={props.isProcessing}
      runtimeReadinessState={props.runtimeReadinessState}
      onPrepareRuntime={props.onPrepareRuntime}
      lutBrowser={{
        currentLutName: props.currentLutName,
        disabled: props.isProcessing || lutDropDisabled,
        onLutLoad: props.onLutLoad,
        onLutClear: props.onLutClear,
        lutProfileSelection: props.lutProfileSelection,
        lutProfileResolution: props.lutProfileResolution,
        onLutProfileSelect: props.onLutProfileSelect,
        onlineLutSources: props.onlineLutSources,
        activeIntensity: props.activeIntensity,
        onIntensitySelect: props.onIntensitySelect,
        strengthDisabled: mobileStrengthDisabled,
      }}
      onCompareReset={props.onCompareReset}
      exportPanel={
        <MobileExportPanel
          canExport={props.canExport}
          disabledReason={props.disabledReason}
          canPreviewExport={props.canPreviewExport}
          previewExportDisabledReason={props.previewExportDisabledReason}
          isProcessing={props.isProcessing}
          onExport={props.onExport}
          onPreviewExport={props.onPreviewExport}
          exportResult={props.exportResult}
          exportShareCapability={props.exportShareCapability}
          recovery={props.recovery}
          onShareExport={props.onShareExport}
          onDownloadExport={props.onDownloadExport}
          onDownloadExportManifest={props.onDownloadExportManifest}
          onCopyExport={props.onCopyExport}
          onRecoverExportSource={props.onRecoverExportSource}
        />
      }
      moreSheet={{
        pipelineSteps: [
          { index: 1, label: 'RAW decode', timing: '—' },
          { index: 2, label: t('raw.adjust.title'), timing: '—' },
          {
            index: 3,
            label: props.currentLutName ?? t('raw.mobile.more.lutHeading'),
            timing: '—',
          },
          { index: 4, label: 'JPEG output', timing: renderTime },
        ],
        lutRows: [
          {
            label: t('raw.mobile.more.lutHeading'),
            value: props.currentLutName ?? '—',
          },
          { label: t('raw.fileFacts.support'), value: lutResolved },
        ],
        fileRows: [
          { label: t('raw.fileFacts.camera'), value: cameraName || '—' },
          {
            label: t('raw.fileFacts.size'),
            value: props.metadata
              ? `${props.metadata.width} x ${props.metadata.height}`
              : '—',
          },
          {
            label: t('raw.fileFacts.preview'),
            value: props.stats
              ? `${props.stats.previewSize.width} x ${props.stats.previewSize.height}`
              : '—',
          },
          { label: t('raw.fileFacts.render'), value: renderTime },
        ],
      }}
      previewSuspended={previewSuspended}
      preferExportMode={previewSuspended && props.exportResult != null}
      previewFrameEl={props.previewFrameEl ?? null}
    />
  )
}

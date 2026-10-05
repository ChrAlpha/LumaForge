import { useI18n } from '~/lib/i18n'

import { useRawWorkflowContext } from '../RawWorkflowContext'
import { buildMobileExportRecap } from './export-recap'
import { buildMobileDetailsSheet, getCameraName } from './mobile-details-sheet'
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
  const cameraName = getCameraName(props.metadata)
  // Support level is a safety fact, so it is named on both surfaces rather
  // than encoded in the topbar dot alone (PRODUCT.md: never state by colour).
  // The level leads because the camera name truncates first on a phone.
  const fileMeta = [
    props.supportLevel === 'official'
      ? t('raw.support.official')
      : t('raw.support.experimental'),
    cameraName || undefined,
  ]
    .filter(Boolean)
    .join(' · ')
  const moreSheet = buildMobileDetailsSheet(
    {
      supportLevel: props.supportLevel,
      metadata: props.metadata,
      stats: props.stats,
      tone: props.tone,
      color: props.color,
      selectiveColor: props.selectiveColor,
      currentLutName: props.currentLutName,
      lutProfileSelection: props.lutProfileSelection,
      lutProfileResolution: props.lutProfileResolution,
      transformActive: props.transform?.active === true,
    },
    t,
  )

  const exportRecap = buildMobileExportRecap({
    deliveredSize: props.deliveredExportSize,
    lutName: props.currentLutName,
    strength: props.activeIntensity,
    tone: props.tone,
    color: props.color,
    selectiveColor: props.selectiveColor,
    transformApplied: props.transform?.active === true,
  })

  return (
    <MobileLabChrome
      transform={props.transform}
      canExport={props.canExport}
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
      compareSupported={props.compareSupported !== false}
      histogram={props.histogram}
      fileName={props.fileName}
      fileMeta={fileMeta || props.fileName}
      supportLevel={props.supportLevel}
      onReplaceFile={props.onReplaceFile}
      onResetSession={props.onResetSession}
      isProcessing={props.isProcessing}
      isExporting={props.isExporting === true}
      exportProgress={props.progress}
      hasExportResult={props.exportResult != null}
      runtimeReadinessState={props.runtimeReadinessState}
      onPrepareRuntime={props.onPrepareRuntime}
      cpuPreviewNotice={props.cpuPreviewNotice}
      lutBrowser={{
        currentLutName: props.currentLutName,
        appliedLut: props.appliedLut,
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
      exportPanel={({ onClose, onChooseLutContract }) => (
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
          isExporting={props.isExporting === true}
          progress={props.progress}
          onClose={onClose}
          onChooseLutContract={
            props.exportBlockedByLutContract ? onChooseLutContract : undefined
          }
          recap={exportRecap}
        />
      )}
      moreSheet={moreSheet}
      previewSuspended={previewSuspended}
      preferExportMode={previewSuspended && props.exportResult != null}
      previewFrameEl={props.previewFrameEl ?? null}
      photoAspect={props.previewAspect ?? null}
    />
  )
}

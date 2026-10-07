import { useI18n } from '~/lib/i18n'

import { supportLevelMessageKey } from '../../services/surface/raw-reason'
import { useRawWorkflowContext } from '../RawWorkflowContext'
import { buildMobileExportRecap } from './export-recap'
import { buildMobileDetailsSheet, getCameraName } from './mobile-details-sheet'
import { resolveAppliedLookTitle } from './mobile-lut-strip'
import { MobileExportPanel } from './MobileExportPanel'
import { MobileLabChrome } from './MobileLabChrome'

export function MobileRawToolSurface() {
  const props = useRawWorkflowContext()
  const { t } = useI18n()
  const previewSuspended = props.previewSuspended === true
  // The dock, the deck, the lens and the topbar Export read the shared
  // action policy for this surface, which waits for any busy stage.
  const availability = props.toolAvailability.mobile
  const cameraName = getCameraName(props.metadata)
  // Support level is a safety fact, so it is named on both surfaces rather
  // than encoded in the topbar dot alone (PRODUCT.md: never state by colour).
  // The level leads because the camera name truncates first on a phone.
  const fileMeta = [t(supportLevelMessageKey(props.supportLevel)), cameraName]
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
      previewLookReason: props.previewLookReason,
      transformActive: props.transform?.active === true,
      canExport: props.canExport,
      canPreviewExport: props.canPreviewExport === true,
    },
    t,
  )

  // The recap names a catalog look the way its tile does.
  const lookTitle = resolveAppliedLookTitle({
    entries: props.onlineLutSources?.state.entries ?? [],
    applied: props.currentLutName
      ? (props.appliedLut ?? { name: props.currentLutName })
      : null,
    loaded: props.onlineLutSources?.loadedEntry,
  })
  const exportRecap = buildMobileExportRecap({
    canExport: props.canExport,
    canPreviewExport: props.canPreviewExport === true,
    deliveredSize: props.deliveredExportSize,
    lutName: lookTitle,
    intensity: props.activeIntensity,
    tone: props.tone,
    color: props.color,
    selectiveColor: props.selectiveColor,
    transformApplied: props.transform?.active === true,
    previewLookReason: props.previewLookReason,
  })

  return (
    <MobileLabChrome
      transform={props.transform}
      availability={availability}
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
      exportResultKind={
        props.exportResult
          ? (props.exportResult.kind ?? 'full-resolution')
          : null
      }
      runtimeReadinessState={props.runtimeReadinessState}
      onPrepareRuntime={props.onPrepareRuntime}
      cpuPreviewNotice={props.cpuPreviewNotice}
      lutBrowser={{
        currentLutName: props.currentLutName,
        appliedLut: props.appliedLut,
        disabled: !availability.lutApplication.available,
        onLutLoad: props.onLutLoad,
        onLutClear: props.onLutClear,
        lutProfileSelection: props.lutProfileSelection,
        lutProfileResolution: props.lutProfileResolution,
        previewLookReason: props.previewLookReason,
        onLutProfileSelect: props.onLutProfileSelect,
        onlineLutSources: props.onlineLutSources,
        activeIntensity: props.activeIntensity,
        onIntensityChange: props.onIntensityChange,
        strengthDisabled: !availability.strength.available,
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
          interruptionNote={props.interruptionNote}
          onShareExport={props.onShareExport}
          onDownloadExport={props.onDownloadExport}
          onDownloadExportManifest={props.onDownloadExportManifest}
          onCopyExport={props.onCopyExport}
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

import { useI18n } from '~/lib/i18n'

import {
  useRawToolAdjustments,
  useRawToolProgress,
  useRawToolStatus,
} from '../../hooks/useRawToolState'
import { supportLevelMessageKey } from '../../services/surface/raw-reason'
import {
  useRawToolCommands,
  useRawWorkflowContext,
} from '../RawWorkflowContext'
import { buildMobileExportRecap } from './export-recap'
import { buildMobileDetailsSheet, getCameraName } from './mobile-details-sheet'
import { resolveAppliedLookTitle } from './mobile-lut-strip'
import { MobileExportPanel } from './MobileExportPanel'
import { MobileLabChrome } from './MobileLabChrome'

export function MobileRawToolSurface() {
  const props = useRawWorkflowContext()
  const commands = useRawToolCommands()
  const adjustments = useRawToolAdjustments()
  const { isExporting } = useRawToolStatus()
  const progress = useRawToolProgress()
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
      tone: adjustments.tone,
      color: adjustments.color,
      selectiveColor: adjustments.selectiveColor,
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
    intensity: adjustments.activeIntensity,
    tone: adjustments.tone,
    color: adjustments.color,
    selectiveColor: adjustments.selectiveColor,
    transformApplied: props.transform?.active === true,
    previewLookReason: props.previewLookReason,
  })

  return (
    <MobileLabChrome
      transform={props.transform}
      availability={availability}
      canExport={props.canExport}
      hasImage={props.hasImage}
      tone={adjustments.tone}
      color={adjustments.color}
      selectiveColor={adjustments.selectiveColor}
      onToneChange={commands.onToneChange}
      onToneReset={commands.onToneReset}
      onColorChange={commands.onColorChange}
      onColorReset={commands.onColorReset}
      onSelectiveColorChange={commands.onSelectiveColorChange}
      onSelectiveColorReset={commands.onSelectiveColorReset}
      viewMode={props.viewMode}
      onViewModeChange={commands.onViewModeChange}
      compareSupported={props.compareSupported !== false}
      fileName={props.fileName}
      fileMeta={fileMeta || props.fileName}
      supportLevel={props.supportLevel}
      onReplaceFile={commands.onReplaceFile}
      onResetSession={commands.onResetSession}
      isProcessing={props.isProcessing}
      isExporting={isExporting}
      exportProgress={progress}
      exportResultKind={props.exportResult?.kind ?? null}
      runtimeReadinessState={props.runtimeReadinessState}
      onPrepareRuntime={commands.onPrepareRuntime}
      cpuPreviewNotice={props.cpuPreviewNotice}
      lutBrowser={{
        currentLutName: props.currentLutName,
        appliedLut: props.appliedLut,
        disabled: !availability.lutApplication.available,
        onLutLoad: commands.onLutLoad,
        onLutClear: commands.onLutClear,
        lutProfileSelection: props.lutProfileSelection,
        lutProfileResolution: props.lutProfileResolution,
        previewLookReason: props.previewLookReason,
        onLutProfileSelect: commands.onLutProfileSelect,
        onlineLutSources: props.onlineLutSources,
        activeIntensity: adjustments.activeIntensity,
        onIntensityChange: commands.onIntensityChange,
        strengthDisabled: !availability.strength.available,
      }}
      exportPanel={({ onClose, onChooseLutContract }) => (
        <MobileExportPanel
          canExport={props.canExport}
          disabledReason={props.disabledReason}
          canPreviewExport={props.canPreviewExport}
          previewExportDisabledReason={props.previewExportDisabledReason}
          isProcessing={props.isProcessing}
          onExport={commands.onExport}
          onPreviewExport={commands.onPreviewExport}
          exportResult={props.exportResult}
          exportShareCapability={props.exportShareCapability}
          interruptionNote={props.interruptionNote}
          onShareExport={commands.onShareExport}
          onDownloadExport={commands.onDownloadExport}
          onDownloadExportManifest={commands.onDownloadExportManifest}
          onCopyExport={commands.onCopyExport}
          isExporting={isExporting}
          progress={progress}
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

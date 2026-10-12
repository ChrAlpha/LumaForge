import { useI18n } from '~/lib/i18n'

import {
  useRawToolAdjustments,
  useRawToolAdjustmentsSummary,
  useRawToolProgress,
  useRawToolStatus,
} from '../../hooks/useRawToolState'
import { supportLevelMessageKey } from '../../services/surface/raw-reason'
import {
  useRawPreviewStats,
  useRawToolCommands,
  useRawWorkflowContext,
} from '../RawWorkflowContext'
import { countAdjustments } from './adjustment-count'
import { buildMobileExportRecap } from './export-recap'
import { buildMobileDetailsSheet, getCameraName } from './mobile-details-sheet'
import { resolveAppliedLookTitle } from './mobile-lut-strip'
import { MobileExportPanel } from './MobileExportPanel'
import { MobileLabChrome } from './MobileLabChrome'
import { MobileMoreSheet } from './MobileMoreSheet'

/**
 * The mobile shell over the workflow. It reads no adjustment value and no
 * preview timing itself: the Adjust list, the Strength row, the scrub HUD,
 * the export recap and the details sheet read their own, so a scrub step or
 * a new render timing renders them and leaves the chrome around them alone.
 */
export function MobileRawToolSurface() {
  const props = useRawWorkflowContext()
  const commands = useRawToolCommands()
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
  return (
    <MobileLabChrome
      transform={props.transform}
      availability={availability}
      canExport={props.canExport}
      hasImage={props.hasImage}
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
        onIntensityChange: commands.onIntensityChange,
        strengthDisabled: !availability.strength.available,
      }}
      exportPanel={(controls) => <MobileExportPanelSlot {...controls} />}
      moreSheet={(controls) => <MobileDetailsSheetSlot {...controls} />}
      previewSuspended={previewSuspended}
      preferExportMode={previewSuspended && props.exportResult != null}
      previewFrameEl={props.previewFrameEl ?? null}
      photoAspect={props.previewAspect ?? null}
    />
  )
}

/**
 * The export panel, mounted while export holds the deck. It reads the
 * adjustments and the look strength its recap names, which no scrub moves
 * while it is open.
 */
function MobileExportPanelSlot({
  onClose,
  onChooseLutContract,
}: {
  onClose: () => void
  onChooseLutContract: () => void
}) {
  const props = useRawWorkflowContext()
  const commands = useRawToolCommands()
  const adjustments = useRawToolAdjustments()
  const { isExporting } = useRawToolStatus()
  const progress = useRawToolProgress()

  // The recap names a catalog look the way its tile does.
  const lookTitle = resolveAppliedLookTitle({
    entries: props.onlineLutSources?.state.entries ?? [],
    applied: props.currentLutName
      ? (props.appliedLut ?? { name: props.currentLutName })
      : null,
    loaded: props.onlineLutSources?.loadedEntry,
  })
  const recap = buildMobileExportRecap({
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
      recap={recap}
    />
  )
}

/**
 * The File & pipeline details sheet over the facts it lists: the file, the
 * preview stats, the look and how many Adjust fields moved. It reads them
 * itself, and the count changes only when a field leaves or returns to
 * neutral, not on every scrub step.
 */
function MobileDetailsSheetSlot({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const props = useRawWorkflowContext()
  const stats = useRawPreviewStats()
  const adjustedFields = useRawToolAdjustmentsSummary(countAdjustments)
  const { t } = useI18n()
  const sheet = buildMobileDetailsSheet(
    {
      supportLevel: props.supportLevel,
      metadata: props.metadata,
      stats,
      adjustments: adjustedFields,
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
  return (
    <MobileMoreSheet
      open={open}
      onClose={onClose}
      pipelineSteps={sheet.pipelineSteps}
      lutRows={sheet.lutRows}
      fileRows={sheet.fileRows}
    />
  )
}

import type {
  LUTColorProfile,
  LUTContractResolution,
} from '@lumaforge/luma-color-runtime'
import { useEffect, useId, useMemo, useState } from 'react'

import type { UseOnlineLutSourcesResult } from '../../hooks/useOnlineLutSources'
import type { LUTContractSelectionState } from '../../model/session'
import { useLutContractSummary } from '../tools/lut/useLutContractSummary'
import { useOnlineLutEntryLoader } from '../tools/lut/useOnlineLutEntryLoader'
import type { StrengthLevel } from '../tools/StrengthControl'
import type { AppliedLut, LoadedLutEntry } from './mobile-lut-strip'
import { buildLutStripItems } from './mobile-lut-strip'
import type { LookContractStep } from './MobileLookFooter'
import { MobileLookFooter } from './MobileLookFooter'
import { MobileLookStrength } from './MobileLookStrength'
import { MobileLutStrip } from './MobileLutStrip'

/** How long the Strength row's disabled reason stays in the footer. */
const STRENGTH_REASON_MS = 2500

/** Everything the mobile Look tool reads and drives. */
export interface MobileLookControls {
  currentLutName?: string | null
  /** The applied LUT's identity, for matching it to a strip tile. */
  appliedLut?: AppliedLut | null
  /** Processing or exporting: the look cannot change. */
  disabled: boolean
  onLutLoad: (files: File[]) => void
  onLutClear: () => void
  lutProfileSelection?: LUTContractSelectionState | null
  lutProfileResolution?: LUTContractResolution | null
  onLutProfileSelect: (profile: LUTColorProfile) => void
  onlineLutSources?: UseOnlineLutSourcesResult
  activeIntensity?: StrengthLevel
  onIntensitySelect?: (level: StrengthLevel) => void
  strengthDisabled?: boolean
}

const EMPTY_RESOURCES: UseOnlineLutSourcesResult['state']['resources'] = []
const EMPTY_ENTRIES: UseOnlineLutSourcesResult['state']['entries'] = []

/**
 * The Look tool: looks are tried on the photo. A strip of tiles (Original,
 * the applied file, every online look, Import .cube), the strength of the
 * applied LUT, and a footer that says where its colour contract stands.
 */
export function MobileLookDeck(props: {
  look: MobileLookControls
  onOpenSources: () => void
  onOpenContract: (
    step: LookContractStep,
    draft?: LUTColorProfile | null,
  ) => void
}) {
  const { look } = props
  const sources = look.onlineLutSources
  const strengthReasonId = useId()
  const [strengthReasonShown, setStrengthReasonShown] = useState(false)
  const [dismissedFailureId, setDismissedFailureId] = useState<string | null>(
    null,
  )
  const [loaded, setLoaded] = useState<LoadedLutEntry | null>(null)
  const [justLoadedEntryId, setJustLoadedEntryId] = useState<string | null>(
    null,
  )
  const { loadingEntryId, failedEntryId, loadOnlineLutEntry } =
    useOnlineLutEntryLoader(sources, { replace: true })
  const summary = useLutContractSummary({
    lutProfileSelection: look.lutProfileSelection,
    lutProfileResolution: look.lutProfileResolution,
  })
  const lutApplied = Boolean(look.currentLutName)
  const appliedName = lutApplied
    ? (look.appliedLut?.name ?? look.currentLutName ?? null)
    : null
  const appliedSha = lutApplied ? (look.appliedLut?.sha256 ?? null) : null
  const appliedSourceName = lutApplied
    ? (look.appliedLut?.sourceName ?? null)
    : null
  const applied = useMemo<AppliedLut | null>(
    () =>
      appliedName
        ? {
            name: appliedName,
            sha256: appliedSha,
            sourceName: appliedSourceName,
          }
        : null,
    [appliedName, appliedSha, appliedSourceName],
  )

  // An entry with no declared hash is matched by the load the strip made:
  // once the session reports the hash it applied, remember the pair.
  useEffect(() => {
    if (!justLoadedEntryId || !appliedSha) return
    setLoaded({ entryId: justLoadedEntryId, sha256: appliedSha })
    setJustLoadedEntryId(null)
  }, [appliedSha, justLoadedEntryId])

  useEffect(() => {
    if (!strengthReasonShown) return
    const timer = setTimeout(setStrengthReasonShown, STRENGTH_REASON_MS, false)
    return () => clearTimeout(timer)
  }, [strengthReasonShown])

  const resources = sources?.state.resources ?? EMPTY_RESOURCES
  const entries = sources?.state.entries ?? EMPTY_ENTRIES
  const items = useMemo(
    () => buildLutStripItems({ resources, entries, applied, loaded }),
    [resources, entries, applied, loaded],
  )
  const appliedNeedsContract =
    lutApplied && summary.contractView.status !== 'confirmed'

  const failedEntry =
    failedEntryId && failedEntryId !== dismissedFailureId
      ? entries.find((entry) => entry.id === failedEntryId)
      : undefined

  const loadEntry = (entryId: string) => {
    setDismissedFailureId(null)
    void loadOnlineLutEntry(entryId, () => setJustLoadedEntryId(entryId))
  }

  return (
    <div data-mobile-look-deck className="grid gap-2">
      <MobileLutStrip
        items={items}
        loadingEntryId={loadingEntryId}
        failedEntryId={failedEntryId}
        entryLoadProgress={sources?.entryLoadProgress ?? null}
        disabled={look.disabled}
        appliedNeedsContract={appliedNeedsContract}
        onSelectOriginal={() => {
          setDismissedFailureId(failedEntryId)
          // A look still on its way must not land after the Original.
          sources?.cancelEntryLoad()
          if (lutApplied) look.onLutClear()
        }}
        onSelectEntry={(entryId) => {
          const item = items
            .flatMap((entry) => (entry.kind === 'source' ? entry.entries : []))
            .find((entry) => entry.entry.id === entryId)
          if (item?.applied) return
          loadEntry(entryId)
        }}
        onCancelEntry={() => sources?.cancelEntryLoad()}
        onImport={(files) => {
          setDismissedFailureId(failedEntryId)
          sources?.cancelEntryLoad()
          look.onLutLoad(files)
        }}
      />
      <MobileLookStrength
        value={look.activeIntensity ?? 'standard'}
        onChange={look.onIntensitySelect}
        disabled={look.strengthDisabled ?? !lutApplied}
        describedBy={lutApplied ? undefined : strengthReasonId}
        onBlockedPress={
          lutApplied ? undefined : () => setStrengthReasonShown(true)
        }
      />
      <MobileLookFooter
        lutApplied={lutApplied}
        contractView={summary.contractView}
        displayOutputLabel={summary.displayOutputLabel}
        failure={
          failedEntry
            ? {
                label: failedEntry.title,
                onRetry: () => loadEntry(failedEntry.id),
              }
            : null
        }
        strengthReasonShown={strengthReasonShown && !lutApplied}
        strengthReasonId={strengthReasonId}
        disabled={look.disabled}
        onOpenContract={props.onOpenContract}
        onApplyRecommendation={look.onLutProfileSelect}
        onOpenSources={props.onOpenSources}
      />
    </div>
  )
}

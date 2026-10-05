import type {
  LUTColorProfile,
  LUTContractResolution,
} from '@lumaforge/luma-color-runtime'
import { m } from 'motion/react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import { surfaceFade } from '~/lib/spring'

import type { UseOnlineLutSourcesResult } from '../../hooks/useOnlineLutSources'
import type { LUTContractSelectionState } from '../../model/session'
import { useLutContractSummary } from '../tools/lut/useLutContractSummary'
import { useOnlineLutEntryLoader } from '../tools/lut/useOnlineLutEntryLoader'
import type { StrengthLevel } from '../tools/StrengthControl'
import type { AppliedLut, LoadedLutEntry } from './mobile-lut-strip'
import { buildLutStripItems } from './mobile-lut-strip'
import type { MobileLookView } from './mobile-stage-layout'
import type { LookContractStep } from './MobileLookFooter'
import { MobileLookFooter } from './MobileLookFooter'
import { MobileLookStrength } from './MobileLookStrength'
import { MobileLutContractView } from './MobileLutContractView'
import { MobileLutStrip } from './MobileLutStrip'
import { useMobileLutContractEditor } from './useMobileLutContractEditor'

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
  /**
   * The strip, or the LUT contract chosen inline. The chrome owns it: the
   * contract view takes list-tool sizing, so the photo stays above it.
   */
  view: MobileLookView
  onViewChange: (view: MobileLookView) => void
}) {
  const { look, view, onViewChange } = props
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
  const editor = useMobileLutContractEditor({
    lutProfileSelection: look.lutProfileSelection,
    lutProfileResolution: look.lutProfileResolution,
    onLutProfileSelect: look.onLutProfileSelect,
    // A complete contract hands the deck back to the strip, whose footer
    // then reads the confirmed line.
    onComplete: () => onViewChange('strip'),
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

  // Opened here, the editor starts at the step and draft asked for. Opened
  // from elsewhere (the export panel's blocked state), the deck mounts into
  // the contract view and the editor starts where the contract stands.
  const openContract = (
    step?: LookContractStep,
    draft?: LUTColorProfile | null,
  ) => {
    editor.start(step, draft)
    onViewChange('contract')
  }
  const openContractRef = useRef(openContract)
  useEffect(() => {
    openContractRef.current = openContract
  })

  // No LUT, no contract to choose.
  useEffect(() => {
    if (view === 'contract' && !lutApplied) onViewChange('strip')
  }, [lutApplied, onViewChange, view])

  // A .cube the user imports opens its contract when nothing resolved it,
  // once the session reports the new LUT.
  const importBaseline = useRef<string | null | undefined>(undefined)
  const appliedIdentity = applied
    ? `${applied.sha256 ?? ''}|${applied.name}`
    : null
  const contractStatus = summary.contractView.status
  useEffect(() => {
    const baseline = importBaseline.current
    if (baseline === undefined || !appliedIdentity) return
    if (appliedIdentity === baseline) return
    importBaseline.current = undefined
    if (contractStatus !== 'confirmed') openContractRef.current()
  }, [appliedIdentity, contractStatus])

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

  if (view === 'contract' && lutApplied) {
    return (
      <m.div
        key="contract"
        data-mobile-look-deck="contract"
        className="h-full min-h-0"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={surfaceFade}
      >
        <MobileLutContractView
          lutName={applied?.sourceName || applied?.name || ''}
          editor={editor}
          onExit={() => onViewChange('strip')}
        />
      </m.div>
    )
  }

  return (
    <m.div
      key="strip"
      data-mobile-look-deck="strip"
      className="grid gap-2"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={surfaceFade}
    >
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
            .flatMap((entry) => (entry.kind === 'group' ? entry.entries : []))
            .find((entry) => entry.entry.id === entryId)
          if (item?.applied) return
          loadEntry(entryId)
        }}
        onCancelEntry={() => sources?.cancelEntryLoad()}
        onImport={(files) => {
          setDismissedFailureId(failedEntryId)
          sources?.cancelEntryLoad()
          importBaseline.current = appliedIdentity
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
        onOpenContract={openContract}
        onApplyRecommendation={look.onLutProfileSelect}
        onOpenSources={props.onOpenSources}
      />
    </m.div>
  )
}

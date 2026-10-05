import type {
  LUTColorProfile,
  LUTContractResolution,
} from '@lumaforge/luma-color-runtime'
import { m } from 'motion/react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import { clsxm } from '~/lib/cn'
import { surfaceFade } from '~/lib/spring'

import type { UseOnlineLutSourcesResult } from '../../hooks/useOnlineLutSources'
import type { LUTContractSelectionState } from '../../model/session'
import { DEFAULT_LOOK_INTENSITY } from '../../services/look/style-system'
import { useLutContractSummary } from '../tools/lut/useLutContractSummary'
import { useOnlineLutEntryLoader } from '../tools/lut/useOnlineLutEntryLoader'
import type { ScrubFieldId } from './AdjustListPanel'
import { handLostFocusTo } from './focus-handoff'
import type { AppliedLut } from './mobile-lut-strip'
import { buildLutStripItems, resolveAppliedLookTitle } from './mobile-lut-strip'
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
  /** Resolves once the load settles, applied or not. */
  onLutLoad: (files: File[]) => void | Promise<unknown>
  onLutClear: () => void
  lutProfileSelection?: LUTContractSelectionState | null
  lutProfileResolution?: LUTContractResolution | null
  onLutProfileSelect: (profile: LUTColorProfile) => void
  onlineLutSources?: UseOnlineLutSourcesResult
  /** How much of the look reaches the photo, 0..1. */
  activeIntensity?: number
  onIntensityChange?: (value: number) => void
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
  /**
   * A Strength scrub reports on the Adjust channel, so it takes the same
   * focus: the HUD in the topbar band, the dock and topbar receding.
   */
  onScrubChange?: (field: ScrubFieldId | null) => void
}) {
  const { look, view, onViewChange } = props
  const [strengthScrubbing, setStrengthScrubbing] = useState(false)
  // Neighbours dim, they do not disappear: the look a scrub is weighing
  // stays in view.
  const siblingClass = clsxm(
    'transition-opacity duration-150',
    strengthScrubbing && 'pointer-events-none opacity-45',
  )
  const sources = look.onlineLutSources
  const strengthReasonId = useId()
  const [strengthReasonShown, setStrengthReasonShown] = useState(false)
  const [dismissedFailureId, setDismissedFailureId] = useState<string | null>(
    null,
  )
  // Recorded by the LUT sources for every surface, so the applied tile
  // survives this deck remounting and loads made from LUT sources count.
  const loaded = sources?.loadedEntry ?? null
  const {
    loadingEntryId,
    failedEntryId,
    loadOnlineLutEntry,
    cancelOnlineLutEntry,
  } = useOnlineLutEntryLoader(sources, { replace: true })
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

  // Leaving the contract view (complete, or back) removes the control that
  // had focus. The footer's contract button takes it, or the applied tile
  // when the footer has none. The contract view takes focus on its own way
  // in.
  const rootRef = useRef<HTMLDivElement>(null)
  const shownView: MobileLookView =
    view === 'contract' && lutApplied ? 'contract' : 'strip'
  const previousShownView = useRef(shownView)
  useEffect(() => {
    const previous = previousShownView.current
    previousShownView.current = shownView
    if (previous !== 'contract' || shownView !== 'strip') return
    const root = rootRef.current
    handLostFocusTo(
      root?.querySelector<HTMLElement>('[data-look-contract-button]') ??
        root?.querySelector<HTMLElement>(
          '[data-mobile-lut-tile][aria-pressed="true"]',
        ),
    )
  }, [shownView])

  // A .cube the user imports opens its contract when nothing resolved it,
  // once the session reports the new LUT. Armed by the import alone: a
  // failed or no-op import, or a look chosen from the strip, disarms it,
  // so a later unrelated look never opens a contract by surprise.
  const importBaseline = useRef<string | null | undefined>(undefined)
  const importAttempt = useRef<object | null>(null)
  const [importSettled, setImportSettled] = useState<object | null>(null)
  const disarmImport = () => {
    importBaseline.current = undefined
    importAttempt.current = null
  }
  const appliedIdentity = applied
    ? `${applied.sha256 ?? ''}|${applied.name}`
    : null
  const contractStatus = summary.contractView.status
  useEffect(() => {
    const baseline = importBaseline.current
    if (baseline === undefined || !appliedIdentity) return
    if (appliedIdentity === baseline) return
    importBaseline.current = undefined
    importAttempt.current = null
    if (contractStatus !== 'confirmed') openContractRef.current()
  }, [appliedIdentity, contractStatus])
  // Runs after the effect above in the commit that carries the import's
  // result, so a LUT that did land has already been answered.
  useEffect(() => {
    if (!importSettled || importAttempt.current !== importSettled) return
    importBaseline.current = undefined
    importAttempt.current = null
  }, [importSettled])

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
    disarmImport()
    setDismissedFailureId(null)
    void loadOnlineLutEntry(entryId)
  }

  if (view === 'contract' && lutApplied) {
    return (
      <m.div
        ref={rootRef}
        key="contract"
        data-mobile-look-deck="contract"
        className="h-full min-h-0"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={surfaceFade}
      >
        <MobileLutContractView
          lutName={resolveAppliedLookTitle({ entries, applied, loaded }) ?? ''}
          editor={editor}
          onExit={() => onViewChange('strip')}
        />
      </m.div>
    )
  }

  return (
    <m.div
      ref={rootRef}
      key="strip"
      data-mobile-look-deck="strip"
      // A single shrinkable column: the strip's scroller is as wide as all
      // of its tiles, and an auto column would grow to that width and push
      // Strength and the footer off the screen.
      className="grid grid-cols-[minmax(0,1fr)] gap-2"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={surfaceFade}
    >
      <div
        data-sibling-scrubbing={strengthScrubbing || undefined}
        className={siblingClass}
      >
        <MobileLutStrip
          items={items}
          loadingEntryId={loadingEntryId}
          failedEntryId={failedEntryId}
          entryLoadProgress={sources?.entryLoadProgress ?? null}
          disabled={look.disabled}
          appliedNeedsContract={appliedNeedsContract}
          onSelectOriginal={() => {
            disarmImport()
            setDismissedFailureId(failedEntryId)
            // A look still on its way must not land after the Original.
            cancelOnlineLutEntry()
            if (lutApplied) look.onLutClear()
          }}
          onSelectEntry={(entryId) => {
            const item = items
              .flatMap((entry) => (entry.kind === 'group' ? entry.entries : []))
              .find((entry) => entry.entry.id === entryId)
            if (item?.applied) return
            loadEntry(entryId)
          }}
          onCancelEntry={cancelOnlineLutEntry}
          onImport={(files) => {
            setDismissedFailureId(failedEntryId)
            cancelOnlineLutEntry()
            importBaseline.current = appliedIdentity
            const attempt = {}
            importAttempt.current = attempt
            const settling = look.onLutLoad(files)
            // Without a promise there is no settle to wait for; the next
            // strip tap disarms it instead.
            if (settling) {
              const settle = () => setImportSettled(attempt)
              settling.then(settle, settle)
            }
          }}
        />
      </div>
      <MobileLookStrength
        value={look.activeIntensity ?? DEFAULT_LOOK_INTENSITY}
        onChange={look.onIntensityChange}
        disabled={look.strengthDisabled ?? !lutApplied}
        describedBy={lutApplied ? undefined : strengthReasonId}
        onBlockedPress={
          lutApplied ? undefined : () => setStrengthReasonShown(true)
        }
        activeScrub={strengthScrubbing}
        onScrubChange={(scrubbing) => {
          setStrengthScrubbing(scrubbing)
          props.onScrubChange?.(scrubbing ? { kind: 'strength' } : null)
        }}
      />
      <div
        data-sibling-scrubbing={strengthScrubbing || undefined}
        className={siblingClass}
      >
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
      </div>
    </m.div>
  )
}

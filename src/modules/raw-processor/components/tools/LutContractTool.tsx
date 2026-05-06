import type {
  LUTColorProfile,
  LUTProfileResolution,
} from '@lumaforge/luma-color-runtime'
import { searchLUTColorProfiles } from '@lumaforge/luma-color-runtime'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import {
  Download,
  FolderOpen,
  Plus,
  RefreshCw,
  Share2,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react'
import type { CSSProperties, ReactNode, Ref, RefObject } from 'react'
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { Input } from '~/components/ui/input'
import { useI18n } from '~/lib/i18n'

import type { UseOnlineLutSourcesResult } from '../../hooks/useOnlineLutSources'
import type { LUTProfileSelectionState } from '../../model/session'
import { LutDropzone } from '../Dropzone'
import {
  composeLUTContractProfile,
  getProfileAsOutputLabel,
  getProfileContractLabel,
  getProfileOutputLabel,
  getResolvedProfile,
  groupProfiles,
  toSelectableContract,
} from './lut-contract'
import { ToolSection } from './ToolSection'

type OnlineLutSourceEntries = UseOnlineLutSourcesResult['state']['entries']
type OnlineLutSourceIssues = UseOnlineLutSourcesResult['state']['issues']

type OnlineLutBrowserPlacement = 'anchored' | 'docked' | 'sheet'

type OnlineLutBrowserLayout = {
  placement: OnlineLutBrowserPlacement
  top?: number
  left?: number
  width?: number
  maxHeight?: number
}

type OnlineLutBrowserStyle = CSSProperties & {
  '--raw-lut-source-browser-top'?: string
  '--raw-lut-source-browser-left'?: string
  '--raw-lut-source-browser-width'?: string
  '--raw-lut-source-browser-max-height'?: string
}

const LUT_BROWSER_VIEWPORT_MARGIN = 12
const LUT_BROWSER_TRIGGER_GAP = 8
const LUT_BROWSER_MIN_WIDTH = 320
const LUT_BROWSER_MAX_WIDTH = 420
const LUT_BROWSER_MIN_HEIGHT = 184
const LUT_BROWSER_MAX_HEIGHT = 420

function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function getViewportBoundedBrowserLayout(
  trigger: HTMLButtonElement | undefined,
): OnlineLutBrowserLayout {
  if (typeof window === 'undefined' || !trigger) {
    return { placement: 'anchored' }
  }

  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const margin = LUT_BROWSER_VIEWPORT_MARGIN

  if (viewportWidth <= 720) {
    return { placement: 'sheet' }
  }

  const triggerRect = trigger.getBoundingClientRect()
  const rowRect =
    trigger.closest('[data-lut-resource-row]')?.getBoundingClientRect() ??
    triggerRect
  const availableWidth = Math.max(0, viewportWidth - margin * 2)
  const width = Math.min(
    LUT_BROWSER_MAX_WIDTH,
    Math.max(LUT_BROWSER_MIN_WIDTH, Math.min(rowRect.width, availableWidth)),
    availableWidth,
  )
  const left = clampNumber(
    triggerRect.left,
    margin,
    viewportWidth - margin - width,
  )
  const viewportBoundedHeight = Math.max(
    LUT_BROWSER_MIN_HEIGHT,
    viewportHeight - margin * 2,
  )

  if (viewportHeight <= 520) {
    return {
      placement: 'docked',
      top: margin,
      left,
      width,
      maxHeight: viewportBoundedHeight,
    }
  }

  const availableBelow =
    viewportHeight - triggerRect.bottom - margin - LUT_BROWSER_TRIGGER_GAP
  const availableAbove = triggerRect.top - margin - LUT_BROWSER_TRIGGER_GAP
  const placeBelow = availableBelow >= availableAbove
  const maxHeight = clampNumber(
    placeBelow ? availableBelow : availableAbove,
    LUT_BROWSER_MIN_HEIGHT,
    Math.min(LUT_BROWSER_MAX_HEIGHT, viewportBoundedHeight),
  )
  const preferredTop = placeBelow
    ? triggerRect.bottom + LUT_BROWSER_TRIGGER_GAP
    : triggerRect.top - LUT_BROWSER_TRIGGER_GAP - maxHeight

  return {
    placement: 'anchored',
    top: clampNumber(preferredTop, margin, viewportHeight - margin - maxHeight),
    left,
    width,
    maxHeight,
  }
}

function toBrowserStyle(
  layout: OnlineLutBrowserLayout | null,
): OnlineLutBrowserStyle | undefined {
  if (!layout || layout.placement === 'sheet') return undefined

  return {
    '--raw-lut-source-browser-top': `${layout.top}px`,
    '--raw-lut-source-browser-left': `${layout.left}px`,
    '--raw-lut-source-browser-width': `${layout.width}px`,
    '--raw-lut-source-browser-max-height': `${layout.maxHeight}px`,
    height: `${layout.maxHeight}px`,
  }
}

function useRawLabPortalContainer(open: boolean) {
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(
    null,
  )

  useLayoutEffect(() => {
    if (!open || typeof document === 'undefined') return

    setPortalContainer(document.querySelector('.raw-lab') ?? document.body)
  }, [open])

  return portalContainer
}

function isInsideElement(
  target: EventTarget | null,
  element: HTMLElement | null | undefined,
) {
  return Boolean(element && target instanceof Node && element.contains(target))
}

function LutBrowserDialog({
  open,
  layout,
  id,
  kind,
  className,
  headingClassName,
  dialogLabel,
  title,
  description,
  closeLabel,
  restoreFocus,
  triggerElement,
  onOpenChange,
  children,
}: {
  open: boolean
  layout: OnlineLutBrowserLayout | null
  id: string
  kind: 'source' | 'contract'
  className: string
  headingClassName: string
  dialogLabel: string
  title: ReactNode
  description: ReactNode
  closeLabel: string
  restoreFocus: () => void
  triggerElement?: HTMLElement | null
  onOpenChange: (open: boolean) => void
  children: ReactNode
}) {
  const portalContainer = useRawLabPortalContainer(open)

  if (!open || !layout) return null

  return (
    <DialogPrimitive.Root open={open} modal={false} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal
        container={portalContainer ?? undefined}
        forceMount
      >
        <DialogPrimitive.Content
          id={id}
          forceMount
          aria-label={dialogLabel}
          className={`fixed z-60 grid gap-2 overflow-hidden rounded-lg border border-[color:oklch(0.67_0.04_78_/_0.72)] bg-[color:oklch(0.948_0.022_86_/_0.98)] p-2 shadow-[0_18px_42px_oklch(0.32_0.04_70_/_0.16),inset_0_2px_0_oklch(0.98_0.018_86_/_0.72)] ${className}`}
          data-lut-source-placement={layout.placement}
          data-raw-lut-browser-dialog={kind}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            queueMicrotask(restoreFocus)
          }}
          onPointerDownOutside={(event) => {
            if (isInsideElement(event.target, triggerElement)) {
              event.preventDefault()
            }
          }}
          onInteractOutside={(event) => {
            if (isInsideElement(event.target, triggerElement)) {
              event.preventDefault()
            }
          }}
          style={toBrowserStyle(layout)}
        >
          <div
            className={`flex min-w-0 items-center justify-between gap-2.5 ${headingClassName}`}
          >
            <div className="min-w-0">
              <DialogPrimitive.Title className="sr-only">
                {dialogLabel}
              </DialogPrimitive.Title>
              <span
                aria-hidden="true"
                className="block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[0.74rem] font-semibold text-[color:--color-raw-ink]"
              >
                {title}
              </span>
              <DialogPrimitive.Description asChild>
                <p className="mt-0.5 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[0.66rem] leading-tight text-[color:--color-raw-ink-soft]">
                  {description}
                </p>
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close
              type="button"
              aria-label={closeLabel}
              title={closeLabel}
              className="inline-flex size-8 items-center justify-center rounded-lg border border-[color:oklch(0.74_0.035_78_/_0.72)] bg-[color:oklch(0.964_0.018_86_/_0.76)] text-[color:--color-raw-ink-soft] transition-all duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] hover:not-disabled:border-[color:oklch(0.59_0.15_153_/_0.58)] hover:not-disabled:bg-[color:oklch(0.59_0.15_153_/_0.1)] hover:not-disabled:text-[color:--color-raw-green-deep] hover:not-disabled:-translate-y-px disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-[color:--color-raw-green] focus-visible:outline-offset-2"
            >
              <X aria-hidden="true" />
            </DialogPrimitive.Close>
          </div>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function LUTProfileButton({
  profile,
  activeProfileId,
  onSelect,
  label,
  ariaLabel,
  highlighted = false,
}: {
  profile: LUTColorProfile
  activeProfileId?: string
  onSelect: (profile: LUTColorProfile) => void
  label?: string
  ariaLabel?: string
  highlighted?: boolean
}) {
  const isActive = activeProfileId === profile.id
  const buttonLabel = label ?? getProfileContractLabel(profile)

  return (
    <button
      type="button"
      aria-label={ariaLabel ?? buttonLabel}
      aria-pressed={isActive}
      onClick={() => onSelect(profile)}
      className={
        isActive
          ? 'block w-full min-w-0 rounded-lg border border-[color:oklch(0.74_0.035_78_/_0.64)] bg-[color:oklch(0.954_0.02_86_/_0.72)] px-2 py-1.5 text-left text-[0.72rem] leading-snug transition-all duration-150 hover:border-[color:oklch(0.56_0.12_153_/_0.5)] hover:bg-[color:oklch(0.93_0.035_84_/_0.86)] hover:text-[color:--color-raw-ink] hover:-translate-y-px focus-visible:outline-2 focus-visible:outline-[color:--color-raw-green] focus-visible:outline-offset-2 border-[color:oklch(0.54_0.14_153)] bg-[color:--color-raw-green-soft] text-[color:--color-raw-ink]'
          : highlighted
            ? 'block w-full min-w-0 rounded-lg border border-[color:oklch(0.74_0.035_78_/_0.64)] bg-[color:oklch(0.954_0.02_86_/_0.72)] px-2 py-1.5 text-left text-[0.72rem] leading-snug transition-all duration-150 hover:border-[color:oklch(0.56_0.12_153_/_0.5)] hover:bg-[color:oklch(0.93_0.035_84_/_0.86)] hover:text-[color:--color-raw-ink] hover:-translate-y-px focus-visible:outline-2 focus-visible:outline-[color:--color-raw-green] focus-visible:outline-offset-2 border-[color:oklch(0.78_0.16_63_/_0.38)] bg-[color:oklch(0.93_0.05_78_/_0.82)] text-[color:--color-raw-ink]'
            : 'block w-full min-w-0 rounded-lg border border-[color:oklch(0.74_0.035_78_/_0.64)] bg-[color:oklch(0.954_0.02_86_/_0.72)] px-2 py-1.5 text-left text-[0.72rem] leading-snug text-[color:--color-raw-ink-soft] transition-all duration-150 hover:border-[color:oklch(0.56_0.12_153_/_0.5)] hover:bg-[color:oklch(0.93_0.035_84_/_0.86)] hover:text-[color:--color-raw-ink] hover:-translate-y-px focus-visible:outline-2 focus-visible:outline-[color:--color-raw-green] focus-visible:outline-offset-2'
      }
    >
      <span className="block min-w-0 break-words">{buttonLabel}</span>
    </button>
  )
}

type LUTContractBrowserStep = 'input' | 'output'

type LUTOutputOption = {
  id: string
  label: string
  gamut: LUTColorProfile['inputGamut']
  transfer: LUTColorProfile['inputTransfer']
  range: LUTColorProfile['inputRange']
  sourceProfile: LUTColorProfile
}

function dedupeProfiles(profiles: LUTColorProfile[]) {
  const seen = new Set<string>()
  return profiles.filter((profile) => {
    if (seen.has(profile.id)) return false
    seen.add(profile.id)
    return true
  })
}

function dedupeOutputOptions(options: LUTOutputOption[]) {
  const seen = new Set<string>()
  return options.filter((option) => {
    if (seen.has(option.id)) return false
    seen.add(option.id)
    return true
  })
}

function getOutputGroupLabel(profile: LUTColorProfile) {
  if (profile.role === 'display-look') return 'Output'
  if (profile.label.startsWith('ARRI')) return 'ARRI'
  if (profile.label.startsWith('RED')) return 'RED'
  if (profile.label.startsWith('Nikon')) return 'Nikon'
  if (profile.label.startsWith('Sony')) return 'Sony'
  if (profile.label.startsWith('Canon')) return 'Canon'
  if (profile.label.startsWith('Fujifilm')) return 'Fujifilm'
  if (profile.label.startsWith('Panasonic')) return 'Panasonic'
  if (profile.label.startsWith('ACES')) return 'ACES'
  return 'Other'
}

function toDeclaredOutputOption(
  profile: LUTColorProfile,
): LUTOutputOption | undefined {
  const selectable = toSelectableContract(profile)
  if (
    !selectable?.outputGamut ||
    !selectable.outputTransfer ||
    !selectable.outputRange
  ) {
    return undefined
  }

  return {
    id: `${profile.id}:declared-output`,
    label:
      getProfileOutputLabel(selectable) ?? getProfileAsOutputLabel(profile),
    gamut: selectable.outputGamut,
    transfer: selectable.outputTransfer,
    range: selectable.outputRange,
    sourceProfile: profile,
  }
}

function toSearchOutputOption(profile: LUTColorProfile): LUTOutputOption {
  return {
    id: `${profile.id}:search-output`,
    label: profile.label,
    gamut: profile.inputGamut,
    transfer: profile.inputTransfer,
    range: profile.inputRange,
    sourceProfile: profile,
  }
}

function toOutputCarrierProfile(option: LUTOutputOption): LUTColorProfile {
  return {
    ...option.sourceProfile,
    inputGamut: option.gamut,
    inputTransfer: option.transfer,
    inputRange: option.range,
    outputGamut: undefined,
    outputTransfer: undefined,
    outputRange: undefined,
  }
}

function groupOutputOptions(options: LUTOutputOption[]) {
  const groups = new Map<string, LUTOutputOption[]>()

  for (const option of options) {
    const group = getOutputGroupLabel(option.sourceProfile)
    groups.set(group, [...(groups.get(group) ?? []), option])
  }

  return Array.from(groups.entries()).map(([label, items]) => ({
    label,
    items,
  }))
}

function LUTOutputOptionButton({
  option,
  activeOptionId,
  onSelect,
  highlighted = false,
}: {
  option: LUTOutputOption
  activeOptionId?: string
  onSelect: (option: LUTOutputOption) => void
  highlighted?: boolean
}) {
  const { t } = useI18n()
  const isActive = activeOptionId === option.id

  return (
    <button
      type="button"
      aria-label={t('raw.lutContract.useOutput', { label: option.label })}
      aria-pressed={isActive}
      onClick={() => onSelect(option)}
      className={
        isActive
          ? 'block w-full min-w-0 rounded-lg border border-[color:oklch(0.74_0.035_78_/_0.64)] bg-[color:oklch(0.954_0.02_86_/_0.72)] px-2 py-1.5 text-left text-[0.72rem] leading-snug transition-all duration-150 hover:border-[color:oklch(0.56_0.12_153_/_0.5)] hover:bg-[color:oklch(0.93_0.035_84_/_0.86)] hover:text-[color:--color-raw-ink] hover:-translate-y-px focus-visible:outline-2 focus-visible:outline-[color:--color-raw-green] focus-visible:outline-offset-2 border-[color:oklch(0.54_0.14_153)] bg-[color:--color-raw-green-soft] text-[color:--color-raw-ink]'
          : highlighted
            ? 'block w-full min-w-0 rounded-lg border border-[color:oklch(0.74_0.035_78_/_0.64)] bg-[color:oklch(0.954_0.02_86_/_0.72)] px-2 py-1.5 text-left text-[0.72rem] leading-snug transition-all duration-150 hover:border-[color:oklch(0.56_0.12_153_/_0.5)] hover:bg-[color:oklch(0.93_0.035_84_/_0.86)] hover:text-[color:--color-raw-ink] hover:-translate-y-px focus-visible:outline-2 focus-visible:outline-[color:--color-raw-green] focus-visible:outline-offset-2 border-[color:oklch(0.78_0.16_63_/_0.38)] bg-[color:oklch(0.93_0.05_78_/_0.82)] text-[color:--color-raw-ink]'
            : 'block w-full min-w-0 rounded-lg border border-[color:oklch(0.74_0.035_78_/_0.64)] bg-[color:oklch(0.954_0.02_86_/_0.72)] px-2 py-1.5 text-left text-[0.72rem] leading-snug text-[color:--color-raw-ink-soft] transition-all duration-150 hover:border-[color:oklch(0.56_0.12_153_/_0.5)] hover:bg-[color:oklch(0.93_0.035_84_/_0.86)] hover:text-[color:--color-raw-ink] hover:-translate-y-px focus-visible:outline-2 focus-visible:outline-[color:--color-raw-green] focus-visible:outline-offset-2'
      }
    >
      <span className="block min-w-0 break-words">{option.label}</span>
    </button>
  )
}

function LUTContractBrowser({
  open,
  onClose,
  suggestions,
  currentProfile,
  onSelect,
  triggerRef,
  browserId,
}: {
  open: boolean
  onClose: (options?: { restoreFocus?: boolean }) => void
  suggestions: LUTColorProfile[]
  currentProfile?: LUTColorProfile
  onSelect: (profile: LUTColorProfile) => void
  triggerRef: RefObject<HTMLButtonElement | null>
  browserId: string
}) {
  const { t } = useI18n()
  const searchInputId = useId()
  const [browserLayout, setBrowserLayout] =
    useState<OnlineLutBrowserLayout | null>(null)
  const [query, setQuery] = useState('')
  const [step, setStep] = useState<LUTContractBrowserStep>('input')
  const [draftInputProfile, setDraftInputProfile] =
    useState<LUTColorProfile | null>(currentProfile ?? null)
  const hasQuery = query.trim().length > 0
  const searchResults = useMemo(() => searchLUTColorProfiles(query), [query])
  const resultIds = useMemo(
    () => new Set(searchResults.map((profile) => profile.id)),
    [searchResults],
  )

  useEffect(() => {
    if (!open) return

    setQuery('')
    setStep('input')
    setDraftInputProfile(currentProfile ?? null)
    setBrowserLayout(
      getViewportBoundedBrowserLayout(triggerRef.current ?? undefined),
    )
  }, [currentProfile, open, triggerRef])

  const updateBrowserLayout = useCallback(() => {
    if (!open) return
    setBrowserLayout(
      getViewportBoundedBrowserLayout(triggerRef.current ?? undefined),
    )
  }, [open, triggerRef])

  useLayoutEffect(() => {
    updateBrowserLayout()
  }, [open, updateBrowserLayout])

  useEffect(() => {
    if (!open) return

    const handleViewportChange = () => {
      updateBrowserLayout()
    }

    const scrollTargets = [
      triggerRef.current?.closest('.raw-tool-stack'),
      triggerRef.current?.closest('.raw-tool-surface'),
    ].filter((target): target is Element => target instanceof Element)

    window.addEventListener('resize', handleViewportChange)
    for (const target of scrollTargets) {
      target.addEventListener('scroll', handleViewportChange)
    }

    return () => {
      window.removeEventListener('resize', handleViewportChange)
      for (const target of scrollTargets) {
        target.removeEventListener('scroll', handleViewportChange)
      }
    }
  }, [onClose, open, triggerRef, updateBrowserLayout])

  const visibleSuggestions = useMemo(
    () =>
      dedupeProfiles(suggestions).filter(
        (profile) => !hasQuery || resultIds.has(profile.id),
      ),
    [hasQuery, resultIds, suggestions],
  )
  const suggestionIds = useMemo(
    () => new Set(visibleSuggestions.map((profile) => profile.id)),
    [visibleSuggestions],
  )
  const groupedInputProfiles = useMemo(
    () =>
      groupProfiles(
        dedupeProfiles(searchResults).filter(
          (profile) => !suggestionIds.has(profile.id),
        ),
      ),
    [searchResults, suggestionIds],
  )
  const suggestedOutputOptions = useMemo(
    () =>
      dedupeOutputOptions(
        visibleSuggestions
          .map(
            (profile) =>
              toDeclaredOutputOption(profile) ?? toSearchOutputOption(profile),
          )
          .filter(Boolean) as LUTOutputOption[],
      ),
    [visibleSuggestions],
  )
  const groupedOutputOptions = useMemo(
    () =>
      groupOutputOptions(
        dedupeOutputOptions(
          searchResults
            .filter((profile) => !suggestionIds.has(profile.id))
            .map(toSearchOutputOption),
        ),
      ),
    [searchResults, suggestionIds],
  )
  const activeOutputOptionId = useMemo(() => {
    if (
      !currentProfile?.outputGamut ||
      !currentProfile.outputTransfer ||
      !currentProfile.outputRange
    ) {
      return undefined
    }

    return `${currentProfile.id}:declared-output`
  }, [currentProfile])

  const handleInputSelect = (profile: LUTColorProfile) => {
    setDraftInputProfile(profile)
    setStep('output')
  }

  const handleOutputSelect = (option: LUTOutputOption) => {
    const inputProfile = draftInputProfile ?? option.sourceProfile

    onSelect(
      composeLUTContractProfile(inputProfile, toOutputCarrierProfile(option)),
    )
    onClose({ restoreFocus: true })
  }

  const hasInputMatches =
    visibleSuggestions.length > 0 || groupedInputProfiles.length > 0
  const hasOutputMatches =
    suggestedOutputOptions.length > 0 || groupedOutputOptions.length > 0

  if (!open || !browserLayout) return null

  return (
    <LutBrowserDialog
      open={open}
      layout={browserLayout}
      id={browserId}
      kind="contract"
      className="grid-rows-[auto_auto_auto_minmax(0,1fr)] items-start"
      headingClassName=""
      dialogLabel={t('raw.lutContract.browser')}
      title={t('raw.lutContract.browser')}
      description={
        draftInputProfile
          ? t('raw.lutContract.inputPrefix', {
              label: draftInputProfile.label,
            })
          : t('raw.lutContract.chooseInputOutput')
      }
      closeLabel={t('raw.lutContract.closeBrowser')}
      restoreFocus={() => triggerRef.current?.focus()}
      triggerElement={triggerRef.current}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose({ restoreFocus: true })
      }}
    >
      <div
        className="grid grid-cols-2 gap-1.5"
        role="tablist"
        aria-label={t('raw.lutContract.panels')}
      >
        <button
          type="button"
          role="tab"
          aria-selected={step === 'input'}
          className="min-h-[32px] rounded-lg border border-[color:oklch(0.74_0.035_78_/_0.58)] bg-[color:oklch(0.964_0.018_86_/_0.42)] text-[0.72rem] font-semibold text-[color:--color-raw-ink-soft] transition-all duration-150 hover:border-[color:oklch(0.59_0.15_153_/_0.34)] focus-visible:outline-2 focus-visible:outline-[color:--color-raw-green] focus-visible:outline-offset-2 aria-selected:border-[color:oklch(0.59_0.15_153_/_0.46)] aria-selected:bg-[color:oklch(0.59_0.15_153_/_0.12)] aria-selected:text-[color:--color-raw-green-deep]"
          onClick={() => setStep('input')}
        >
          {t('raw.lutContract.inputTab')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={step === 'output'}
          className="min-h-[32px] rounded-lg border border-[color:oklch(0.74_0.035_78_/_0.58)] bg-[color:oklch(0.964_0.018_86_/_0.42)] text-[0.72rem] font-semibold text-[color:--color-raw-ink-soft] transition-all duration-150 hover:border-[color:oklch(0.59_0.15_153_/_0.34)] focus-visible:outline-2 focus-visible:outline-[color:--color-raw-green] focus-visible:outline-offset-2 aria-selected:border-[color:oklch(0.59_0.15_153_/_0.46)] aria-selected:bg-[color:oklch(0.59_0.15_153_/_0.12)] aria-selected:text-[color:--color-raw-green-deep]"
          onClick={() => setStep('output')}
        >
          {t('raw.lutContract.outputTab')}
        </button>
      </div>

      <label htmlFor={searchInputId} className="sr-only">
        {t('raw.lutContract.search')}
      </label>
      <Input
        id={searchInputId}
        type="search"
        value={query}
        placeholder={t('raw.lutContract.searchPlaceholder')}
        onChange={(event) => setQuery(event.currentTarget.value)}
        inputClassName="border-[color:oklch(0.7_0.04_78_/_0.74)] bg-[color:oklch(0.948_0.022_86_/_0.9)] text-[color:--color-raw-ink] shadow-none placeholder:text-[color:oklch(0.5_0.035_75_/_0.72)] focus:border-[color:oklch(0.5_0.12_153_/_0.86)] focus:shadow-[0_0_0_2px_oklch(0.59_0.15_153_/_0.16)] h-8 text-xs"
      />

      <div
        className="grid self-stretch min-h-0 gap-1.5 overflow-y-auto overscroll-contain pr-0.5 [scrollbar-color:var(--color-raw-scrollbar-thumb)_transparent] [scrollbar-width:thin]"
        data-lut-contract-step={step}
      >
        {step === 'input' ? (
          <>
            {visibleSuggestions.length > 0 && (
              <div className="space-y-1">
                <p className="m-0 text-[0.68rem] font-semibold uppercase text-[color:oklch(0.47_0.085_68)]">
                  {t('raw.lutContract.suggestedInput')}
                </p>
                <div className="space-y-1">
                  {visibleSuggestions.map((profile) => (
                    <LUTProfileButton
                      key={profile.id}
                      profile={profile}
                      activeProfileId={draftInputProfile?.id}
                      label={profile.label}
                      ariaLabel={t('raw.lutContract.useInput', {
                        label: profile.label,
                      })}
                      onSelect={handleInputSelect}
                      highlighted
                    />
                  ))}
                </div>
              </div>
            )}

            {groupedInputProfiles.map((group) => (
              <div key={`input-${group.label}`} className="space-y-1">
                <p className="m-0 text-[0.68rem] font-semibold uppercase text-[color:oklch(0.47_0.085_68)]">
                  {t('raw.lutContract.groupInput', { group: group.label })}
                </p>
                <div className="space-y-1">
                  {group.items.map((profile) => (
                    <LUTProfileButton
                      key={profile.id}
                      profile={profile}
                      activeProfileId={draftInputProfile?.id}
                      label={profile.label}
                      ariaLabel={t('raw.lutContract.useInput', {
                        label: profile.label,
                      })}
                      onSelect={handleInputSelect}
                    />
                  ))}
                </div>
              </div>
            ))}

            {!hasInputMatches && (
              <p className="m-0 text-[0.72rem] leading-snug text-[color:--color-raw-ink-soft]">
                {t('raw.lutContract.noInput')}
              </p>
            )}
          </>
        ) : (
          <>
            {suggestedOutputOptions.length > 0 && (
              <div className="space-y-1">
                <p className="m-0 text-[0.68rem] font-semibold uppercase text-[color:oklch(0.47_0.085_68)]">
                  {t('raw.lutContract.suggestedOutput')}
                </p>
                <div className="space-y-1">
                  {suggestedOutputOptions.map((option) => (
                    <LUTOutputOptionButton
                      key={option.id}
                      option={option}
                      activeOptionId={activeOutputOptionId}
                      onSelect={handleOutputSelect}
                      highlighted
                    />
                  ))}
                </div>
              </div>
            )}

            {groupedOutputOptions.map((group) => (
              <div key={`output-${group.label}`} className="space-y-1">
                <p className="m-0 text-[0.68rem] font-semibold uppercase text-[color:oklch(0.47_0.085_68)]">
                  {t('raw.lutContract.groupOutput', { group: group.label })}
                </p>
                <div className="space-y-1">
                  {group.items.map((option) => (
                    <LUTOutputOptionButton
                      key={option.id}
                      option={option}
                      activeOptionId={activeOutputOptionId}
                      onSelect={handleOutputSelect}
                    />
                  ))}
                </div>
              </div>
            ))}

            {!hasOutputMatches && (
              <p className="m-0 text-[0.72rem] leading-snug text-[color:--color-raw-ink-soft]">
                {t('raw.lutContract.noOutput')}
              </p>
            )}
          </>
        )}
      </div>
    </LutBrowserDialog>
  )
}

function LUTProfileStatus({
  selection,
  resolution,
  onSelect,
}: {
  selection?: LUTProfileSelectionState | null
  resolution?: LUTProfileResolution | null
  onSelect: (profile: LUTColorProfile) => void
}) {
  const { t } = useI18n()
  const resolvedProfile = getResolvedProfile(selection, resolution)
  const outputLabel = getProfileOutputLabel(resolvedProfile)
  const needsOutputContract = outputLabel === 'Output profile required'
  const isPending = selection?.status === 'pending'
  const isUnsupportedOutput =
    resolution?.kind === 'needs-user-selection' &&
    resolution.reason === 'unsupported-output'
  const suggestions =
    selection?.status === 'pending' ? selection.suggestions : []
  const [browserOpen, setBrowserOpen] = useState(false)
  const browserId = useId()
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const handleClose = useCallback((options?: { restoreFocus?: boolean }) => {
    setBrowserOpen(false)

    if (options?.restoreFocus) {
      queueMicrotask(() => triggerRef.current?.focus())
    }
  }, [])

  if (!selection && !resolution) return null

  return (
    <div className="space-y-2 pt-1">
      {isUnsupportedOutput ? (
        <p className="m-0 rounded-lg border border-[color:oklch(0.78_0.16_63_/_0.38)] p-2.5 text-[0.72rem] leading-snug text-[color:--color-raw-ink-soft] bg-gradient-to-b from-[color:oklch(0.93_0.05_78_/_0.78)] to-[color:--color-raw-amber-soft]">
          {t('raw.lutContract.unsupportedOutput')}
        </p>
      ) : isPending ? (
        <p className="m-0 rounded-lg border border-[color:oklch(0.78_0.16_63_/_0.38)] p-2.5 text-[0.72rem] leading-snug text-[color:--color-raw-ink-soft] bg-gradient-to-b from-[color:oklch(0.93_0.05_78_/_0.78)] to-[color:--color-raw-amber-soft]">
          {t('raw.lutContract.unknown')}
        </p>
      ) : resolvedProfile ? (
        <div className="grid gap-1.5 min-w-0 text-[0.72rem] leading-snug text-[color:--color-raw-ink]">
          <p className="grid grid-cols-[4.9rem_minmax(0,1fr)] gap-2 min-w-0 m-0">
            <span className="font-semibold text-[color:oklch(0.47_0.085_68)]">
              {t('raw.lutContract.inputTerm')}
            </span>
            <span className="min-w-0 overflow-wrap-anywhere font-medium text-[color:--color-raw-ink]">
              {resolvedProfile.label}
            </span>
          </p>
          {outputLabel && (
            <p className="grid grid-cols-[4.9rem_minmax(0,1fr)] gap-2 min-w-0 m-0">
              <span className="font-semibold text-[color:oklch(0.47_0.085_68)]">
                {t('raw.lutContract.outputTerm')}
              </span>
              <span className="min-w-0 overflow-wrap-anywhere font-medium text-[color:--color-raw-ink]">
                {outputLabel}
              </span>
            </p>
          )}
          {needsOutputContract && (
            <p className="m-0 rounded-lg border border-[color:oklch(0.78_0.16_63_/_0.38)] p-2.5 text-[0.72rem] leading-snug text-[color:--color-raw-ink-soft] bg-gradient-to-b from-[color:oklch(0.93_0.05_78_/_0.78)] to-[color:--color-raw-amber-soft]">
              {t('raw.lutContract.needsOutput')}
            </p>
          )}
        </div>
      ) : null}

      <button
        ref={triggerRef}
        type="button"
        className="inline-flex min-h-[34px] items-center justify-center gap-1.5 rounded-lg border border-[color:oklch(0.72_0.05_78_/_0.78)] bg-[color:oklch(0.934_0.03_84_/_0.92)] px-[11px] py-1.5 text-[0.72rem] font-semibold text-[color:--color-raw-ink] transition-all duration-150 hover:border-[color:oklch(0.56_0.12_153_/_0.5)] hover:bg-[color:oklch(0.9_0.05_84_/_0.95)] hover:text-[color:--color-raw-green-deep] hover:-translate-y-px focus-visible:outline-2 focus-visible:outline-[color:--color-raw-green] focus-visible:outline-offset-2"
        aria-controls={browserId}
        aria-expanded={browserOpen}
        aria-haspopup="dialog"
        onClick={() => {
          if (browserOpen) {
            handleClose({ restoreFocus: true })
          } else {
            setBrowserOpen(true)
          }
        }}
      >
        <SlidersHorizontal aria-hidden="true" />
        {t('raw.lutContract.change')}
      </button>

      <LUTContractBrowser
        open={browserOpen}
        onClose={handleClose}
        suggestions={suggestions}
        currentProfile={resolvedProfile}
        onSelect={onSelect}
        triggerRef={triggerRef}
        browserId={browserId}
      />
    </div>
  )
}

function LutIconButton({
  label,
  busy,
  disabled,
  ariaControls,
  ariaExpanded,
  ariaHasPopup,
  buttonRef,
  onClick,
  children,
}: {
  label: string
  busy?: boolean
  disabled?: boolean
  ariaControls?: string
  ariaExpanded?: boolean
  ariaHasPopup?: 'dialog'
  buttonRef?: Ref<HTMLButtonElement>
  onClick?: () => void
  children: ReactNode
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      aria-busy={busy || undefined}
      aria-controls={ariaControls}
      aria-expanded={ariaExpanded}
      aria-haspopup={ariaHasPopup}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={
        busy
          ? 'inline-flex size-8 items-center justify-center rounded-lg border border-[color:oklch(0.74_0.035_78_/_0.72)] bg-[color:oklch(0.964_0.018_86_/_0.76)] text-[color:--color-raw-ink-soft] transition-all duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] hover:not-disabled:border-[color:oklch(0.59_0.15_153_/_0.58)] hover:not-disabled:bg-[color:oklch(0.59_0.15_153_/_0.1)] hover:not-disabled:text-[color:--color-raw-green-deep] hover:not-disabled:-translate-y-px disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-[color:--color-raw-green] focus-visible:outline-offset-2 [&_svg]:animate-spin'
          : 'inline-flex size-8 items-center justify-center rounded-lg border border-[color:oklch(0.74_0.035_78_/_0.72)] bg-[color:oklch(0.964_0.018_86_/_0.76)] text-[color:--color-raw-ink-soft] transition-all duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] hover:not-disabled:border-[color:oklch(0.59_0.15_153_/_0.58)] hover:not-disabled:bg-[color:oklch(0.59_0.15_153_/_0.1)] hover:not-disabled:text-[color:--color-raw-green-deep] hover:not-disabled:-translate-y-px disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-[color:--color-raw-green] focus-visible:outline-offset-2'
      }
    >
      {children}
    </button>
  )
}

function OnlineLutSourceControls({
  onlineLutSources,
}: {
  onlineLutSources: UseOnlineLutSourcesResult
}) {
  const { t } = useI18n()
  const sourceInputId = useId()
  const browserId = useId()
  const { state } = onlineLutSources
  const [openResourceId, setOpenResourceId] = useState<string | null>(null)
  const [browserLayout, setBrowserLayout] =
    useState<OnlineLutBrowserLayout | null>(null)
  const openButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const resourcesById = useMemo(
    () => new Map(state.resources.map((resource) => [resource.id, resource])),
    [state.resources],
  )
  const entriesByResourceId = useMemo(() => {
    const entries = new Map<string, OnlineLutSourceEntries>()

    for (const resource of state.resources) {
      entries.set(resource.id, [])
    }

    for (const entry of state.entries) {
      entries.set(entry.resourceId, [
        ...(entries.get(entry.resourceId) ?? []),
        entry,
      ])
    }

    return entries
  }, [state.entries, state.resources])
  const issuesByResourceId = useMemo(() => {
    const issues = new Map<string, OnlineLutSourceIssues>()

    for (const issue of state.issues) {
      if (!issue.resourceId) continue

      issues.set(issue.resourceId, [
        ...(issues.get(issue.resourceId) ?? []),
        issue,
      ])
    }

    return issues
  }, [state.issues])
  const openResource = openResourceId
    ? resourcesById.get(openResourceId)
    : undefined
  const openEntries = openResourceId
    ? (entriesByResourceId.get(openResourceId) ?? [])
    : []
  const openIssues = openResourceId
    ? (issuesByResourceId.get(openResourceId) ?? [])
    : []
  const closeBrowser = useCallback(
    (resourceId = openResourceId, options: { restoreFocus?: boolean } = {}) => {
      setOpenResourceId(null)
      setBrowserLayout(null)

      if (options.restoreFocus && resourceId) {
        queueMicrotask(() => openButtonRefs.current.get(resourceId)?.focus())
      }
    },
    [openResourceId],
  )
  const openBrowserForResource = useCallback((resourceId: string) => {
    const trigger = openButtonRefs.current.get(resourceId)
    if (!trigger) return

    setBrowserLayout(getViewportBoundedBrowserLayout(trigger))
    setOpenResourceId(resourceId)
  }, [])
  const updateBrowserLayout = useCallback(() => {
    if (!openResourceId) return

    setBrowserLayout(
      getViewportBoundedBrowserLayout(
        openButtonRefs.current.get(openResourceId),
      ),
    )
  }, [openResourceId])

  useEffect(() => {
    if (!openResourceId) return

    if (!resourcesById.has(openResourceId)) {
      closeBrowser(openResourceId)
    }
  }, [closeBrowser, openResourceId, resourcesById])

  useLayoutEffect(() => {
    updateBrowserLayout()
  }, [updateBrowserLayout, openEntries.length, openIssues.length])

  useEffect(() => {
    if (!openResourceId) return

    const handleViewportChange = () => {
      updateBrowserLayout()
    }
    const trigger = openButtonRefs.current.get(openResourceId)
    const scrollTargets = [
      trigger?.closest('.raw-tool-stack'),
      trigger?.closest('.raw-tool-surface'),
    ].filter((target): target is Element => target instanceof Element)

    window.addEventListener('resize', handleViewportChange)
    for (const target of scrollTargets) {
      target.addEventListener('scroll', handleViewportChange)
    }

    return () => {
      window.removeEventListener('resize', handleViewportChange)
      for (const target of scrollTargets) {
        target.removeEventListener('scroll', handleViewportChange)
      }
    }
  }, [openResourceId, updateBrowserLayout])

  const formatEntryCount = (count: number) =>
    count === 1
      ? t('raw.lutSource.countOne')
      : count > 1
        ? t('raw.lutSource.countMany', { count })
        : t('raw.lutSource.countZero')
  const openBrowser =
    openResource &&
    browserLayout &&
    (() => {
      return (
        <LutBrowserDialog
          open={Boolean(openResource)}
          layout={browserLayout}
          id={browserId}
          kind="source"
          className="grid-rows-[auto_minmax(0,1fr)]"
          headingClassName=""
          dialogLabel={`${openResource.label} LUTs`}
          title={openResource.label}
          description={formatEntryCount(openEntries.length)}
          closeLabel={t('raw.lutSource.close')}
          restoreFocus={() =>
            openButtonRefs.current.get(openResource.id)?.focus()
          }
          triggerElement={openButtonRefs.current.get(openResource.id)}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) {
              closeBrowser(openResource.id, { restoreFocus: true })
            }
          }}
        >
          <div
            className="grid self-stretch min-h-0 gap-1.5 overflow-y-auto overscroll-contain pr-0.5 [scrollbar-color:var(--color-raw-scrollbar-thumb)_transparent] [scrollbar-width:thin]"
            data-lut-source-scroll="internal"
          >
            {openEntries.length > 0 ? (
              (() => {
                const familyGroups = new Map<string, typeof openEntries>()
                const ungrouped: typeof openEntries = []

                for (const entry of openEntries) {
                  if (entry.family) {
                    const group = familyGroups.get(entry.family)
                    if (group) {
                      group.push(entry)
                    } else {
                      familyGroups.set(entry.family, [entry])
                    }
                  } else {
                    ungrouped.push(entry)
                  }
                }

                const renderEntry = (entry: (typeof openEntries)[number]) => (
                  <div
                    key={entry.id}
                    className="grid grid-cols-[minmax(0,1fr)_32px] items-center gap-1.5 min-w-0 rounded-lg border border-[color:oklch(0.74_0.035_78_/_0.46)] bg-[color:oklch(0.964_0.018_86_/_0.36)] p-1.5"
                  >
                    <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[0.74rem] font-medium text-[color:--color-raw-ink]">
                      {entry.title}
                    </span>
                    <LutIconButton
                      label={t('raw.lutSource.load', { label: entry.title })}
                      onClick={() => void onlineLutSources.loadEntry(entry.id)}
                    >
                      <Download aria-hidden="true" />
                    </LutIconButton>
                  </div>
                )

                return (
                  <>
                    {Array.from(familyGroups, ([family, entries]) => (
                      <div key={family} className="grid gap-1.5">
                        <div className="m-0 text-[0.68rem] font-semibold uppercase text-[color:--color-raw-ink-soft]">
                          {family}
                        </div>
                        {entries.map(renderEntry)}
                      </div>
                    ))}
                    {ungrouped.length > 0 && (
                      <div className="grid gap-1.5">
                        <div className="m-0 text-[0.68rem] font-semibold uppercase text-[color:--color-raw-ink-soft]">
                          {t('raw.lutSource.others')}
                        </div>
                        {ungrouped.map(renderEntry)}
                      </div>
                    )}
                  </>
                )
              })()
            ) : (
              <p className="m-0 text-[0.72rem] leading-snug text-[color:--color-raw-ink-soft]">
                {openIssues.length > 0
                  ? t('raw.lutSource.noneCompatible')
                  : t('raw.lutSource.noneYet')}
              </p>
            )}
          </div>
        </LutBrowserDialog>
      )
    })()

  return (
    <div className="grid gap-2 min-w-0 mb-2.5">
      <div className="grid grid-cols-[minmax(0,1fr)_32px_32px] gap-1.5 min-w-0">
        <label htmlFor={sourceInputId} className="sr-only">
          {t('raw.lutSource.url')}
        </label>
        <Input
          id={sourceInputId}
          type="url"
          value={onlineLutSources.sourceUrlInput}
          placeholder="https://.../catalog.json"
          onChange={(event) =>
            onlineLutSources.setSourceUrlInput(event.currentTarget.value)
          }
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              onlineLutSources.sourceUrlInput.trim()
            ) {
              event.preventDefault()
              void onlineLutSources.addSourceFromInput()
            }
          }}
          inputClassName="border-[color:oklch(0.7_0.04_78_/_0.74)] bg-[color:oklch(0.948_0.022_86_/_0.9)] text-[color:--color-raw-ink] shadow-none placeholder:text-[color:oklch(0.5_0.035_75_/_0.72)] focus:border-[color:oklch(0.5_0.12_153_/_0.86)] focus:shadow-[0_0_0_2px_oklch(0.59_0.15_153_/_0.16)] h-8 text-xs"
        />
        <LutIconButton
          label={t('raw.lutSource.add')}
          disabled={!onlineLutSources.sourceUrlInput.trim()}
          onClick={() => void onlineLutSources.addSourceFromInput()}
        >
          <Plus aria-hidden="true" />
        </LutIconButton>
        <LutIconButton
          label={t('raw.lutSource.copy')}
          disabled={!onlineLutSources.share.enabled}
          onClick={() => void onlineLutSources.share.copy()}
        >
          <Share2 aria-hidden="true" />
        </LutIconButton>
      </div>

      {state.resources.length > 0 && (
        <div className="grid gap-1.5 min-w-0">
          {state.resources.map((resource) => {
            const isResourceLoading =
              state.isLoading && state.activeResourceId === resource.id
            const entries = entriesByResourceId.get(resource.id) ?? []
            const hasIssue =
              (issuesByResourceId.get(resource.id) ?? []).length > 0
            const isOpen = openResourceId === resource.id

            return (
              <div
                key={resource.id}
                className="grid min-w-0 py-1.5 border-t border-[color:oklch(0.74_0.035_78_/_0.52)]"
              >
                <div
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 min-w-0"
                  data-lut-resource-row
                >
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[0.72rem] font-semibold text-[color:--color-raw-green-deep]">
                      {resource.label}
                    </span>
                    <span className="shrink-0 rounded-full border border-[color:oklch(0.74_0.035_78_/_0.58)] bg-[color:oklch(0.964_0.018_86_/_0.62)] px-1.5 py-0.5 text-[0.64rem] font-bold leading-tight text-[color:--color-raw-ink-soft]">
                      {formatEntryCount(entries.length)}
                    </span>
                    {isResourceLoading && (
                      <span className="shrink-0 rounded-full border border-[color:oklch(0.59_0.15_153_/_0.3)] bg-[color:oklch(0.59_0.15_153_/_0.1)] px-1.5 py-0.5 text-[0.64rem] font-bold leading-tight text-[color:--color-raw-green-deep]">
                        {t('raw.lutSource.loading')}
                      </span>
                    )}
                    {hasIssue && (
                      <span className="shrink-0 rounded-full border border-[color:oklch(0.63_0.16_55_/_0.34)] bg-[color:oklch(0.72_0.15_72_/_0.13)] px-1.5 py-0.5 text-[0.64rem] font-bold leading-tight text-[color:oklch(0.42_0.095_57)]">
                        {t('raw.lutSource.issue')}
                      </span>
                    )}
                  </div>
                  <div className="flex gap-1">
                    <LutIconButton
                      label={t('raw.lutSource.open', {
                        label: resource.label,
                      })}
                      ariaControls={browserId}
                      ariaExpanded={isOpen}
                      ariaHasPopup="dialog"
                      buttonRef={(node) => {
                        if (node) {
                          openButtonRefs.current.set(resource.id, node)
                        } else {
                          openButtonRefs.current.delete(resource.id)
                        }
                      }}
                      onClick={() =>
                        isOpen
                          ? closeBrowser(resource.id, { restoreFocus: true })
                          : openBrowserForResource(resource.id)
                      }
                    >
                      <FolderOpen aria-hidden="true" />
                    </LutIconButton>
                    <LutIconButton
                      label={t('raw.lutSource.refresh', {
                        label: resource.label,
                      })}
                      busy={isResourceLoading}
                      onClick={() =>
                        void onlineLutSources.refreshSource(resource.id)
                      }
                    >
                      <RefreshCw aria-hidden="true" />
                    </LutIconButton>
                    <LutIconButton
                      label={t('raw.lutSource.remove', {
                        label: resource.label,
                      })}
                      onClick={() => {
                        if (isOpen) closeBrowser(resource.id)
                        onlineLutSources.removeSource(resource.id)
                      }}
                    >
                      <Trash2 aria-hidden="true" />
                    </LutIconButton>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {openBrowser}

      {state.issues.length > 0 && (
        <div className="grid gap-1" role="status" aria-live="polite">
          {state.issues.slice(-2).map((issue, index) => (
            <p
              className="m-0 text-[0.7rem] leading-snug text-[color:--color-raw-ink-soft]"
              key={[
                issue.code,
                issue.resourceId ?? issue.raw ?? 'source',
                issue.entryId ?? issue.sourceUrl ?? issue.message,
                index,
              ].join(':')}
            >
              {issue.message}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

export function LutContractTool({
  currentLutName,
  disabled,
  onLutLoad,
  onLutClear,
  lutProfileSelection,
  lutProfileResolution,
  onLutProfileSelect,
  onlineLutSources,
}: {
  currentLutName?: string | null
  disabled: boolean
  onLutLoad: (files: File[]) => void
  onLutClear: () => void
  lutProfileSelection?: LUTProfileSelectionState | null
  lutProfileResolution?: LUTProfileResolution | null
  onLutProfileSelect: (profile: LUTColorProfile) => void
  onlineLutSources?: UseOnlineLutSourcesResult
}) {
  const { t } = useI18n()

  return (
    <ToolSection
      title={t('raw.lutContract.title')}
      eyebrow={t('raw.lutContract.eyebrow')}
    >
      {onlineLutSources && (
        <OnlineLutSourceControls onlineLutSources={onlineLutSources} />
      )}
      <LutDropzone
        onFileDrop={onLutLoad}
        currentLut={currentLutName}
        onClear={onLutClear}
        disabled={disabled}
      />
      {currentLutName ? (
        <LUTProfileStatus
          key={lutProfileSelection?.fingerprint ?? currentLutName}
          selection={lutProfileSelection}
          resolution={lutProfileResolution}
          onSelect={onLutProfileSelect}
        />
      ) : (
        <p className="raw-tool-note">{t('raw.lutContract.empty')}</p>
      )}
    </ToolSection>
  )
}

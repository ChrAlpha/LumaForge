import type { HSLBandId, HSLBandShift } from '@lumaforge/luma-color-runtime'
import { m } from 'motion/react'
import type { ComponentProps, ReactNode } from 'react'

import { surfaceFade } from '~/lib/spring'

import { useRawToolAdjustments } from '../../hooks/useRawToolState'
import type { RawTransformFeature } from '../../hooks/useRawTransformFeature'
import type { ToolAvailability } from '../../services/surface/derive-tool-availability'
import type { ColorValue } from '../color-fields'
import type { ToneValue } from '../tone-fields'
import type { ScrubFieldId } from './AdjustListPanel'
import { AdjustListPanel } from './AdjustListPanel'
import type { MobileLookView, MobileMode } from './mobile-stage-layout'
import { isMobileListDeck } from './mobile-stage-layout'
import type { MobileLookControls } from './MobileLookDeck'
import { MobileLookDeck } from './MobileLookDeck'
import { MobileModeDock } from './MobileModeDock'
import { TransformListPanel } from './TransformListPanel'

export function MobileLabModeDock({
  transform,
  availability,
  mode,
  exportOpen,
  panelVisibleWhileDisabled,
  expanded,
  disabled,
  scrubbing,
  prefersReduced,
  lutBrowser,
  exportPanel,
  onModeChange,
  onCollapse,
  onToneChange,
  onToneReset,
  onColorChange,
  onColorReset,
  onSelectiveColorChange,
  onSelectiveColorReset,
  onScrubChange,
  onOpenLutBrowser,
  lookView,
  onLookViewChange,
  deckHeight,
  onTabBarHeightChange,
  onDeckNaturalHeightChange,
}: {
  transform?: RawTransformFeature
  /**
   * The mobile action policy the panels read. Reaching the deck at all is
   * gated separately, by `disabled`.
   */
  availability: ToolAvailability
  mode: MobileMode
  /** The export panel holds the deck instead of the active tool's panel. */
  exportOpen: boolean
  /**
   * The export panel keeps the deck while the tools are disabled: a running
   * export's progress, or the delivered result while the preview is released.
   */
  panelVisibleWhileDisabled?: boolean
  expanded: boolean
  disabled: boolean
  scrubbing: boolean
  prefersReduced: boolean
  lutBrowser: MobileLookControls
  exportPanel: ReactNode
  onModeChange: (mode: MobileMode) => void
  onCollapse: () => void
  onToneChange: (patch: Partial<ToneValue>) => void
  onToneReset: () => void
  onColorChange: (patch: Partial<ColorValue>) => void
  onColorReset: () => void
  onSelectiveColorChange: (
    band: HSLBandId,
    shift: Partial<HSLBandShift>,
  ) => void
  onSelectiveColorReset: () => void
  onScrubChange: (field: ScrubFieldId | null) => void
  onOpenLutBrowser: () => void
  lookView: MobileLookView
  onLookViewChange: (view: MobileLookView) => void
  deckHeight?: number
  onTabBarHeightChange?: (height: number) => void
  onDeckNaturalHeightChange?: (height: number) => void
}) {
  return (
    <MobileModeDock
      showTransform={Boolean(transform)}
      mode={mode}
      exportOpen={exportOpen}
      panelVisibleWhileDisabled={panelVisibleWhileDisabled}
      expanded={expanded}
      disabled={disabled}
      onModeChange={onModeChange}
      onCollapse={onCollapse}
      scrubbing={scrubbing}
      lookView={lookView}
      deckHeight={deckHeight}
      onTabBarHeightChange={onTabBarHeightChange}
      onDeckNaturalHeightChange={onDeckNaturalHeightChange}
      panel={
        <m.div
          key={exportOpen ? 'export' : mode}
          // List tools fill the deck so their panels can h-full down and
          // run their own internal scroll. Other panels flow at their
          // natural height, which sizes the deck.
          className={
            isMobileListDeck(mode, exportOpen, lookView) ? 'h-full' : undefined
          }
          initial={{ opacity: 0, y: prefersReduced ? 0 : 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={surfaceFade}
        >
          {exportOpen ? (
            exportPanel
          ) : (
            <MobileLabModePanel
              transform={transform}
              availability={availability}
              mode={mode}
              lutBrowser={lutBrowser}
              scrubbing={scrubbing}
              onToneChange={onToneChange}
              onToneReset={onToneReset}
              onColorChange={onColorChange}
              onColorReset={onColorReset}
              onSelectiveColorChange={onSelectiveColorChange}
              onSelectiveColorReset={onSelectiveColorReset}
              onScrubChange={onScrubChange}
              onOpenLutBrowser={onOpenLutBrowser}
              lookView={lookView}
              onLookViewChange={onLookViewChange}
            />
          )}
        </m.div>
      }
    />
  )
}

function MobileLabModePanel({
  transform,
  availability,
  mode,
  lutBrowser,
  scrubbing,
  onToneChange,
  onToneReset,
  onColorChange,
  onColorReset,
  onSelectiveColorChange,
  onSelectiveColorReset,
  onScrubChange,
  onOpenLutBrowser,
  lookView,
  onLookViewChange,
}: {
  transform?: RawTransformFeature
  availability: ToolAvailability
  mode: MobileMode
  lutBrowser: MobileLookControls
  scrubbing: boolean
  onToneChange: (patch: Partial<ToneValue>) => void
  onToneReset: () => void
  onColorChange: (patch: Partial<ColorValue>) => void
  onColorReset: () => void
  onSelectiveColorChange: (
    band: HSLBandId,
    shift: Partial<HSLBandShift>,
  ) => void
  onSelectiveColorReset: () => void
  onScrubChange: (field: ScrubFieldId | null) => void
  onOpenLutBrowser: () => void
  lookView: MobileLookView
  onLookViewChange: (view: MobileLookView) => void
}) {
  if (mode === 'transform') {
    return transform ? (
      <TransformListPanel
        feature={transform}
        availability={availability}
        scrubbing={scrubbing}
        onScrubChange={onScrubChange}
      />
    ) : null
  }

  if (mode === 'tone') {
    return (
      <MobileAdjustPanel
        onToneChange={onToneChange}
        onColorChange={onColorChange}
        onSelectiveColorChange={onSelectiveColorChange}
        onToneReset={onToneReset}
        onColorReset={onColorReset}
        onSelectiveColorReset={onSelectiveColorReset}
        onScrubChange={onScrubChange}
        scrubbing={scrubbing}
      />
    )
  }

  return (
    <MobileLookDeck
      look={lutBrowser}
      onOpenSources={onOpenLutBrowser}
      view={lookView}
      onViewChange={onLookViewChange}
      onScrubChange={onScrubChange}
    />
  )
}

/**
 * The Adjust list over the adjustments it edits. It reads them itself, so a
 * scrub step renders the list and leaves the dock and the chrome alone.
 */
function MobileAdjustPanel(
  props: Omit<
    ComponentProps<typeof AdjustListPanel>,
    'tone' | 'color' | 'selectiveColor'
  >,
) {
  const { tone, color, selectiveColor } = useRawToolAdjustments()
  return (
    <AdjustListPanel
      tone={tone}
      color={color}
      selectiveColor={selectiveColor}
      {...props}
    />
  )
}

import type { HSLBandId, HSLBandShift } from '@lumaforge/luma-color-runtime'
import { m } from 'motion/react'
import type { ReactNode } from 'react'

import { surfaceFade } from '~/lib/spring'

import type { ColorValue } from '../color-fields'
import type { ToneValue } from '../tone-fields'
import type { HSLToolValue } from '../tools/HSLTool'
import type { ScrubFieldId } from './AdjustListPanel'
import { AdjustListPanel } from './AdjustListPanel'
import { MobileComparePanel } from './MobileComparePanel'
import { MobileLookPanel } from './MobileLookPanel'
import type { MobileLutBrowserProps } from './MobileLutBrowser'
import type { MobileMode } from './MobileModeDock'
import { MobileModeDock } from './MobileModeDock'

export function MobileLabModeDock({
  mode,
  expanded,
  disabled,
  scrubbing,
  prefersReduced,
  tone,
  color,
  selectiveColor,
  lutBrowser,
  compareSplitOpen,
  exportPanel,
  onModeChange,
  onCollapse,
  onOpenMore,
  onToneChange,
  onToneReset,
  onColorChange,
  onColorReset,
  onSelectiveColorChange,
  onSelectiveColorReset,
  onScrubChange,
  onOpenLutBrowser,
  onOpenLutContractBrowser,
  onCompareReset,
  onSplitOpenChange,
  onInsetChange,
}: {
  mode: MobileMode
  expanded: boolean
  disabled: boolean
  scrubbing: boolean
  prefersReduced: boolean
  tone: ToneValue
  color: ColorValue
  selectiveColor: HSLToolValue | undefined
  lutBrowser: Omit<MobileLutBrowserProps, 'open' | 'onClose'>
  compareSplitOpen: boolean
  exportPanel: ReactNode
  onModeChange: (mode: MobileMode) => void
  onCollapse: () => void
  onOpenMore: () => void
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
  onOpenLutContractBrowser: () => void
  onCompareReset: () => void
  onSplitOpenChange: (open: boolean) => void
  onInsetChange?: (inset: number) => void
}) {
  return (
    <MobileModeDock
      mode={mode}
      expanded={expanded}
      disabled={disabled}
      onModeChange={onModeChange}
      onCollapse={onCollapse}
      onOpenMore={onOpenMore}
      canExport
      scrubbing={scrubbing}
      onInsetChange={onInsetChange}
      panel={
        <m.div
          key={mode}
          // Tone needs the wrapper to fill the dock so AdjustListPanel can
          // h-full down and run its own internal scroll. Other modes flow
          // at content-derived height.
          className={mode === 'tone' ? 'h-full' : undefined}
          initial={{ opacity: 0, y: prefersReduced ? 0 : 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={surfaceFade}
        >
          <MobileLabModePanel
            mode={mode}
            tone={tone}
            color={color}
            selectiveColor={selectiveColor}
            lutBrowser={lutBrowser}
            compareSplitOpen={compareSplitOpen}
            exportPanel={exportPanel}
            scrubbing={scrubbing}
            onToneChange={onToneChange}
            onToneReset={onToneReset}
            onColorChange={onColorChange}
            onColorReset={onColorReset}
            onSelectiveColorChange={onSelectiveColorChange}
            onSelectiveColorReset={onSelectiveColorReset}
            onScrubChange={onScrubChange}
            onOpenLutBrowser={onOpenLutBrowser}
            onOpenLutContractBrowser={onOpenLutContractBrowser}
            onCompareReset={onCompareReset}
            onSplitOpenChange={onSplitOpenChange}
          />
        </m.div>
      }
    />
  )
}

function MobileLabModePanel({
  mode,
  tone,
  color,
  selectiveColor,
  lutBrowser,
  compareSplitOpen,
  exportPanel,
  scrubbing,
  onToneChange,
  onToneReset,
  onColorChange,
  onColorReset,
  onSelectiveColorChange,
  onSelectiveColorReset,
  onScrubChange,
  onOpenLutBrowser,
  onOpenLutContractBrowser,
  onCompareReset,
  onSplitOpenChange,
}: {
  mode: MobileMode
  tone: ToneValue
  color: ColorValue
  selectiveColor: HSLToolValue | undefined
  lutBrowser: Omit<MobileLutBrowserProps, 'open' | 'onClose'>
  compareSplitOpen: boolean
  exportPanel: ReactNode
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
  onOpenLutContractBrowser: () => void
  onCompareReset: () => void
  onSplitOpenChange: (open: boolean) => void
}) {
  if (mode === 'tone') {
    return (
      <AdjustListPanel
        tone={tone}
        color={color}
        selectiveColor={selectiveColor}
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

  if (mode === 'look') {
    return (
      <MobileLookPanel
        lutBrowser={lutBrowser}
        onOpenLutBrowser={onOpenLutBrowser}
        onOpenLutContractBrowser={onOpenLutContractBrowser}
      />
    )
  }

  if (mode === 'compare') {
    return (
      <MobileComparePanel
        splitOpen={compareSplitOpen}
        onCompareReset={onCompareReset}
        onSplitOpenChange={onSplitOpenChange}
      />
    )
  }

  return exportPanel
}

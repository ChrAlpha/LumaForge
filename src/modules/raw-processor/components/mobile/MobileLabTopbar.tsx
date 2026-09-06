import {
  ImageUp,
  Info,
  LockKeyhole,
  RotateCcw,
  ShieldCheck,
  Wand2,
} from 'lucide-react'

import { useI18n } from '~/lib/i18n'

import type { SupportLevel } from '../../model/session'
import { MobileTopbar } from './MobileTopbar'

export function MobileLabTopbar({
  hasImage,
  fileName,
  fileMeta,
  supportLevel,
  histogramShown,
  onToggleHistogram,
  onReplaceFile,
  onOpenLutBrowser,
  onOpenMore,
  onResetSession,
  scrubbing,
  onHeightChange,
}: {
  hasImage: boolean
  fileName: string
  fileMeta: string
  supportLevel: Extract<SupportLevel, 'official' | 'experimental'>
  histogramShown: boolean
  onToggleHistogram: () => void
  onReplaceFile: () => void
  onOpenLutBrowser: () => void
  onOpenMore: () => void
  onResetSession: () => void
  scrubbing?: boolean
  onHeightChange?: (height: number) => void
}) {
  const { t } = useI18n()

  return (
    <MobileTopbar
      onHeightChange={onHeightChange}
      hasImage={hasImage}
      fileName={fileName}
      fileMeta={fileMeta}
      supportLevel={supportLevel}
      histogramShown={histogramShown}
      onToggleHistogram={onToggleHistogram}
      scrubbing={scrubbing}
      moreMenuItems={[
        {
          kind: 'item',
          icon: ImageUp,
          label: t('raw.mobile.more.replace'),
          onSelect: onReplaceFile,
        },
        {
          kind: 'item',
          icon: Wand2,
          label: t('raw.mobile.more.addLut'),
          onSelect: onOpenLutBrowser,
        },
        {
          kind: 'item',
          icon: Info,
          label: t('raw.mobile.more.fileDetails'),
          onSelect: onOpenMore,
        },
        { kind: 'separator' },
        {
          kind: 'item',
          icon: RotateCcw,
          label: t('raw.mobile.more.reset'),
          onSelect: onResetSession,
        },
        { kind: 'separator' },
        {
          kind: 'item',
          icon: LockKeyhole,
          label: t('raw.mobile.more.browserLocal'),
          onSelect: () => {},
          disabled: true,
        },
        {
          kind: 'item',
          icon: ShieldCheck,
          label: t('raw.mobile.more.officialSupport'),
          onSelect: () => {},
          disabled: true,
        },
      ]}
    />
  )
}

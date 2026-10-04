import { BarChart3, ImageUp, Info, Languages, RotateCcw } from 'lucide-react'
import type { ReactNode } from 'react'

import { useI18n } from '~/lib/i18n'

import type { SupportLevel } from '../../model/session'
import type { MobileMoreMenuItem } from './MobileMoreMenu'
import { MobileTopbar } from './MobileTopbar'

export function MobileLabTopbar({
  hasImage,
  fileName,
  fileMeta,
  supportLevel,
  histogramShown,
  onToggleHistogram,
  onReplaceFile,
  onOpenMore,
  onResetSession,
  exportAction,
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
  onOpenMore: () => void
  onResetSession: () => void
  exportAction?: ReactNode
  scrubbing?: boolean
  onHeightChange?: (height: number) => void
}) {
  const { t, toggleLocale } = useI18n()

  // Same switch as the shared LocaleToggle; it lives here so the topbar's
  // meta line keeps room for the camera name.
  const language: MobileMoreMenuItem = {
    kind: 'item',
    icon: Languages,
    label: t('raw.mobile.more.language'),
    detail: t('raw.mobile.more.languageCurrent'),
    onSelect: toggleLocale,
  }

  // File actions only exist once a RAW is open. Reset is destructive, so it
  // sits last behind a separator. LUT import lives in the Look tool.
  const moreMenuItems: MobileMoreMenuItem[] = hasImage
    ? [
        {
          kind: 'item',
          icon: ImageUp,
          label: t('raw.mobile.more.replace'),
          onSelect: onReplaceFile,
        },
        {
          kind: 'item',
          icon: Info,
          label: t('raw.mobile.more.fileDetails'),
          onSelect: onOpenMore,
        },
        {
          kind: 'checkbox',
          icon: BarChart3,
          label: t('raw.histogram.title'),
          checked: histogramShown,
          onCheckedChange: onToggleHistogram,
        },
        language,
        { kind: 'separator' },
        {
          kind: 'item',
          icon: RotateCcw,
          label: t('raw.mobile.more.reset'),
          onSelect: onResetSession,
          tone: 'destructive',
        },
      ]
    : [language]

  return (
    <MobileTopbar
      onHeightChange={onHeightChange}
      hasImage={hasImage}
      fileName={fileName}
      fileMeta={fileMeta}
      supportLevel={supportLevel}
      exportAction={exportAction}
      scrubbing={scrubbing}
      moreMenuItems={moreMenuItems}
    />
  )
}

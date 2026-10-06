import { useI18n } from '~/lib/i18n'

import type { SupportLevel } from '../model/session'

export function SupportBadge({ level }: { level: SupportLevel }) {
  const { t } = useI18n()

  return (
    <span
      className={
        level === 'unsupported'
          ? 'rounded-full bg-red/10 px-2 py-1 text-xs text-red'
          : 'rounded-full bg-yellow/10 px-2 py-1 text-xs text-yellow'
      }
    >
      {level === 'unsupported'
        ? t('raw.support.unsupported')
        : t('raw.support.experimental')}
    </span>
  )
}

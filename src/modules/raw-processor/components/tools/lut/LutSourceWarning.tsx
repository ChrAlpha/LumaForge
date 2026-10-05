import { AlertTriangle } from 'lucide-react'

import type { ChipSurface } from '~/components/ui/chip'
import { Chip } from '~/components/ui/chip'
import { clsxm } from '~/lib/cn'
import { useI18n } from '~/lib/i18n'

import type { OnlineLUTSourceIssue } from '../../../services/look/online-lut-sources'
import { summarizeLutIssues } from './lut-issue-copy'

// A source's issues collapse to one demoted, width-safe warning line. The
// wrapper and chip both carry `min-w-0` so the truncating message can shrink:
// without it the chip's grid item keeps `min-width: auto`, which resolves to the
// message's content size and forces the whole LUT column wider than its track.
export function LutSourceWarning({
  issues,
  surface = 'paper',
  tone = 'amber',
  className,
}: {
  issues: readonly OnlineLUTSourceIssue[]
  surface?: ChipSurface
  /**
   * `neutral` states a source problem in plain ink, for surfaces that keep
   * amber for colour contracts alone (mobile LUT sources).
   */
  tone?: 'amber' | 'neutral'
  className?: string
}) {
  const { t } = useI18n()
  const summary = summarizeLutIssues(issues)
  if (!summary) return null

  const extra = summary.count - 1

  return (
    <div
      className={clsxm('grid min-w-0', className)}
      role="status"
      aria-live="polite"
      data-raw-lut="source-warning"
    >
      <Chip
        tone={tone}
        surface={surface}
        size="sm"
        className="min-w-0 max-w-full normal-case tracking-normal"
      >
        <AlertTriangle aria-hidden="true" className="size-3 shrink-0" />
        <span className="min-w-0 truncate">{t(summary.messageKey)}</span>
        {extra > 0 && (
          <span className="shrink-0 tabular-nums opacity-70">
            {t('raw.lutSource.issues.more', { count: extra })}
          </span>
        )}
      </Chip>
    </div>
  )
}

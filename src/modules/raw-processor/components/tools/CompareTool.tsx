import { RotateCcw } from 'lucide-react'
import { memo } from 'react'

import { Button } from '~/components/ui/button'
import { useI18n } from '~/lib/i18n'

export const CompareTool = memo(
  ({
    disabled,
    onCompareReset,
  }: {
    disabled: boolean
    onCompareReset: () => void
  }) => {
    const { t } = useI18n()

    return (
      <div className="grid gap-3">
        <p className="text-[0.78rem] leading-relaxed text-lf-on-surface/72">
          {t('raw.compare.note')}
        </p>
        <Button
          type="button"
          variant="light"
          size="sm"
          disabled={disabled}
          onClick={onCompareReset}
          className="self-start [&_svg]:size-3.5"
        >
          <RotateCcw aria-hidden="true" />
          {t('raw.compare.reset')}
        </Button>
      </div>
    )
  },
)

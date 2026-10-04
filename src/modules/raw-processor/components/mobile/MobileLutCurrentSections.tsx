import { Plus } from 'lucide-react'

import { useI18n } from '~/lib/i18n'

import { Dropzone } from '../Dropzone'
import type { StrengthLevel } from '../tools/StrengthControl'
import { StrengthControl } from '../tools/StrengthControl'

export function MobileLutCurrentSections({
  currentLutName,
  disabled,
  onLutLoad,
  onLutClear,
  activeIntensity,
  onIntensitySelect,
  strengthDisabled,
}: {
  currentLutName?: string | null
  disabled: boolean
  onLutLoad: (files: File[]) => void
  onLutClear: () => void
  activeIntensity: StrengthLevel
  onIntensitySelect?: (level: StrengthLevel) => void
  strengthDisabled: boolean
}) {
  const { t } = useI18n()

  return (
    <>
      <section className="grid gap-2" data-raw-mobile-lut="current">
        <h3 className="m-0 text-lf-body font-semibold text-lf-on-photo-ink">
          {t('raw.mobile.lut.currentHeading')}
        </h3>
        <div
          className={
            currentLutName
              ? 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md border border-lf-on-photo-bord-soft bg-lf-on-photo-bg px-3 py-2.5'
              : 'grid grid-cols-1 rounded-md border border-lf-on-photo-bord-soft bg-lf-on-photo-bg px-3 py-2.5'
          }
          data-testid="raw-mobile-current-lut-card"
        >
          <Dropzone
            onFileDrop={onLutLoad}
            accept={['.cube']}
            multiple
            disabled={disabled}
            aria-label={
              currentLutName
                ? t('raw.lut.selectedAria', { name: currentLutName })
                : t('raw.mobile.lut.uploadAria')
            }
            className="flex min-h-[44px] min-w-0 items-center rounded-none border-0 border-solid bg-transparent p-0 text-left shadow-none hover:bg-transparent focus-within:ring-lf-green/80 focus-visible:ring-lf-green/80"
            interactiveMotion={false}
          >
            <span className="flex min-w-0 items-center gap-2">
              {!currentLutName && (
                <span
                  className="grid size-7 shrink-0 place-items-center rounded-md border border-lf-on-photo-bord-soft bg-lf-on-photo-bg-strong text-lf-on-photo-ink/70"
                  aria-hidden="true"
                >
                  <Plus className="size-3.5" />
                </span>
              )}
              <span
                className="min-w-0 truncate text-lf-control font-semibold text-lf-on-photo-ink"
                title={currentLutName ?? undefined}
              >
                {currentLutName ?? t('raw.lut.add')}
              </span>
            </span>
          </Dropzone>
          {currentLutName && (
            <button
              type="button"
              className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-lf-on-photo-bord-soft bg-lf-on-photo-bg-strong px-2.5 text-xs font-semibold text-lf-on-photo-ink/82 transition-colors hover:bg-[oklch(0.96_0.006_255/0.08)] hover:text-lf-on-photo-ink disabled:cursor-not-allowed disabled:opacity-50"
              disabled={disabled}
              onClick={onLutClear}
            >
              {t('raw.mobile.lut.clear')}
            </button>
          )}
        </div>
      </section>

      <section className="grid gap-2" data-raw-mobile-lut="strength">
        <h3 className="m-0 text-lf-body font-semibold text-lf-on-photo-ink">
          {t('raw.strength.title')}
        </h3>
        <StrengthControl
          value={activeIntensity}
          onChange={(level) => onIntensitySelect?.(level)}
          disabled={strengthDisabled}
          size="md"
        />
      </section>
    </>
  )
}

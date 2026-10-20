import { clsxm } from '~/lib/cn'
import type { MessageKey } from '~/lib/i18n'
import { useI18n } from '~/lib/i18n'

import { useHdrPreview } from '../../hooks/preview/useHdrPreview'
import type { HdrPreviewChoice } from '../../services/preview/hdr-preview-output'
import type { ActionAvailability } from '../../services/surface/derive-tool-availability'
import { RAW_REASON_COPY } from '../../services/surface/raw-reason'
import {
  SEGMENTED_FOCUS_RING,
  SEGMENTED_ITEM_TEXT,
  SEGMENTED_THUMB_BG,
  SEGMENTED_TRACK,
} from './segmented-chrome'

const CHOICE_LABEL = {
  sdr: 'raw.export.hdr.preview.sdr',
  hdr: 'raw.export.hdr.preview.hdr',
  'above-sdr': 'raw.export.hdr.preview.aboveSdr',
  'stop-down': 'raw.export.hdr.preview.stopDown',
} as const satisfies Record<HdrPreviewChoice, MessageKey>

// The hint says what the preview shows now, and what the file holds.
const CHOICE_HINT = {
  sdr: 'raw.export.hdr.hint',
  hdr: 'raw.export.hdr.hintHdr',
  'above-sdr': 'raw.export.hdr.hintAboveSdr',
  'stop-down': 'raw.export.hdr.hintStopDown',
} as const satisfies Record<HdrPreviewChoice, MessageKey>

// A surface that states no decision offers no views.
const UNDECIDED: ActionAvailability = { available: false, reason: null }

const DENSITY = {
  pointer: {
    item: 'h-8 text-[0.72rem]',
    active: 'text-lf-on-surface',
  },
  touch: {
    item: 'min-h-11 text-[0.76rem]',
    active: 'text-lf-on-photo-ink',
  },
} as const

/**
 * What the preview shows while the HDR gain map is on, and the hint that
 * says so. The views are offered once there is a photo whose look has the
 * HDR rendition; while the policy refuses them the preview shows the SDR
 * picture, and the hint names the refusal.
 */
export function HdrPreviewControl({
  density,
  hasImage,
  availability = UNDECIDED,
  onSelect,
  hintId,
  hintClassName,
}: {
  density: keyof typeof DENSITY
  hasImage: boolean
  availability?: ActionAvailability
  onSelect?: (choice: HdrPreviewChoice) => void
  /** The hint's id, which the HDR option is described by too. */
  hintId: string
  hintClassName: string
}) {
  const { t } = useI18n()
  const { offered, choices, choice } = useHdrPreview()
  const shown = offered && hasImage
  const drawn = shown && availability.available ? choice : 'sdr'
  const refusal = shown && availability.reason
  const paint = DENSITY[density]
  return (
    <>
      {shown && (
        <div
          role="group"
          aria-label={t('raw.export.hdr.preview.label')}
          aria-describedby={hintId}
          data-export-hdr-preview
          className={clsxm(
            'grid gap-0.5',
            choices.length === 4 ? 'grid-cols-4' : 'grid-cols-3',
            SEGMENTED_TRACK,
          )}
        >
          {choices.map((option) => {
            const active = option === drawn
            return (
              <button
                key={option}
                type="button"
                aria-pressed={active}
                data-hdr-preview-choice={option}
                disabled={!availability.available}
                onClick={() => onSelect?.(option)}
                className={clsxm(
                  'inline-flex min-w-0 items-center justify-center rounded-[6px] px-1 transition-colors duration-150',
                  paint.item,
                  SEGMENTED_ITEM_TEXT,
                  SEGMENTED_FOCUS_RING,
                  'disabled:pointer-events-none disabled:opacity-45',
                  active &&
                    `${SEGMENTED_THUMB_BG} font-semibold ${paint.active}`,
                )}
              >
                <span className="truncate">{t(CHOICE_LABEL[option])}</span>
              </button>
            )
          })}
        </div>
      )}
      <p id={hintId} data-export-hdr-hint={drawn} className={hintClassName}>
        {t(CHOICE_HINT[drawn])}
        {refusal && ` ${t(RAW_REASON_COPY[refusal])}`}
      </p>
    </>
  )
}

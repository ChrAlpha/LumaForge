import { useI18n } from '~/lib/i18n'

import { StrengthControl } from '../tools/StrengthControl'

/**
 * The Look deck's Strength row. It is the one place the deck sets how much
 * of the LUT reaches the photo, so a different control (a continuous
 * amount) replaces it here without touching the rest of the deck.
 */
export function MobileLookStrength(props: {
  value: number
  onChange?: (value: number) => void
  disabled: boolean
  /** Id of the text that says why the control is disabled. */
  describedBy?: string
  /** A press on the disabled control asks for its reason. */
  onBlockedPress?: () => void
}) {
  const { t } = useI18n()
  return (
    <div
      data-mobile-look-strength
      className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3"
    >
      <span className="text-[0.74rem] font-semibold text-lf-on-photo-ink/62">
        {t('raw.strength.title')}
      </span>
      <div className="relative min-w-0">
        <StrengthControl
          value={props.value}
          onChange={(value) => props.onChange?.(value)}
          disabled={props.disabled}
          size="md"
          ariaDescribedBy={props.disabled ? props.describedBy : undefined}
        />
        {/* Disabled buttons swallow presses in some browsers; this catches
            one so the deck can say why the control is off. */}
        {props.disabled && props.onBlockedPress && (
          <span
            aria-hidden="true"
            data-strength-blocked-catcher
            className="absolute inset-0"
            onPointerDown={props.onBlockedPress}
          />
        )}
      </div>
    </div>
  )
}

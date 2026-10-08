import { useI18n } from '~/lib/i18n'

/** `reason` is display text already in the current locale; it is shown as given. */
export function UnsupportedState({ reason }: { reason: string }) {
  const { t } = useI18n()

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <h2 className="text-2xl font-semibold text-text">
        {t('raw.unsupported.title')}
      </h2>
      <p className="max-w-xl text-sm text-text-secondary">{reason}</p>
      <p className="max-w-xl text-sm text-text-tertiary">
        {t('raw.unsupported.copy')}
      </p>
    </div>
  )
}

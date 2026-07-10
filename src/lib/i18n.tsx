import i18n from 'i18next'
import type { PropsWithChildren } from 'react'
import { I18nextProvider, useTranslation } from 'react-i18next'

import enMessages from '~/locales/en.json'
import zhMessages from '~/locales/zh-CN.json'

const LOCALE_STORAGE_KEY = 'lumaforge.locale'

export const supportedLocales = ['en', 'zh-CN'] as const
export type Locale = (typeof supportedLocales)[number]

export type MessageKey = keyof typeof enMessages

export type Translate = (
  key: MessageKey,
  values?: Record<string, string | number>,
) => string

function resolveInitialLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY)
    if (stored === 'en' || stored === 'zh-CN') return stored
  } catch {}

  if (typeof navigator !== 'undefined') {
    const languages = navigator.languages?.length
      ? navigator.languages
      : [navigator.language]
    for (const lang of languages) {
      const normalized = lang?.trim().toLowerCase()
      if (normalized === 'zh-cn' || normalized?.startsWith('zh')) return 'zh-CN'
      if (normalized === 'en' || normalized?.startsWith('en-')) return 'en'
    }
  }

  return 'en'
}

function syncDocumentLocale(locale: Locale) {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale
  }
}

const initialLocale = resolveInitialLocale()

i18n.init({
  resources: {
    en: { translation: enMessages },
    'zh-CN': { translation: zhMessages },
  },
  lng: initialLocale,
  fallbackLng: 'en',
  supportedLngs: supportedLocales,
  interpolation: {
    escapeValue: false,
  },
  returnNull: false,
  returnEmptyString: false,
})

syncDocumentLocale(initialLocale)

export function useI18n() {
  const { t, i18n: i18nInstance, ready } = useTranslation()

  if (!ready) {
    const locale = resolveInitialLocale()
    const messages = locale === 'zh-CN' ? zhMessages : enMessages
    return {
      locale,
      setLocale: (_locale: Locale) => {},
      toggleLocale: () => {},
      t: ((key: MessageKey, values?: Record<string, string | number>) => {
        let message = messages[key] ?? enMessages[key] ?? key
        if (values) {
          for (const [k, v] of Object.entries(values)) {
            message = message.replace(`{{${k}}}`, String(v))
          }
        }
        return message
      }) as Translate,
    }
  }

  return {
    locale: (i18nInstance.resolvedLanguage ?? resolveInitialLocale()) as Locale,
    setLocale: (locale: Locale) => {
      i18nInstance.changeLanguage(locale)
      syncDocumentLocale(locale)
      try {
        localStorage.setItem(LOCALE_STORAGE_KEY, locale)
      } catch {}
    },
    toggleLocale: () => {
      const current =
        (i18nInstance.resolvedLanguage as Locale) ?? resolveInitialLocale()
      const next = current === 'zh-CN' ? 'en' : 'zh-CN'
      i18nInstance.changeLanguage(next)
      syncDocumentLocale(next)
      try {
        localStorage.setItem(LOCALE_STORAGE_KEY, next)
      } catch {}
    },
    t: t as Translate,
  }
}

export function I18nProvider({ children }: PropsWithChildren) {
  const locale = resolveInitialLocale()

  syncDocumentLocale(locale)

  if (i18n.resolvedLanguage !== locale) {
    i18n.changeLanguage(locale)
  }

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
}

export function localizeRawReason(reason: string | undefined, t: Translate) {
  if (!reason) return reason

  if (reason === enMessages['raw.exportSourceLoading']) {
    return t('raw.exportSourceLoading')
  }

  if (reason === enMessages['raw.unsupported.webgl2']) {
    return t('raw.unsupported.webgl2')
  }

  if (reason === enMessages['raw.export.copyUnsupported']) {
    return t('raw.export.copyUnsupported')
  }

  if (reason === enMessages['raw.export.copyPreviewReason']) {
    return t('raw.export.copyPreviewReason')
  }

  if (reason === enMessages['raw.export.copyHqPreviewReason']) {
    return t('raw.export.copyHqPreviewReason')
  }

  if (reason === enMessages['raw.export.shareUnsupported']) {
    return t('raw.export.shareUnsupported')
  }

  if (reason === enMessages['raw.export.highPerformance']) {
    return t('raw.export.highPerformance')
  }

  if (reason === enMessages['raw.export.previewSourceLoading']) {
    return t('raw.export.previewSourceLoading')
  }

  if (reason === enMessages['raw.export.previewLoadRequired']) {
    return t('raw.export.previewLoadRequired')
  }

  if (reason === enMessages['raw.export.previewRestoreRequired']) {
    return t('raw.export.previewRestoreRequired')
  }

  if (reason === enMessages['raw.export.previewUnavailable']) {
    return t('raw.export.previewUnavailable')
  }

  return reason
}

export function localizeCopyLabel(label: string, t: Translate) {
  if (label === enMessages['raw.export.copyFull'])
    return t('raw.export.copyFull')
  if (label === enMessages['raw.export.copyHqPreview']) {
    return t('raw.export.copyHqPreview')
  }
  if (label === enMessages['raw.export.copyPreview']) {
    return t('raw.export.copyPreview')
  }

  return label
}

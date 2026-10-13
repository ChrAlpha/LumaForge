import { useCallback, useLayoutEffect, useRef } from 'react'

import type { Translate } from '~/lib/i18n'
import { useI18n } from '~/lib/i18n'

/**
 * A translate function that keeps its identity and reads the locale current
 * when it is called. Copy built after an await (a toast for a load, a
 * restore, or an export) is then in the language the page shows at that
 * moment, not the one the render that started the work saw.
 */
export function useLatestTranslate(): Translate {
  const { t } = useI18n()
  const translateRef = useRef(t)
  useLayoutEffect(() => {
    translateRef.current = t
  }, [t])
  return useCallback<Translate>(
    (key, values) => translateRef.current(key, values),
    [],
  )
}

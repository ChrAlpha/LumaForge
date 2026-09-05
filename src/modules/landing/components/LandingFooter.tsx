import { GitFork } from 'lucide-react'

import { useI18n } from '~/lib/i18n'

import { SOURCE_URL } from '../content'

export function LandingFooter() {
  const { t } = useI18n()

  return (
    <footer className="lf-footer">
      <span>LumaForge</span>
      <a
        href={SOURCE_URL}
        target="_blank"
        rel="noreferrer"
        className="lf-footer-source"
      >
        <GitFork aria-hidden="true" size={14} strokeWidth={1.8} />
        {t('landing.footer.openSource')}
      </a>
    </footer>
  )
}

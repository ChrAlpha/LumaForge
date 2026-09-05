import { GitFork, ImageUp } from 'lucide-react'
import { Link } from 'react-router'

import { LocaleToggle } from '~/components/common/LocaleToggle'
import { useI18n } from '~/lib/i18n'

import { APP_ICON_SRC, SOURCE_URL } from '../content'

export function LandingNav() {
  const { t } = useI18n()

  return (
    <nav className="lf-nav" aria-label={t('landing.navPrimary')}>
      <div className="lf-nav-inner">
        <Link to="/" className="lf-wordmark" aria-label={t('landing.homeAria')}>
          <img
            src={APP_ICON_SRC}
            alt=""
            aria-hidden="true"
            width={32}
            height={32}
          />
          <span>LumaForge</span>
        </Link>
        <div className="lf-nav-actions">
          <Link to="/raw" className="lf-nav-link">
            <ImageUp aria-hidden="true" size={16} strokeWidth={1.9} />
            <span>{t('landing.openRawLab')}</span>
          </Link>
          <LocaleToggle className="lf-nav-ghost lf-locale-toggle" />
          <a
            href={SOURCE_URL}
            className="lf-nav-ghost lf-icon-link"
            aria-label={t('landing.githubAria')}
            target="_blank"
            rel="noreferrer"
          >
            <GitFork aria-hidden="true" size={17} strokeWidth={1.8} />
          </a>
        </div>
      </div>
    </nav>
  )
}

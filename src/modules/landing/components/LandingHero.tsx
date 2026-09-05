import { ArrowUpRight, ImageUp } from 'lucide-react'
import { Link } from 'react-router'

import { useI18n } from '~/lib/i18n'

import {
  COMPARE_PHOTO_SRC,
  countMoreFormats,
  HERO_FILE,
  HERO_TITLE_PHRASES,
  SOURCE_URL,
} from '../content'
import { PhotoCompare } from './PhotoCompare'

export function LandingHero() {
  const { locale, t } = useI18n()

  return (
    <section className="lf-hero" aria-labelledby="lf-hero-title">
      <div className="lf-hero-copy-column">
        <p className="lf-kicker">{t('landing.kicker')}</p>
        <h1 id="lf-hero-title" aria-label={t('landing.heroTitle')}>
          {locale === 'zh-CN' ? (
            <span className="lf-hero-title-phrases">
              {HERO_TITLE_PHRASES.map((phrase) => (
                <span key={phrase}>{t(phrase)}</span>
              ))}
            </span>
          ) : (
            t('landing.heroTitle')
          )}
        </h1>
        <p className="lf-hero-copy">{t('landing.heroCopy')}</p>
        <div className="lf-hero-actions">
          <Link to="/raw" className="lf-button lf-button-primary">
            <ImageUp aria-hidden="true" size={17} strokeWidth={2} />
            {t('landing.openRawLab')}
          </Link>
          <a
            href={SOURCE_URL}
            target="_blank"
            rel="noreferrer"
            className="lf-source-link"
          >
            {t('landing.viewSource')}
            <ArrowUpRight aria-hidden="true" size={15} strokeWidth={1.9} />
          </a>
        </div>
        <p className="lf-hero-formats">
          {t('landing.formats', { more: countMoreFormats() })}
        </p>
      </div>

      <figure className="lf-hero-figure">
        <div className="lf-photo-stage">
          <PhotoCompare
            src={COMPARE_PHOTO_SRC}
            label={t('landing.heroImageAlt')}
            neutralTag={t('landing.rawPreviewTag')}
            finishedTag={t('landing.finishedJpegTag')}
            valueText={(neutralPercent, finishedPercent) =>
              `${neutralPercent}% ${t('landing.rawPreviewTag')}, ${finishedPercent}% ${t('landing.finishedJpegTag')}`
            }
          />
        </div>
        <figcaption className="lf-photo-caption">
          <span className="lf-photo-facts">
            {HERO_FILE.name} · {HERO_FILE.width} × {HERO_FILE.height}
          </span>
          <span>{t('landing.compareCaption')}</span>
        </figcaption>
      </figure>
    </section>
  )
}

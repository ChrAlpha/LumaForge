import './index.css'
import './index.sections.css'

import { ArrowUpRight, GitFork, ImageUp } from 'lucide-react'
import { m, useReducedMotion } from 'motion/react'
import { Link } from 'react-router'

import { LandingPhotoCompare } from '~/components/common/LandingPhotoCompare'
import { LocaleToggle } from '~/components/common/LocaleToggle'
import { useI18n } from '~/lib/i18n'
import type { SeoRouteHandle } from '~/lib/seo'
import { HOME_ROUTE_SEO } from '~/lib/seo'
import { Spring } from '~/lib/spring'

import { repository } from '../../../package.json'

const appIcon = '/favicon.png'

export const handle = {
  seo: HOME_ROUTE_SEO,
} satisfies SeoRouteHandle

export const loader = () => null

const heroFeatures = [
  'landing.heroFeature.0',
  'landing.heroFeature.1',
  'landing.heroFeature.2',
  'landing.heroFeature.3',
] as const

const heroTitlePhrases = [
  'landing.heroTitlePhrase.0',
  'landing.heroTitlePhrase.1',
  'landing.heroTitlePhrase.2',
] as const

const workflowSteps = [
  ['landing.workflow.0.label', 'landing.workflow.0.detail'],
  ['landing.workflow.1.label', 'landing.workflow.1.detail'],
  ['landing.workflow.2.label', 'landing.workflow.2.detail'],
  ['landing.workflow.3.label', 'landing.workflow.3.detail'],
  ['landing.workflow.4.label', 'landing.workflow.4.detail'],
] as const

const contractSteps = [
  'landing.contract.0',
  'landing.contract.1',
  'landing.contract.2',
  'landing.contract.3',
  'landing.contract.4',
  'landing.contract.5',
  'landing.contract.6',
] as const

const trustPoints = [
  ['landing.trust.0.title', 'landing.trust.0.text'],
  ['landing.trust.1.title', 'landing.trust.1.text'],
  ['landing.trust.2.title', 'landing.trust.2.text'],
] as const

function useHeroReveal() {
  const prefersReducedMotion = useReducedMotion() ?? false

  return {
    initial: prefersReducedMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    transition: prefersReducedMotion ? { duration: 0 } : Spring.smooth(0.22),
  }
}

export const Component = () => {
  const { locale, t } = useI18n()
  const reveal = useHeroReveal()

  return (
    <div className="lf-landing">
      <a className="lf-skip-link" href="#landing-main">
        {t('landing.skipToContent')}
      </a>

      <nav className="lf-nav" aria-label={t('landing.navPrimary')}>
        <div className="lf-nav-inner">
          <Link
            to="/"
            className="lf-wordmark"
            aria-label={t('landing.homeAria')}
          >
            <img src={appIcon} alt="" aria-hidden="true" />
            <span>LumaForge</span>
          </Link>
          <div className="lf-nav-actions">
            <Link
              to="/raw"
              className="lf-nav-link"
              aria-label={t('landing.openRawLab')}
            >
              <ImageUp aria-hidden="true" size={16} strokeWidth={1.9} />
              <span>{t('landing.openRawLab')}</span>
            </Link>
            <LocaleToggle className="lf-locale-toggle" />
            <a
              href={repository.url}
              className="lf-icon-link"
              aria-label={t('landing.githubAria')}
              target="_blank"
              rel="noreferrer"
            >
              <GitFork aria-hidden="true" size={17} strokeWidth={1.8} />
            </a>
          </div>
        </div>
      </nav>

      <main id="landing-main">
        <section className="lf-hero" aria-labelledby="lf-hero-title">
          <m.div className="lf-hero-copy-column" {...reveal}>
            <p className="lf-kicker">{t('landing.kicker')}</p>
            <h1 id="lf-hero-title" aria-label={t('landing.heroTitle')}>
              {locale === 'zh-CN' ? (
                <span className="lf-hero-title-phrases">
                  {heroTitlePhrases.map((phrase) => (
                    <span key={phrase}>{t(phrase)}</span>
                  ))}
                </span>
              ) : (
                t('landing.heroTitle')
              )}
            </h1>
            <p className="lf-hero-copy">{t('landing.heroCopy')}</p>
            <div
              className="lf-hero-actions"
              aria-label={t('landing.primaryActions')}
            >
              <Link to="/raw" className="lf-button lf-button-primary">
                <ImageUp aria-hidden="true" size={17} strokeWidth={2} />
                {t('landing.openRawLab')}
              </Link>
              <a
                href={repository.url}
                target="_blank"
                rel="noreferrer"
                className="lf-source-link"
              >
                {t('landing.viewSource')}
                <ArrowUpRight aria-hidden="true" size={15} strokeWidth={1.9} />
              </a>
            </div>
            <ul className="lf-hero-feature-rail">
              {heroFeatures.map((feature) => (
                <li key={feature}>{t(feature)}</li>
              ))}
            </ul>
          </m.div>

          <m.figure className="lf-hero-figure" {...reveal}>
            <div className="lf-photo-meta" aria-hidden="true">
              <span>SGL00940.ARW</span>
              <span>{t('landing.heroFeature.1')}</span>
            </div>
            <div className="lf-photo-stage">
              <LandingPhotoCompare
                label={t('landing.heroImageAlt')}
                neutralTag={t('landing.rawPreviewTag')}
                finishedTag={t('landing.finishedJpegTag')}
                valueText={(neutralPercent, finishedPercent) =>
                  `${neutralPercent}% ${t('landing.rawPreviewTag')}, ${finishedPercent}% ${t('landing.finishedJpegTag')}`
                }
              />
            </div>
            <figcaption className="lf-photo-caption">
              <span>{t('landing.workflowPreview')}</span>
              <span>9504 × 6336</span>
            </figcaption>
          </m.figure>
        </section>

        <section className="lf-workflow" aria-labelledby="lf-workflow-title">
          <header className="lf-section-intro">
            <p className="lf-section-label">{t('landing.workflow.label')}</p>
            <h2 id="lf-workflow-title">{t('landing.workflow.title')}</h2>
            <p>{t('landing.workflow.intro')}</p>
          </header>
          <ol className="lf-workflow-list">
            {workflowSteps.map(([label, detail], index) => (
              <li key={label}>
                <span className="lf-step-index">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <div>
                  <h3>{t(label)}</h3>
                  <p>{t(detail)}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="lf-evidence" aria-labelledby="lf-evidence-title">
          <div className="lf-evidence-copy">
            <div>
              <p className="lf-section-label">{t('landing.evidence.label')}</p>
              <h2 id="lf-evidence-title">{t('landing.evidence.title')}</h2>
            </div>
            <div>
              <p>{t('landing.evidence.copy')}</p>
              <ul>
                {heroFeatures.slice(1).map((feature) => (
                  <li key={feature}>{t(feature)}</li>
                ))}
              </ul>
            </div>
          </div>
          <figure className="lf-evidence-figure">
            <div className="lf-evidence-image-wrap">
              <img
                src="/landing-workspace-evidence.webp"
                alt={t('landing.evidence.alt')}
                loading="lazy"
                decoding="async"
              />
            </div>
            <figcaption>
              <span>{t('landing.evidence.caption')}</span>
              <span>Chromium · 1440 × 900</span>
            </figcaption>
          </figure>
        </section>

        <section className="lf-contract" aria-labelledby="lf-contract-title">
          <div className="lf-contract-copy">
            <div>
              <p className="lf-section-label">{t('landing.pipeline.label')}</p>
              <h2 id="lf-contract-title">{t('landing.pipeline.title')}</h2>
            </div>
            <p>{t('landing.pipeline.note')}</p>
          </div>
          <ol
            className="lf-contract-rail"
            aria-label={t('landing.pipelineAria')}
          >
            {contractSteps.map((step, index) => (
              <li key={step}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <p>{t(step)}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="lf-trust" aria-label={t('landing.trustAria')}>
          <dl>
            {trustPoints.map(([title, text]) => (
              <div key={title}>
                <dt>{t(title)}</dt>
                <dd>{t(text)}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="lf-final" aria-labelledby="lf-final-title">
          <div>
            <p className="lf-section-label">{t('landing.final.label')}</p>
            <h2 id="lf-final-title">{t('landing.final.title')}</h2>
            <p>{t('landing.final.copy')}</p>
          </div>
          <Link to="/raw" className="lf-button lf-button-primary">
            <ImageUp aria-hidden="true" size={17} strokeWidth={2} />
            {t('landing.final.cta')}
          </Link>
        </section>
      </main>

      <footer className="lf-footer">
        <span>LumaForge</span>
        <a
          href={repository.url}
          target="_blank"
          rel="noreferrer"
          className="lf-footer-source"
        >
          <GitFork aria-hidden="true" size={14} strokeWidth={1.8} />
          {t('landing.footer.openSource')}
        </a>
      </footer>
    </div>
  )
}

export default Component

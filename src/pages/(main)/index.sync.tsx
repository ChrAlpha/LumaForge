import './index.css'

import {
  ArrowRight,
  GitFork,
  LockKeyhole,
  ShieldCheck,
  SlidersHorizontal,
  Star,
} from 'lucide-react'
import { m, useReducedMotion } from 'motion/react'
import { useMemo } from 'react'
import { Link } from 'react-router'

import { LandingPhotoCompare } from '~/components/common/LandingPhotoCompare'
import { LocaleToggle } from '~/components/common/LocaleToggle'
import { useI18n } from '~/lib/i18n'
import type { SeoRouteHandle } from '~/lib/seo'
import { HOME_ROUTE_SEO } from '~/lib/seo'
import { Spring, surfaceFade } from '~/lib/spring'

import { repository } from '../../../package.json'

const appIcon = '/favicon.png'

export const handle = {
  seo: HOME_ROUTE_SEO,
} satisfies SeoRouteHandle

export const loader = () => null

const proofPoints = [
  {
    icon: ShieldCheck,
    title: 'landing.proof.0.title',
    text: 'landing.proof.0.text',
  },
  {
    icon: LockKeyhole,
    title: 'landing.proof.1.title',
    text: 'landing.proof.1.text',
  },
  {
    icon: SlidersHorizontal,
    title: 'landing.proof.2.title',
    text: 'landing.proof.2.text',
  },
] as const

const workflowSteps = [
  {
    label: 'landing.workflow.0.label',
    detail: 'landing.workflow.0.detail',
  },
  {
    label: 'landing.workflow.1.label',
    detail: 'landing.workflow.1.detail',
  },
  {
    label: 'landing.workflow.2.label',
    detail: 'landing.workflow.2.detail',
  },
] as const

function useHeroEntrance() {
  const prefersReduced = useReducedMotion() ?? false

  return useMemo(() => {
    const entrance = (delayMs: number) => ({
      initial: prefersReduced ? { opacity: 1, y: 0 } : { opacity: 0, y: 12 },
      animate: { opacity: 1, y: 0 },
      transition: prefersReduced
        ? { duration: 0 }
        : { ...Spring.smooth(0.32), delay: delayMs / 1000 },
    })

    const fadeIn = (delayMs: number) => ({
      initial: { opacity: prefersReduced ? 1 : 0 },
      animate: { opacity: 1 },
      transition: prefersReduced
        ? { duration: 0 }
        : { ...surfaceFade, duration: 0.6, delay: delayMs / 1000 },
    })

    return { entrance, fadeIn }
  }, [prefersReduced])
}

export const Component = () => {
  const { t } = useI18n()
  const { entrance, fadeIn } = useHeroEntrance()

  return (
    <main className="lf-landing">
      <nav className="lf-nav" aria-label={t('landing.navPrimary')}>
        <Link to="/" className="lf-wordmark" aria-label={t('landing.homeAria')}>
          <img
            className="lf-wordmark-icon"
            src={appIcon}
            alt=""
            aria-hidden="true"
          />
          <span>LumaForge</span>
        </Link>
        <div className="lf-nav-actions">
          <Link to="/raw" className="lf-nav-link">
            {t('landing.openRawLab')}
          </Link>
          <LocaleToggle className="lf-locale-toggle" />
          <a
            href={repository.url}
            className="lf-icon-link"
            aria-label={t('landing.githubAria')}
            target="_blank"
            rel="noreferrer"
          >
            <GitFork size={16} strokeWidth={1.8} />
          </a>
        </div>
      </nav>

      <section className="lf-hero" aria-labelledby="lf-hero-title">
        <div className="lf-hero-glow" aria-hidden="true" />

        <div className="lf-hero-content">
          <m.p className="lf-kicker" {...entrance(0)}>
            {t('landing.kicker')}
          </m.p>
          <m.h1 id="lf-hero-title" {...entrance(80)}>
            LumaForge
          </m.h1>
          <m.p className="lf-hero-copy" {...entrance(160)}>
            {t('landing.heroCopy')}
          </m.p>
          <m.div className="lf-hero-actions" {...entrance(220)}>
            <Link to="/raw" className="lf-button lf-button-primary">
              {t('landing.openRawLab')}
              <ArrowRight size={16} strokeWidth={2} />
            </Link>
            <a
              href={repository.url}
              target="_blank"
              rel="noreferrer"
              className="lf-star-link"
            >
              <Star size={14} strokeWidth={1.8} />
              {t('landing.starOnGithub')}
            </a>
          </m.div>
        </div>

        <m.div className="lf-product-window" {...fadeIn(350)}>
          <div className="lf-window-chrome" aria-hidden="true">
            <div className="lf-window-dots">
              <div className="lf-window-dot" />
              <div className="lf-window-dot" />
              <div className="lf-window-dot" />
            </div>
            <span className="lf-window-filename">DSC_4832.ARW</span>
            <span className="lf-window-pipeline">ARRI LogC → Rec.709</span>
          </div>
          <figure
            className="lf-window-body"
            aria-label={t('landing.workflowPreview')}
          >
            <LandingPhotoCompare
              label={t('landing.heroImageAlt')}
              neutralTag={t('landing.rawPreviewTag')}
              finishedTag={t('landing.finishedJpegTag')}
              valueText={(neutralPercent, finishedPercent) =>
                `${neutralPercent}% ${t('landing.rawPreviewTag')}, ${finishedPercent}% ${t('landing.finishedJpegTag')}`
              }
            />
          </figure>
        </m.div>
      </section>

      <section className="lf-proof" aria-label={t('landing.proofAria')}>
        {proofPoints.map(({ icon: Icon, title, text }) => (
          <article key={title} className="lf-proof-item">
            <Icon size={22} strokeWidth={1.7} />
            <h3>{t(title)}</h3>
            <p>{t(text)}</p>
          </article>
        ))}
      </section>

      <section
        className="lf-section lf-workflow"
        aria-labelledby="lf-workflow-title"
      >
        <p className="lf-section-label">{t('landing.workflow.label')}</p>
        <h2 id="lf-workflow-title">{t('landing.workflow.title')}</h2>
        <div className="lf-workflow-grid">
          {workflowSteps.map((item, index) => (
            <div key={item.label} className="lf-workflow-step">
              <span>{index + 1}</span>
              <h3>{t(item.label)}</h3>
              <p>{t(item.detail)}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="lf-section lf-final" aria-labelledby="lf-final-title">
        <img
          className="lf-final-icon"
          src={appIcon}
          alt=""
          aria-hidden="true"
        />
        <h2 id="lf-final-title">{t('landing.final.title')}</h2>
        <p>{t('landing.final.copy')}</p>
        <Link to="/raw" className="lf-button lf-button-primary">
          {t('landing.final.cta')}
          <ArrowRight size={16} strokeWidth={2} />
        </Link>
      </section>

      <footer className="lf-footer">
        <a
          href={repository.url}
          target="_blank"
          rel="noreferrer"
          className="lf-footer-source"
        >
          <GitFork size={14} strokeWidth={1.8} />
          {t('landing.footer.openSource')}
        </a>
      </footer>
    </main>
  )
}

export default Component

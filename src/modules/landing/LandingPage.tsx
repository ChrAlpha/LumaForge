import './landing.css'
import './landing.sections.css'

import { useI18n } from '~/lib/i18n'

import { LandingFooter } from './components/LandingFooter'
import { LandingHero } from './components/LandingHero'
import { LandingNav } from './components/LandingNav'
import {
  EvidenceSection,
  FinalSection,
  LedgerSection,
  PipelineSection,
  WorkflowSection,
} from './components/LandingSections'

/**
 * The `/` brand surface. Expects the app's I18n provider and router above it.
 */
export function LandingPage() {
  const { t } = useI18n()

  return (
    <div className="lf-landing">
      <a className="lf-skip-link" href="#landing-main">
        {t('landing.skipToContent')}
      </a>
      <LandingNav />
      <main id="landing-main">
        <LandingHero />
        <WorkflowSection />
        <EvidenceSection />
        <PipelineSection />
        <LedgerSection />
        <FinalSection />
      </main>
      <LandingFooter />
    </div>
  )
}

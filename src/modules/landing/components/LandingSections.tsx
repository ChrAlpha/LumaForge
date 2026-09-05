import { ImageUp } from 'lucide-react'
import { Link } from 'react-router'

import { useI18n } from '~/lib/i18n'

import {
  EVIDENCE_MOBILE_MEDIA,
  EVIDENCE_MOBILE_SRC,
  EVIDENCE_SESSION,
  EVIDENCE_SRC,
  formatStepIndex,
  GUARANTEES,
  PIPELINE_STEPS,
  WORKFLOW_STEPS,
} from '../content'

export function WorkflowSection() {
  const { t } = useI18n()

  return (
    <section className="lf-workflow" aria-labelledby="lf-workflow-title">
      <header className="lf-section-intro">
        <h2 id="lf-workflow-title">{t('landing.workflow.title')}</h2>
        <p>{t('landing.workflow.intro')}</p>
      </header>
      <ol className="lf-workflow-list">
        {WORKFLOW_STEPS.map(([label, detail], index) => (
          <li key={label}>
            <span className="lf-step-index">{formatStepIndex(index)}</span>
            <div>
              <h3>{t(label)}</h3>
              <p>{t(detail)}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

export function EvidenceSection() {
  const { t } = useI18n()

  return (
    <section className="lf-evidence" aria-labelledby="lf-evidence-title">
      <div className="lf-evidence-copy">
        <h2 id="lf-evidence-title">{t('landing.evidence.title')}</h2>
        <p>{t('landing.evidence.copy')}</p>
      </div>
      <figure className="lf-evidence-figure">
        <picture className="lf-evidence-image-wrap">
          <source
            media={EVIDENCE_MOBILE_MEDIA}
            srcSet={EVIDENCE_MOBILE_SRC}
            width={720}
            height={900}
          />
          <img
            src={EVIDENCE_SRC}
            width={EVIDENCE_SESSION.width}
            height={EVIDENCE_SESSION.height}
            alt={t('landing.evidence.alt')}
            loading="lazy"
            decoding="async"
          />
        </picture>
        <figcaption>
          <span>{t('landing.evidence.caption')}</span>
          <span className="lf-photo-facts">
            {EVIDENCE_SESSION.browser} · {EVIDENCE_SESSION.width} ×{' '}
            {EVIDENCE_SESSION.height}
          </span>
        </figcaption>
      </figure>
    </section>
  )
}

export function PipelineSection() {
  const { t } = useI18n()

  return (
    <section className="lf-contract" aria-labelledby="lf-contract-title">
      <div className="lf-contract-copy">
        <h2 id="lf-contract-title">{t('landing.pipeline.title')}</h2>
        <p>{t('landing.pipeline.note')}</p>
      </div>
      <ol className="lf-contract-rail" aria-label={t('landing.pipelineAria')}>
        {PIPELINE_STEPS.map(([step, role], index) => (
          <li key={step} data-contract-role={role}>
            <span>{formatStepIndex(index)}</span>
            <p>{t(step)}</p>
          </li>
        ))}
      </ol>
    </section>
  )
}

export function LedgerSection() {
  const { t } = useI18n()

  return (
    <section className="lf-ledger" aria-label={t('landing.trustAria')}>
      <dl>
        {GUARANTEES.map(([title, text]) => (
          <div key={title}>
            <dt>{t(title)}</dt>
            <dd>{t(text)}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

export function FinalSection() {
  const { t } = useI18n()

  return (
    <section className="lf-final" aria-labelledby="lf-final-title">
      <div>
        <h2 id="lf-final-title">{t('landing.final.title')}</h2>
        <p>{t('landing.final.copy')}</p>
      </div>
      <Link to="/raw" className="lf-button lf-button-primary">
        <ImageUp aria-hidden="true" size={17} strokeWidth={2} />
        {t('landing.final.cta')}
      </Link>
    </section>
  )
}

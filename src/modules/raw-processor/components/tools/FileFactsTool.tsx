import { Fragment } from 'react'

import { useI18n } from '~/lib/i18n'

import type { SupportLevel } from '../../model/session'

export function FileFactsTool({
  supportLevel,
  metadata,
  stats,
}: {
  supportLevel: SupportLevel
  metadata: null | {
    make?: string
    model?: string
    lens?: string
    iso?: number
    aperture?: number
    focalLength?: number
    shutterSpeed?: string
    width: number
    height: number
  }
  stats: null | {
    processTime: number
    inputSize: { width: number; height: number }
    previewSize: { width: number; height: number }
  }
}) {
  const { t } = useI18n()
  const hasSessionFacts = metadata !== null || stats !== null
  const facts = [
    {
      label: t('raw.fileFacts.support'),
      value: hasSessionFacts
        ? supportLevel === 'unsupported'
          ? t('raw.support.unsupported')
          : t('raw.support.experimental')
        : undefined,
    },
    {
      label: t('raw.fileFacts.camera'),
      value:
        metadata && `${metadata.make || ''} ${metadata.model || ''}`.trim(),
    },
    {
      label: t('raw.fileFacts.size'),
      value: metadata ? `${metadata.width} x ${metadata.height}` : undefined,
    },
    {
      label: t('raw.fileFacts.preview'),
      value: stats
        ? `${stats.previewSize.width} x ${stats.previewSize.height}`
        : undefined,
    },
    {
      label: t('raw.fileFacts.render'),
      value: stats ? `${Math.round(stats.processTime)} ms` : undefined,
    },
  ]

  return (
    <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5">
      {facts.map((fact) => (
        <Fragment key={fact.label}>
          <dt className="text-[0.72rem] tracking-tight text-lf-on-surface/62">
            {fact.label}
          </dt>
          <dd className="truncate text-[0.78rem] font-medium tabular-nums text-lf-on-surface">
            {fact.value || t('raw.fileFacts.notLoaded')}
          </dd>
        </Fragment>
      ))}
    </dl>
  )
}

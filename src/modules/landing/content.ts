import { SUPPORTED_RAW_EXTENSIONS } from '~/lib/raw/decoder'

import { repository } from '../../../package.json'

export const SOURCE_URL = repository.url
export const APP_ICON_SRC = '/favicon.png'
export const COMPARE_PHOTO_SRC = '/landing-raw-finish.webp'
export const EVIDENCE_SRC = '/landing-workspace-evidence.webp'
export const EVIDENCE_MOBILE_SRC = '/landing-workspace-evidence-mobile.webp'
export const EVIDENCE_MOBILE_MEDIA = '(max-width: 640px)'

/** The camera file behind the hero compare and the evidence screenshot. */
export const HERO_FILE = {
  name: 'SGL00940.ARW',
  width: 9504,
  height: 6336,
} as const

/** The browser session the evidence screenshot was captured from. */
export const EVIDENCE_SESSION = {
  browser: 'Chromium',
  width: 1440,
  height: 900,
} as const

export const HERO_TITLE_PHRASES = [
  'landing.heroTitlePhrase.0',
  'landing.heroTitlePhrase.1',
  'landing.heroTitlePhrase.2',
] as const

export const WORKFLOW_STEPS = [
  ['landing.workflow.0.label', 'landing.workflow.0.detail'],
  ['landing.workflow.1.label', 'landing.workflow.1.detail'],
  ['landing.workflow.2.label', 'landing.workflow.2.detail'],
  ['landing.workflow.3.label', 'landing.workflow.3.detail'],
  ['landing.workflow.4.label', 'landing.workflow.4.detail'],
] as const

export type PipelineRole = 'stage' | 'optional' | 'output'

export const PIPELINE_STEPS = [
  ['landing.contract.0', 'stage'],
  ['landing.contract.1', 'stage'],
  ['landing.contract.2', 'stage'],
  ['landing.contract.3', 'stage'],
  ['landing.contract.4', 'stage'],
  ['landing.contract.5', 'optional'],
  ['landing.contract.6', 'output'],
] as const satisfies ReadonlyArray<readonly [string, PipelineRole]>

export const GUARANTEES = [
  ['landing.trust.0.title', 'landing.trust.0.text'],
  ['landing.trust.1.title', 'landing.trust.1.text'],
  ['landing.trust.2.title', 'landing.trust.2.text'],
] as const

/**
 * Extensions named in `landing.formats`. The sentence lists these nine and
 * derives the "and N more" count from the decoder's real support set, so the
 * landing cannot advertise formats the lab does not open.
 */
export const HEADLINE_FORMATS = [
  'arw',
  'nef',
  'cr3',
  'cr2',
  'raf',
  'rw2',
  'orf',
  'dng',
  'pef',
] as const

export function countMoreFormats() {
  return SUPPORTED_RAW_EXTENSIONS.size - HEADLINE_FORMATS.length
}

export function formatStepIndex(index: number) {
  return String(index + 1).padStart(2, '0')
}

import type { LUTContractResolution } from '@lumaforge/luma-color-runtime'

import type { Translate } from '~/lib/i18n'

import type { LUTContractSelectionState } from '../../model/session'
import type { ColorValue } from '../color-fields'
import { COLOR_FIELDS } from '../color-fields'
import type { ToneValue } from '../tone-fields'
import { TONE_FIELDS } from '../tone-fields'
import type { FileFactsTool } from '../tools/FileFactsTool'
import type { HSLToolValue } from '../tools/HSLTool'
import { OUTPUT_REQUIRED_LABEL } from '../tools/lut/useLutContractSummary'
import {
  getProfileOutputLabel,
  getResolvedProfile,
} from '../tools/lut-contract'
import { HSL_BAND_ORDER, MOBILE_HSL_FIELDS } from './hsl-fields'

type FileFactsProps = Parameters<typeof FileFactsTool>[0]

export type MobileDetailsRow = { label: string; value: string }
export type MobileDetailsStep = { index: number; label: string; detail: string }
export type MobileDetailsSheet = {
  pipelineSteps: MobileDetailsStep[]
  lutRows: MobileDetailsRow[]
  fileRows: MobileDetailsRow[]
}

export type LutContractStatus = 'confirmed' | 'needs-contract' | 'not-used'

export function getCameraName(metadata: FileFactsProps['metadata']) {
  if (!metadata) return ''
  return `${metadata.make ?? ''} ${metadata.model ?? ''}`.trim()
}

/** Every tone, color, and HSL field that is away from neutral. */
export function countAdjustedFields(input: {
  tone: ToneValue
  color: ColorValue
  selectiveColor: HSLToolValue | undefined
}) {
  const tone = TONE_FIELDS.filter((f) => input.tone[f.key] !== 0).length
  const color = COLOR_FIELDS.filter((f) => input.color[f.key] !== 0).length
  const selective = input.selectiveColor
  const hsl = selective
    ? HSL_BAND_ORDER.reduce(
        (sum, band) =>
          sum +
          MOBILE_HSL_FIELDS.filter((f) => selective[band][f.key] !== 0).length,
        0,
      )
    : 0
  return tone + color + hsl
}

/**
 * Mirrors the Look panel: a loaded LUT is confirmed only when its contract
 * resolves to a profile with a usable output side.
 */
export function getLutContractStatus(input: {
  currentLutName?: string | null
  lutProfileSelection?: LUTContractSelectionState | null
  lutProfileResolution?: LUTContractResolution | null
}): LutContractStatus {
  if (!input.currentLutName) return 'not-used'
  if (
    input.lutProfileResolution != null &&
    input.lutProfileResolution.kind !== 'confirmed'
  ) {
    return 'needs-contract'
  }
  const profile = getResolvedProfile(
    input.lutProfileSelection,
    input.lutProfileResolution,
  )
  if (!profile || getProfileOutputLabel(profile) === OUTPUT_REQUIRED_LABEL) {
    return 'needs-contract'
  }
  return 'confirmed'
}

export function buildMobileDetailsSheet(
  input: {
    supportLevel: 'official' | 'experimental'
    metadata: FileFactsProps['metadata']
    stats: FileFactsProps['stats']
    tone: ToneValue
    color: ColorValue
    selectiveColor: HSLToolValue | undefined
    currentLutName?: string | null
    lutProfileSelection?: LUTContractSelectionState | null
    lutProfileResolution?: LUTContractResolution | null
    transformActive: boolean
  },
  t: Translate,
): MobileDetailsSheet {
  const notLoaded = t('raw.fileFacts.notLoaded')
  const cameraName = getCameraName(input.metadata)
  const support =
    input.supportLevel === 'official'
      ? t('raw.support.official')
      : t('raw.support.experimental')

  const adjusted = countAdjustedFields(input)
  const adjustDetail =
    adjusted === 0
      ? t('raw.mobile.more.adjustNone')
      : adjusted === 1
        ? t('raw.mobile.more.adjustOne')
        : t('raw.mobile.more.adjustMany', { count: adjusted })

  const lutStatus = getLutContractStatus(input)
  const lutStatusLabel =
    lutStatus === 'confirmed'
      ? t('raw.mobile.more.lutConfirmed')
      : lutStatus === 'needs-contract'
        ? t('raw.mobile.more.lutNeedsContract')
        : t('raw.mobile.more.lutNotUsed')
  const lutDetail = input.currentLutName
    ? `${input.currentLutName} · ${lutStatusLabel}`
    : lutStatusLabel
  const resolvedProfile =
    lutStatus === 'confirmed'
      ? getResolvedProfile(
          input.lutProfileSelection,
          input.lutProfileResolution,
        )
      : undefined

  return {
    pipelineSteps: [
      {
        index: 1,
        label: t('raw.mobile.more.stepDecode'),
        detail: [cameraName, support].filter(Boolean).join(' · '),
      },
      { index: 2, label: t('raw.adjust.title'), detail: adjustDetail },
      { index: 3, label: t('raw.mobile.more.stepLut'), detail: lutDetail },
      {
        index: 4,
        label: t('raw.transform.title'),
        detail: input.transformActive
          ? t('raw.mobile.more.transformApplied')
          : t('raw.mobile.more.transformNone'),
      },
      {
        index: 5,
        label: t('raw.mobile.more.stepOutput'),
        detail: t('raw.mobile.more.outputJpeg'),
      },
    ],
    lutRows: input.currentLutName
      ? [
          { label: t('raw.mobile.more.stepLut'), value: input.currentLutName },
          {
            label: t('raw.mobile.more.contract'),
            value: resolvedProfile
              ? `${lutStatusLabel} · ${resolvedProfile.label}`
              : lutStatusLabel,
          },
        ]
      : [{ label: t('raw.mobile.more.stepLut'), value: lutStatusLabel }],
    fileRows: [
      { label: t('raw.fileFacts.camera'), value: cameraName || notLoaded },
      { label: t('raw.fileFacts.support'), value: support },
      {
        label: t('raw.fileFacts.size'),
        value: input.metadata
          ? `${input.metadata.width} x ${input.metadata.height}`
          : notLoaded,
      },
      {
        label: t('raw.fileFacts.preview'),
        value: input.stats
          ? `${input.stats.previewSize.width} x ${input.stats.previewSize.height}`
          : notLoaded,
      },
      {
        label: t('raw.mobile.more.previewRender'),
        value: input.stats
          ? `${Math.round(input.stats.processTime)} ms`
          : notLoaded,
      },
      {
        label: t('raw.mobile.more.processing'),
        value: t('raw.mobile.more.processingLocal'),
      },
    ],
  }
}

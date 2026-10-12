import type {
  LUTColorProfile,
  LUTContractResolution,
} from '@lumaforge/luma-color-runtime'
import { memo } from 'react'

import { useI18n } from '~/lib/i18n'

import type { UseOnlineLutSourcesResult } from '../../../hooks/useOnlineLutSources'
import type { LUTContractSelectionState } from '../../../model/session'
import type { PreviewLookReason } from '../../../services/surface/raw-reason'
import { LutDropzone } from '../../Dropzone'
import { LUTProfileStatus } from './LUTProfileStatus'
import { OnlineLutSourceControls } from './OnlineLutSourceControls'

export const LutContractTool = memo(
  ({
    currentLutName,
    hasImage,
    disabled,
    onLutLoad,
    onLutClear,
    lutProfileSelection,
    lutProfileResolution,
    previewLookReason,
    onLutProfileSelect,
    onlineLutSources,
  }: {
    currentLutName?: string | null
    /** A RAW is loaded, so a LUT added now applies at once. */
    hasImage: boolean
    disabled: boolean
    onLutLoad: (files: File[]) => void
    onLutClear: () => void
    lutProfileSelection?: LUTContractSelectionState | null
    lutProfileResolution?: LUTContractResolution | null
    /** Why the preview does not draw the applied look; null when it does. */
    previewLookReason?: PreviewLookReason | null
    onLutProfileSelect: (profile: LUTColorProfile) => void
    onlineLutSources?: UseOnlineLutSourcesResult
  }) => {
    const { t } = useI18n()

    return (
      <div className="grid gap-3">
        {onlineLutSources && (
          <OnlineLutSourceControls onlineLutSources={onlineLutSources} />
        )}
        <LutDropzone
          onFileDrop={onLutLoad}
          currentLut={currentLutName}
          onClear={onLutClear}
          disabled={disabled}
        />
        {currentLutName ? (
          <LUTProfileStatus
            key={lutProfileSelection?.fingerprint ?? currentLutName}
            selection={lutProfileSelection}
            resolution={lutProfileResolution}
            previewLookReason={previewLookReason}
            onSelect={onLutProfileSelect}
          />
        ) : hasImage ? null : (
          <p className="m-0 text-[0.72rem] leading-relaxed text-lf-on-surface/72">
            {t('raw.lutContract.empty')}
          </p>
        )}
      </div>
    )
  },
)

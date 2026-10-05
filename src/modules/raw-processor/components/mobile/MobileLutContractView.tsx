import { ArrowLeft } from 'lucide-react'
import { useEffect, useId, useRef } from 'react'

import { useI18n } from '~/lib/i18n'

import { LUTOutputOptionButton } from '../tools/lut/LUTOutputOptionButton'
import { LUTProfileButton } from '../tools/lut/LUTProfileButton'
import { toSelectableContract } from '../tools/lut-contract'
import { handLostFocusTo } from './focus-handoff'
import type { useMobileLutContractEditor } from './useMobileLutContractEditor'

type ContractEditor = ReturnType<typeof useMobileLutContractEditor>

const groupHeading =
  'm-0 px-1 text-[0.7rem] font-medium tracking-tight text-lf-on-photo-ink/52'

/**
 * The LUT contract, chosen inside the Look deck with the photo still in
 * view: what the LUT expects as input (step 1), then what it delivers
 * (step 2). Recommendations come first and apply in one tap when they
 * already name both sides.
 */
export function MobileLutContractView({
  lutName,
  editor,
  onExit,
}: {
  lutName: string
  editor: ContractEditor
  /** Leave the contract view for the strip. */
  onExit: () => void
}) {
  const { t } = useI18n()
  const titleId = useId()
  const searchId = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const backRef = useRef<HTMLButtonElement>(null)
  const step = editor.contractStep
  const isInput = step === 'input'

  // A new step starts at the top of its list.
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0
  }, [step])

  // Entering the view (from the strip's footer, the export panel, or an
  // import) and moving between its steps both swap out the control that
  // had focus; the back button takes it so a keyboard user keeps a place.
  useEffect(() => {
    handLostFocusTo(backRef.current)
  }, [step])

  return (
    <section
      aria-labelledby={titleId}
      data-mobile-look-contract
      data-lut-contract-step={step}
      className="flex h-full min-h-0 flex-col"
    >
      <header className="-mx-3.5 grid shrink-0 grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-1 border-b border-lf-on-photo-bord-soft pl-2 pr-3.5">
        <button
          ref={backRef}
          type="button"
          aria-label={
            isInput
              ? t('raw.mobile.look.contractBackToLooks')
              : t('raw.mobile.look.contractBackToInput')
          }
          onClick={isInput ? onExit : editor.back}
          className="grid size-11 place-items-center rounded-md text-lf-on-photo-ink/72 transition-[color,translate] duration-[120ms] hover:text-lf-on-photo-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-lf-green/80 active:translate-y-[0.5px]"
        >
          <ArrowLeft aria-hidden="true" className="size-[18px]" />
        </button>
        <h3
          id={titleId}
          className="m-0 min-w-0 truncate text-[0.86rem] font-semibold text-lf-on-photo-ink"
        >
          {isInput
            ? t('raw.mobile.look.contractInputTitle', { name: lutName })
            : t('raw.mobile.look.contractOutputTitle', { name: lutName })}
        </h3>
        <span className="text-[0.72rem] font-medium text-lf-on-photo-ink/52 tabular-nums">
          {isInput ? '1 / 2' : '2 / 2'}
        </span>
      </header>

      <div className="grid shrink-0 gap-2 pt-2">
        {!isInput && editor.draftInputProfile && (
          <p className="m-0 truncate px-1 text-[0.72rem] text-lf-on-photo-ink/62">
            {t('raw.lutContract.inputPrefix', {
              label: editor.draftInputProfile.label,
            })}
          </p>
        )}
        {isInput && editor.visibleSuggestions.length > 0 && (
          <div
            role="group"
            aria-label={t('raw.lutContract.suggestedInput')}
            data-mobile-look-contract-recommendations
            className="flex flex-wrap gap-1.5"
          >
            {editor.visibleSuggestions.map((profile) => {
              const completes = Boolean(toSelectableContract(profile))
              return (
                <button
                  key={profile.id}
                  type="button"
                  data-completes-contract={completes || undefined}
                  aria-label={
                    completes
                      ? undefined
                      : t('raw.lutContract.useInput', { label: profile.label })
                  }
                  onClick={() => editor.applyRecommendation(profile)}
                  className="inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-lf-pill bg-[oklch(0.96_0.006_255/0.06)] px-3 text-[0.74rem] font-semibold text-lf-on-photo-ink transition-[background-color,translate] duration-[120ms] hover:bg-[oklch(0.96_0.006_255/0.1)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-lf-green/80 active:translate-y-[0.5px]"
                >
                  <span className="min-w-0 truncate">{profile.label}</span>
                  {completes && (
                    <span className="shrink-0 text-lf-on-photo-ink/72">
                      {' · '}
                      {t('raw.mobile.look.apply')}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        )}
        <label className="sr-only" htmlFor={searchId}>
          {t('raw.lutContract.search')}
        </label>
        <input
          id={searchId}
          type="search"
          aria-label={t('raw.lutContract.search')}
          value={editor.contractQuery}
          placeholder={t('raw.lutContract.searchPlaceholder')}
          onChange={(event) =>
            editor.setContractQuery(event.currentTarget.value)
          }
          className="min-h-[44px] rounded-md border border-transparent bg-[oklch(0.96_0.006_255/0.05)] px-3 text-lf-control text-lf-on-photo-ink outline-none placeholder:text-lf-on-photo-ink/40 focus:bg-[oklch(0.96_0.006_255/0.08)] focus:ring-2 focus:ring-lf-green/25"
        />
      </div>

      <div
        ref={listRef}
        className="-mx-3.5 grid min-h-0 flex-1 content-start gap-2 overflow-y-auto overscroll-contain px-3.5 pb-1 pt-2"
        data-raw-mobile-lut="contract-list"
        data-lut-contract-step={step}
      >
        {isInput ? (
          <>
            {editor.groupedInputProfiles.map((group) => (
              <section key={`input-${group.label}`} className="grid gap-1">
                <h4 className={groupHeading}>
                  {t('raw.lutContract.groupInput', { group: group.label })}
                </h4>
                {group.items.map((profile) => (
                  <LUTProfileButton
                    key={profile.id}
                    profile={profile}
                    activeProfileId={editor.draftInputProfile?.id}
                    size="touch"
                    surface="on-photo"
                    ariaLabel={t('raw.lutContract.useInput', {
                      label: profile.label,
                    })}
                    onSelect={editor.selectInput}
                  />
                ))}
              </section>
            ))}
            {!editor.hasInputMatches && (
              <p className="m-0 text-lf-control leading-relaxed text-lf-on-photo-ink/64">
                {t('raw.lutContract.noInput')}
              </p>
            )}
          </>
        ) : (
          <>
            {editor.suggestedOutputOptions.length > 0 && (
              <section className="grid gap-1">
                <h4 className={groupHeading}>
                  {t('raw.lutContract.suggestedOutput')}
                </h4>
                {editor.suggestedOutputOptions.map((option) => (
                  <LUTOutputOptionButton
                    key={option.id}
                    option={option}
                    activeOptionId={editor.activeOutputOptionId}
                    size="touch"
                    surface="on-photo"
                    onSelect={editor.selectOutput}
                  />
                ))}
              </section>
            )}
            {editor.groupedOutputOptions.map((group) => (
              <section key={`output-${group.label}`} className="grid gap-1">
                <h4 className={groupHeading}>
                  {t('raw.lutContract.groupOutput', { group: group.label })}
                </h4>
                {group.items.map((option) => (
                  <LUTOutputOptionButton
                    key={option.id}
                    option={option}
                    activeOptionId={editor.activeOutputOptionId}
                    size="touch"
                    surface="on-photo"
                    onSelect={editor.selectOutput}
                  />
                ))}
              </section>
            ))}
            {!editor.hasOutputMatches && (
              <p className="m-0 text-lf-control leading-relaxed text-lf-on-photo-ink/64">
                {t('raw.lutContract.noOutput')}
              </p>
            )}
          </>
        )}
      </div>
    </section>
  )
}

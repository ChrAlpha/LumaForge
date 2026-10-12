import * as DialogPrimitive from '@radix-ui/react-dialog'
import { RotateCcw } from 'lucide-react'
import { memo } from 'react'

import { Button } from '~/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '~/components/ui/dialog'
import { useI18n } from '~/lib/i18n'

export interface RawResetConfirmationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

export const RawResetConfirmationDialog = memo(
  ({ open, onOpenChange, onConfirm }: RawResetConfirmationDialogProps) => {
    const { t } = useI18n()

    return (
      <Dialog modal open={open} onOpenChange={onOpenChange}>
        <DialogPrimitive.Portal forceMount>
          {open && (
            <>
              <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[oklch(0.04_0.006_255/0.52)] backdrop-blur-[2px] sm:bg-[oklch(0.04_0.006_255/0.55)]" />
              <div className="pointer-events-none fixed inset-0 z-[60] grid items-end p-0 sm:place-items-center sm:p-5">
                <DialogPrimitive.Content
                  role="alertdialog"
                  data-mobile-substrate="ink-sheet"
                  className="pointer-events-auto grid max-h-[82%] w-full overflow-hidden rounded-t-xl border-t border-lf-on-photo-bord-soft bg-gradient-to-t from-[oklch(0.092_0.006_255/0.96)] via-[oklch(0.118_0.006_255/0.94)] to-[oklch(0.16_0.007_255/0.88)] text-lf-on-photo-ink shadow-[0_-18px_42px_oklch(0.04_0.006_255/0.58),inset_0_1px_0_oklch(0.96_0.006_255/0.06)] backdrop-blur-background sm:max-w-[28rem] sm:rounded-lf-panel sm:border sm:border-lf-on-photo-bord-soft sm:bg-[oklch(0.092_0.006_255/0.96)] sm:bg-none sm:text-lf-on-photo-ink sm:shadow-[0_22px_64px_oklch(0.04_0.006_255/0.5),inset_0_1px_0_oklch(0.96_0.006_255/0.06)]"
                >
                  <div className="px-5 pb-5 pt-5">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <div className="grid size-8 shrink-0 place-items-center rounded-lf-control border border-lf-rose/40 bg-lf-on-photo-bg-strong text-lf-rose sm:border-lf-rose/30 sm:bg-[oklch(0.96_0.006_255/0.05)]">
                        <RotateCcw aria-hidden="true" className="size-[12px]" />
                      </div>
                      <DialogTitle className="flex h-8 min-w-0 items-center text-[1rem] font-semibold leading-none text-lf-on-photo-ink">
                        {t('raw.resetConfirm.title')}
                      </DialogTitle>
                    </div>
                    <DialogDescription className="mt-3 text-lf-body leading-6 text-lf-on-photo-ink/72">
                      {t('raw.resetConfirm.description')}
                    </DialogDescription>
                  </div>
                  <div
                    className="grid grid-cols-2 gap-2 border-t border-lf-on-photo-bord-soft bg-[oklch(0.064_0.006_255/0.92)] px-4 py-3 sm:flex sm:justify-end sm:border-lf-on-photo-bord-soft sm:bg-[oklch(0.062_0.006_255/0.92)] sm:px-5 sm:shadow-[inset_0_1px_0_oklch(0.96_0.006_255/0.06)]"
                    data-raw-reset-confirm-actions
                  >
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      onClick={() => onOpenChange(false)}
                      className="min-h-[44px] border-lf-on-photo-bord-soft bg-[oklch(0.096_0.006_255/0.72)] text-lf-on-photo-ink/82 shadow-none hover:bg-[oklch(0.118_0.006_255/0.86)] hover:text-lf-on-photo-ink sm:min-h-0 sm:border-0 sm:bg-transparent sm:text-lf-on-photo-ink/78 sm:shadow-none sm:hover:bg-[oklch(0.96_0.006_255/0.06)] sm:hover:text-lf-on-photo-ink"
                    >
                      {t('raw.resetConfirm.cancel')}
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      type="button"
                      onClick={onConfirm}
                      className="min-h-[44px] text-lf-on-photo-ink sm:min-h-0"
                    >
                      {t('raw.resetConfirm.confirm')}
                    </Button>
                  </div>
                </DialogPrimitive.Content>
              </div>
            </>
          )}
        </DialogPrimitive.Portal>
      </Dialog>
    )
  },
)

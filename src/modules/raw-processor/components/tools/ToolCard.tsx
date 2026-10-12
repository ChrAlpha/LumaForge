import { useAtom } from 'jotai'
import type { ReactNode } from 'react'
import { memo } from 'react'

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '~/components/ui/accordion'
import { clsxm } from '~/lib/cn'
import { jotaiStore } from '~/lib/jotai'

import type { ToolCardId } from '../../state/tool-card.atoms'
import { toolCardOpenAtom } from '../../state/tool-card.atoms'

export function ToolCardStack({
  ariaLabel,
  className,
  value,
  onValueChange,
  children,
}: {
  ariaLabel: string
  className?: string
  value?: ToolCardId[]
  onValueChange?: (value: ToolCardId[]) => void
  children: ReactNode
}) {
  const [storedOpen, setStoredOpen] = useAtom(toolCardOpenAtom, {
    store: jotaiStore,
  })
  const open = value ?? storedOpen
  const handleValueChange = onValueChange ?? setStoredOpen

  return (
    <Accordion
      type="multiple"
      value={open}
      onValueChange={(next) => handleValueChange(next as ToolCardId[])}
      role="group"
      aria-label={ariaLabel}
      className={clsxm('flex flex-col gap-1', className)}
    >
      {children}
    </Accordion>
  )
}

export function ToolCard({
  id,
  title,
  meta,
  className,
  children,
}: {
  id: ToolCardId
  title: string
  meta?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <AccordionItem
      value={id}
      data-tool-card={id}
      className={clsxm(
        'rounded-md border border-transparent transition-[background,border-color] duration-150 ease-out',
        'hover:bg-[oklch(0.96_0.006_255/0.05)]',
        'data-[state=open]:border-lf-on-photo-bord-soft',
        className,
      )}
    >
      <ToolCardTrigger id={id} title={title} meta={meta} />
      <AccordionContent className="px-2.5 pt-0 pb-2.5 text-lf-body">
        {children}
      </AccordionContent>
    </AccordionItem>
  )
}

// The trigger depends on its title and meta alone, so a card whose body
// rerenders (a workflow change, a histogram result) leaves it alone.
const ToolCardTrigger = memo(
  ({
    id,
    title,
    meta,
  }: {
    id: ToolCardId
    title: string
    meta?: ReactNode
  }) => (
    <AccordionTrigger
      data-tool-card-trigger={id}
      className={clsxm(
        'group/tool-trigger -m-px rounded-md px-2.5 py-2 text-[0.78rem] font-medium leading-none text-lf-on-photo-ink/88 transition-colors duration-150 ease-out',
        'hover:text-lf-on-photo-ink',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-lf-green/80',
        'data-[state=open]:text-lf-on-photo-ink',
        'data-[state=closed]:text-lf-on-photo-ink/64',
        '[&_[data-slot=accordion-trigger-chevron]_i]:!size-[13px] [&_[data-slot=accordion-trigger-chevron]_i]:!text-lf-on-photo-ink/40 group-hover/tool-trigger:[&_[data-slot=accordion-trigger-chevron]_i]:!text-lf-on-photo-ink/64 data-[state=open]:[&_[data-slot=accordion-trigger-chevron]_i]:!text-lf-on-photo-ink/72',
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden="true"
          data-tool-card-state-indicator
          className="size-1.5 shrink-0 rounded-lf-pill bg-lf-on-photo-ink/28 transition-colors duration-150 group-data-[state=open]/tool-trigger:bg-lf-amber"
        />
        <span className="truncate">{title}</span>
        {meta != null && (
          <span
            aria-hidden="true"
            className="truncate text-[0.68rem] font-medium tabular-nums text-lf-on-photo-ink/44"
          >
            {meta}
          </span>
        )}
      </span>
    </AccordionTrigger>
  ),
)

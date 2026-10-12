'use client'

import * as AccordionPrimitive from '@radix-ui/react-accordion'
import * as React from 'react'

import { clsxm } from '~/lib/cn'

/**
 * How long a panel takes to fold or unfold. The CSS transition reads it
 * through `--accordion-duration`, and a closing panel stays rendered for
 * exactly this long before it is hidden, so the two cannot drift apart.
 */
const ACCORDION_COLLAPSE_MS = 220

type AccordionValue = string | string[] | undefined

const AccordionOpenContext = React.createContext<ReadonlySet<string>>(new Set())

type AccordionItemContextType = {
  open: boolean
  triggerId: string
  contentId: string
}

const AccordionItemContext = React.createContext<
  AccordionItemContextType | undefined
>(undefined)

const useAccordionItem = (): AccordionItemContextType => {
  const context = React.use(AccordionItemContext)
  if (!context) {
    throw new Error('useAccordionItem must be used within an AccordionItem')
  }
  return context
}

function toOpenSet(value: AccordionValue): ReadonlySet<string> {
  if (value == null || value === '') return new Set()
  return new Set(Array.isArray(value) ? value : [value])
}

type AccordionProps = React.ComponentProps<typeof AccordionPrimitive.Root>

/**
 * Radix owns the keyboard model and the trigger semantics; this wrapper
 * always drives it with an explicit value so each item can read its own open
 * state during render instead of observing `data-state` after the commit.
 */
function Accordion(props: AccordionProps) {
  const controlled = props.value !== undefined
  const [uncontrolled, setUncontrolled] = React.useState<AccordionValue>(
    props.defaultValue,
  )
  const value: AccordionValue = controlled ? props.value : uncontrolled
  const openSet = React.useMemo(() => toOpenSet(value), [value])
  const { onValueChange } = props
  const handleValueChange = React.useCallback(
    (next: string | string[]) => {
      if (!controlled) setUncontrolled(next)
      ;(onValueChange as ((value: string | string[]) => void) | undefined)?.(
        next,
      )
    },
    [controlled, onValueChange],
  )

  return (
    <AccordionOpenContext value={openSet}>
      <AccordionPrimitive.Root
        data-slot="accordion"
        {...(props as AccordionPrimitive.AccordionMultipleProps)}
        value={value as string[]}
        onValueChange={handleValueChange}
      />
    </AccordionOpenContext>
  )
}

type AccordionItemProps = React.ComponentProps<
  typeof AccordionPrimitive.Item
> & {
  children: React.ReactNode
}

function AccordionItem({
  className,
  children,
  value,
  ...props
}: AccordionItemProps) {
  const open = React.use(AccordionOpenContext).has(value)
  const triggerId = React.useId()
  const contentId = React.useId()
  const context = React.useMemo(
    () => ({ open, triggerId, contentId }),
    [open, triggerId, contentId],
  )

  return (
    <AccordionItemContext value={context}>
      <AccordionPrimitive.Item
        data-slot="accordion-item"
        value={value}
        className={clsxm('border-border border-b', className)}
        {...props}
      >
        {children}
      </AccordionPrimitive.Item>
    </AccordionItemContext>
  )
}

type AccordionTriggerProps = React.ComponentProps<
  typeof AccordionPrimitive.Trigger
> & {
  chevron?: boolean
}

function AccordionTrigger({
  className,
  children,
  chevron = true,
  ...props
}: AccordionTriggerProps) {
  const { triggerId, contentId } = useAccordionItem()

  return (
    <AccordionPrimitive.Header data-slot="accordion-header" className="flex">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        id={triggerId}
        aria-controls={contentId}
        className={clsxm(
          'group/accordion-trigger flex flex-1 items-center justify-between rounded-md py-4 text-start font-medium transition-colors duration-150 hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
          className,
        )}
        {...props}
      >
        {children}

        {chevron && (
          <span
            aria-hidden="true"
            data-slot="accordion-trigger-chevron"
            className="inline-flex transition-transform duration-(--accordion-duration) ease-lf-standard group-data-[state=open]/accordion-trigger:rotate-180 motion-reduce:transition-none"
            style={accordionDurationStyle}
          >
            <i className="text-text-secondary i-mingcute-down-line size-4 shrink-0" />
          </span>
        )}
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  )
}

const accordionDurationStyle = {
  '--accordion-duration': `${ACCORDION_COLLAPSE_MS}ms`,
} as React.CSSProperties

type AccordionContentProps = Omit<React.ComponentProps<'div'>, 'children'> & {
  children: React.ReactNode
}

/**
 * The panel body stays mounted once rendered: a closed panel is hidden behind
 * `<Activity>`, which keeps its state and DOM, unmounts its effects, and
 * renders its updates at idle priority. Opening a panel therefore reveals
 * work that is already done instead of mounting the whole subtree on the
 * frame the fold starts.
 *
 * The fold is a `grid-template-rows` transition between `0fr` and `1fr`, so
 * each frame restyles one element and relayouts nothing inside the panel. A
 * panel that opens from `hidden` starts at `0fr` through `@starting-style`.
 * A closing panel stays rendered (inert) until the fold finishes, then hides.
 */
function AccordionContent({
  className,
  children,
  style,
  ...props
}: AccordionContentProps) {
  const { open, triggerId, contentId } = useAccordionItem()
  const [present, setPresent] = React.useState(open)
  if (open && !present) setPresent(true)

  React.useEffect(() => {
    if (open || !present) return
    const timer = setTimeout(setPresent, ACCORDION_COLLAPSE_MS, false)
    return () => clearTimeout(timer)
  }, [open, present])

  return (
    <div
      role="region"
      id={contentId}
      aria-labelledby={triggerId}
      data-slot="accordion-content"
      data-state={open ? 'open' : 'closed'}
      hidden={!present}
      inert={!open}
      className="grid grid-rows-[1fr] transition-[grid-template-rows] duration-(--accordion-duration) ease-lf-standard starting:grid-rows-[0fr] data-[state=closed]:grid-rows-[0fr] motion-reduce:transition-none"
      style={{ ...accordionDurationStyle, ...style }}
      {...props}
    >
      <div className="min-h-0 overflow-hidden">
        <div
          data-slot="accordion-content-body"
          className={clsxm(
            'transition-[opacity,translate] duration-(--accordion-duration) ease-lf-standard starting:-translate-y-1 starting:opacity-0 motion-reduce:transition-none',
            open ? 'opacity-100' : '-translate-y-1 opacity-0',
          )}
        >
          <React.Activity mode={present ? 'visible' : 'hidden'}>
            <div className={clsxm('pt-0 pb-4 text-sm', className)}>
              {children}
            </div>
          </React.Activity>
        </div>
      </div>
    </div>
  )
}

export {
  Accordion,
  AccordionContent,
  type AccordionContentProps,
  AccordionItem,
  type AccordionItemContextType,
  type AccordionItemProps,
  type AccordionProps,
  AccordionTrigger,
  type AccordionTriggerProps,
}

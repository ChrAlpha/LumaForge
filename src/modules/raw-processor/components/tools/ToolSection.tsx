import type { ReactNode } from 'react'

import { clsxm } from '~/lib/cn'

export function ToolSection({
  title,
  eyebrow,
  children,
  className,
}: {
  title: string
  eyebrow?: string
  children: ReactNode
  className?: string
}) {
  return (
    <section
      aria-label={title}
      className={clsxm(
        'border-b border-[color:--color-raw-hairline] py-3.5 first:pt-0 last:border-b-0',
        className,
      )}
    >
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <h2 className="m-0 text-[0.78rem] font-semibold leading-none text-[color:--color-raw-ink]">
          {title}
        </h2>
        {eyebrow && (
          <p className="m-0 text-[0.72rem] leading-snug text-[color:--color-raw-ink-soft]">
            {eyebrow}
          </p>
        )}
      </div>
      {children}
    </section>
  )
}

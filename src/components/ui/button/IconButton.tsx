import type { HTMLMotionProps } from 'motion/react'
import { m } from 'motion/react'
import type * as React from 'react'

import { clsxm } from '~/lib/cn'

type IconButtonProps = HTMLMotionProps<'button'> & {
  icon: React.ElementType
}

/** A square icon-only button; the consumer owns its size and colour. */
function IconButton({ icon: Icon, className, ...props }: IconButtonProps) {
  return (
    <m.button
      data-slot="icon-button"
      className={clsxm(
        'relative inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full [&_svg]:size-6',
        className,
      )}
      whileHover={{ scale: 1.05 }}
      whileTap={{ scale: 0.95 }}
      {...props}
    >
      <Icon aria-hidden="true" />
    </m.button>
  )
}

export { IconButton, type IconButtonProps }

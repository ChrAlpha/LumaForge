import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import type { HTMLMotionProps } from 'motion/react'
import { m as motion } from 'motion/react'
import type * as React from 'react'

import { clsxm } from '~/lib/cn'

type CheckboxProps = Omit<
  React.ComponentProps<typeof CheckboxPrimitive.Root>,
  'checked' | 'defaultChecked' | 'onCheckedChange'
> &
  Omit<HTMLMotionProps<'button'>, 'onChange'> & {
    checked: boolean
    onCheckedChange: (checked: boolean | 'indeterminate') => void
  }

/** A controlled checkbox; the consumer owns its size and colour. */
function Checkbox({
  className,
  checked,
  onCheckedChange,
  ...props
}: CheckboxProps) {
  return (
    <CheckboxPrimitive.Root
      {...props}
      checked={checked}
      onCheckedChange={onCheckedChange}
      asChild
    >
      <motion.button
        data-slot="checkbox"
        className={clsxm(
          'peer size-5 flex items-center justify-center shrink-0 rounded-sm transition-colors duration-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        whileTap={{ scale: 0.95 }}
        whileHover={{ scale: 1.05 }}
        {...props}
      >
        <CheckboxPrimitive.Indicator forceMount asChild>
          <motion.svg
            data-slot="checkbox-indicator"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth="3.5"
            stroke="currentColor"
            className="size-3.5"
            initial="unchecked"
            animate={checked ? 'checked' : 'unchecked'}
          >
            <motion.path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M4.5 12.75l6 6 9-13.5"
              variants={{
                checked: {
                  pathLength: 1,
                  opacity: 1,
                  transition: { duration: 0.2, delay: 0.2 },
                },
                unchecked: {
                  pathLength: 0,
                  opacity: 0,
                  transition: { duration: 0.2 },
                },
              }}
            />
          </motion.svg>
        </CheckboxPrimitive.Indicator>
      </motion.button>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox, type CheckboxProps }

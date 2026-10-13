import { Slot } from '@radix-ui/react-slot'
import * as React from 'react'
import type { VariantProps } from 'tailwind-variants'
import { tv } from 'tailwind-variants'

import { clsxm } from '~/lib/cn'

const buttonVariants = tv({
  base: [
    'relative inline-flex items-center justify-center gap-1.5 whitespace-nowrap',
    'rounded-lf-control border border-transparent text-center font-medium',
    'transition-colors duration-150 ease-out',
    'disabled:pointer-events-none disabled:opacity-55',
    'active:scale-[0.985]',
    'outline-offset-2 outline-0 focus-visible:outline-2 outline-accent',
  ],
  variants: {
    variant: {
      primary: [
        'bg-lf-green text-lf-on-surface',
        'shadow-[0_1px_2px_oklch(0.10_0.020_78/0.18),inset_0_1px_0_oklch(0.99_0.012_86/0.30)]',
        'hover:bg-lf-green-hover',
      ],
      secondary: [
        'bg-lf-surface-raised text-lf-on-surface/85 border-[oklch(from_var(--color-lf-on-surface)_l_c_h_/_0.08)]',
        'hover:bg-lf-surface-sunk hover:text-lf-on-surface',
        'shadow-lf-soft',
      ],
      light: [
        'bg-transparent text-lf-on-surface/80',
        'hover:bg-[oklch(from_var(--color-lf-on-surface)_l_c_h_/_0.05)] hover:text-lf-on-surface',
      ],
      ghost: [
        'bg-transparent text-lf-on-surface-soft',
        'hover:bg-[oklch(from_var(--color-lf-on-surface)_l_c_h_/_0.04)] hover:text-lf-on-surface',
      ],
      destructive: [
        'bg-lf-rose text-lf-surface',
        'shadow-[0_1px_2px_oklch(0.10_0.020_78/0.18),inset_0_1px_0_oklch(0.99_0.012_86/0.25)]',
        'hover:bg-[oklch(from_var(--color-lf-rose)_calc(l+0.04)_c_h)]',
      ],
    },
    size: {
      sm: ['h-8 px-3 text-[0.78rem]'],
      md: ['h-9 px-3.5 text-lf-body'],
    },
  },
  defaultVariants: {
    variant: 'primary',
    size: 'md',
  },
})

interface ButtonProps
  extends
    React.ComponentPropsWithoutRef<'button'>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
  isLoading?: boolean
  loadingText?: string
  size?: 'sm' | 'md'
}

const Button = ({
  ref: forwardedRef,
  asChild,
  isLoading = false,
  loadingText,
  className,
  disabled,
  variant,
  size = 'md',
  children,
  ...props
}: ButtonProps & { ref?: React.RefObject<HTMLButtonElement | null> }) => {
  const Component = asChild ? Slot : 'button'
  return (
    <Component
      ref={forwardedRef}
      className={clsxm(buttonVariants({ variant, size }), className)}
      disabled={disabled || isLoading}
      data-lf-button
      {...props}
    >
      {isLoading ? (
        <span className="pointer-events-none flex shrink-0 items-center justify-center gap-1.5">
          <i
            className="size-4 shrink-0 animate-spin i-mingcute-loading-3-line"
            aria-hidden="true"
          />
          <span className="sr-only">{loadingText ?? 'Loading'}</span>
          {loadingText ?? children}
        </span>
      ) : (
        children
      )}
    </Component>
  )
}

Button.displayName = 'Button'

export { Button, type ButtonProps }

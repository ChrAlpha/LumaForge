import { Search } from 'lucide-react'
import type * as React from 'react'

import { clsxm } from '~/lib/cn'

const inputBase = [
  'relative block w-full appearance-none rounded-md border px-2.5 py-2 shadow-xs outline-hidden transition sm:text-sm',
  'border-border text-text placeholder:text-placeholder-text bg-background',
  'disabled:border-border disabled:bg-disabled-control disabled:text-disabled-text',
  'file:-my-2 file:-ml-2.5 file:cursor-pointer file:rounded-l-[5px] file:rounded-r-none file:border-0 file:px-3 file:py-2 file:outline-hidden focus:outline-hidden disabled:pointer-events-none file:disabled:pointer-events-none',
  'file:border-solid file:border-border file:bg-fill file:text-placeholder-text file:hover:bg-fill-secondary',
  'file:[border-inline-end-width:1px] file:[margin-inline-end:0.75rem]',
  'file:disabled:bg-disabled-control file:disabled:text-disabled-text',
  'focus:ring-2 focus:ring-primary/20 focus:border-primary',
  'aria-invalid:ring-2 aria-invalid:ring-red/20 aria-invalid:border-red invalid:ring-2 invalid:ring-red/20 invalid:border-red',
  '[&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden',
]

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  inputClassName?: string
}

/** A text input; `type="search"` adds a leading search icon. */
const Input = ({
  ref: forwardedRef,
  className,
  inputClassName,
  type,
  ...props
}: InputProps & { ref?: React.RefObject<HTMLInputElement | null> }) => {
  const isSearch = type === 'search'

  return (
    <div className={clsxm('relative w-full', className)}>
      <input
        ref={forwardedRef}
        type={type}
        className={clsxm(inputBase, isSearch && 'pl-8', inputClassName)}
        {...props}
      />
      {isSearch && (
        <div className="pointer-events-none absolute bottom-0 left-2 flex h-full items-center justify-center text-placeholder-text">
          <Search className="size-[1.125rem] shrink-0" aria-hidden="true" />
        </div>
      )}
    </div>
  )
}

export { Input, type InputProps }

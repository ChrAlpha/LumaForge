'use client'

import * as DialogPrimitive from '@radix-ui/react-dialog'
import type * as React from 'react'

import { cn } from '~/lib/cn'

type DialogProps = React.ComponentProps<typeof DialogPrimitive.Root>

function Dialog(props: DialogProps) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

type DialogTitleProps = React.ComponentProps<typeof DialogPrimitive.Title>

function DialogTitle({ className, ...props }: DialogTitleProps) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        'text-lg font-semibold leading-none tracking-tight',
        className,
      )}
      {...props}
    />
  )
}

type DialogDescriptionProps = React.ComponentProps<
  typeof DialogPrimitive.Description
>

function DialogDescription({ className, ...props }: DialogDescriptionProps) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogDescription,
  type DialogDescriptionProps,
  type DialogProps,
  DialogTitle,
  type DialogTitleProps,
}

import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva('inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap [&_svg]:size-3.5', {
  variants: {
    tone: {
      neutral: 'border-border bg-neutral-subtle text-neutral',
      success: 'border-success/25 bg-success-subtle text-success',
      warning: 'border-warning/30 bg-warning-subtle text-warning',
      danger: 'border-danger/25 bg-danger-subtle text-danger',
      info: 'border-info/25 bg-info-subtle text-info',
      primary: 'border-primary/25 bg-accent text-accent-foreground',
      outline: 'border-border text-foreground'
    }
  },
  defaultVariants: { tone: 'neutral' }
})

function Badge({ className, tone, ...props }: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ tone }), className)} {...props} />
}

export { Badge, badgeVariants }

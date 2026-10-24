import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'

const alertVariants = cva('relative flex w-full gap-3 rounded-lg border px-4 py-3 text-sm [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0', {
  variants: {
    tone: {
      info: 'border-info/25 bg-info-subtle text-foreground [&>svg]:text-info',
      success: 'border-success/25 bg-success-subtle text-foreground [&>svg]:text-success',
      warning: 'border-warning/30 bg-warning-subtle text-foreground [&>svg]:text-warning',
      danger: 'border-danger/25 bg-danger-subtle text-foreground [&>svg]:text-danger',
      neutral: 'bg-muted/60 text-foreground [&>svg]:text-muted-foreground'
    }
  },
  defaultVariants: { tone: 'info' }
})

const ICONS = { info: Info, success: CircleCheck, warning: TriangleAlert, danger: CircleAlert, neutral: Info }

function Alert({ className, tone, title, children, action, ...props }: Omit<React.ComponentProps<'div'>, 'title'> & VariantProps<typeof alertVariants> & { title?: React.ReactNode; action?: React.ReactNode }) {
  const Icon = ICONS[tone ?? 'info']
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cn(alertVariants({ tone }), className)} {...props}>
      <Icon aria-hidden />
      <div className="flex-1 space-y-1">
        {title && <div className="font-medium leading-tight">{title}</div>}
        {children && <div className="text-[13px] text-muted-foreground [&_strong]:text-foreground">{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  )
}

export { Alert }

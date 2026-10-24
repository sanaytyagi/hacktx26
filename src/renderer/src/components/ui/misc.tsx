import * as React from 'react'
import { Switch as Sw, Checkbox as Cb, Separator as Sep, Progress as Pr, Tooltip as Tt, DropdownMenu as Dm, Collapsible as Co, Popover as Po } from 'radix-ui'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

export function Switch({ className, ...props }: React.ComponentProps<typeof Sw.Root>) {
  return (
    <Sw.Root className={cn('peer inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent bg-input shadow-xs transition-colors data-[state=checked]:bg-primary disabled:opacity-50', className)} {...props}>
      <Sw.Thumb className="pointer-events-none block size-4 rounded-full bg-card shadow-sm transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0.5" />
    </Sw.Root>
  )
}

export function Checkbox({ className, ...props }: React.ComponentProps<typeof Cb.Root>) {
  return (
    <Cb.Root className={cn('peer size-4 shrink-0 rounded-[4px] border border-input bg-card shadow-xs data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground disabled:opacity-50', className)} {...props}>
      <Cb.Indicator className="flex items-center justify-center">
        <Check className="size-3.5" />
      </Cb.Indicator>
    </Cb.Root>
  )
}

export function Separator({ className, orientation = 'horizontal', ...props }: React.ComponentProps<typeof Sep.Root>) {
  return <Sep.Root orientation={orientation} className={cn('shrink-0 bg-border', orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px', className)} {...props} />
}

export function Progress({ className, value, ...props }: React.ComponentProps<typeof Pr.Root>) {
  return (
    <Pr.Root className={cn('relative h-2 w-full overflow-hidden rounded-full bg-muted', className)} value={value} {...props}>
      <Pr.Indicator className="h-full bg-primary transition-all" style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%` }} />
    </Pr.Root>
  )
}

export const TooltipProvider = Tt.Provider
export function Tooltip({ content, children }: { content: React.ReactNode; children: React.ReactNode }) {
  return (
    <Tt.Root delayDuration={300}>
      <Tt.Trigger asChild>{children}</Tt.Trigger>
      <Tt.Portal>
        <Tt.Content sideOffset={4} className="z-50 max-w-xs rounded-md bg-foreground px-2 py-1 text-xs text-background shadow">
          {content}
        </Tt.Content>
      </Tt.Portal>
    </Tt.Root>
  )
}

export const DropdownMenu = Dm.Root
export const DropdownMenuTrigger = Dm.Trigger
export function DropdownMenuContent({ className, ...props }: React.ComponentProps<typeof Dm.Content>) {
  return (
    <Dm.Portal>
      <Dm.Content sideOffset={4} className={cn('z-50 min-w-48 rounded-md border bg-popover p-1 text-popover-foreground shadow-md', className)} {...props} />
    </Dm.Portal>
  )
}
export function DropdownMenuItem({ className, ...props }: React.ComponentProps<typeof Dm.Item>) {
  return <Dm.Item className={cn('flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-muted data-[disabled]:opacity-50 [&_svg]:size-4', className)} {...props} />
}
export const DropdownMenuLabel = ({ className, ...p }: React.ComponentProps<typeof Dm.Label>) => <Dm.Label className={cn('px-2 py-1 text-xs font-medium text-muted-foreground', className)} {...p} />
export const DropdownMenuSeparator = ({ className, ...p }: React.ComponentProps<typeof Dm.Separator>) => <Dm.Separator className={cn('my-1 h-px bg-border', className)} {...p} />

export const Collapsible = Co.Root
export const CollapsibleTrigger = Co.Trigger
export const CollapsibleContent = Co.Content

export const Popover = Po.Root
export const PopoverTrigger = Po.Trigger
export function PopoverContent({ className, ...props }: React.ComponentProps<typeof Po.Content>) {
  return (
    <Po.Portal>
      <Po.Content sideOffset={6} className={cn('z-50 w-80 rounded-md border bg-popover p-3 text-popover-foreground shadow-md outline-none', className)} {...props} />
    </Po.Portal>
  )
}

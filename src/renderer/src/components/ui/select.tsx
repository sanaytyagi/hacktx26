import * as React from 'react'
import { Select as S } from 'radix-ui'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

const Select = S.Root
const SelectValue = S.Value
const SelectGroup = S.Group

function SelectTrigger({ className, children, ...props }: React.ComponentProps<typeof S.Trigger>) {
  return (
    <S.Trigger className={cn('flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-card px-3 text-sm shadow-xs data-[placeholder]:text-muted-foreground disabled:opacity-50 [&>span]:truncate', className)} {...props}>
      {children}
      <S.Icon asChild>
        <ChevronDown className="size-4 opacity-60" />
      </S.Icon>
    </S.Trigger>
  )
}
function SelectContent({ className, children, ...props }: React.ComponentProps<typeof S.Content>) {
  return (
    <S.Portal>
      <S.Content position="popper" sideOffset={4} className={cn('z-50 max-h-80 min-w-[8rem] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md', className)} {...props}>
        <S.Viewport className="p-1 w-full min-w-[var(--radix-select-trigger-width)]">{children}</S.Viewport>
      </S.Content>
    </S.Portal>
  )
}
function SelectItem({ className, children, ...props }: React.ComponentProps<typeof S.Item>) {
  return (
    <S.Item className={cn('relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pr-8 pl-2 text-sm outline-none data-[highlighted]:bg-muted data-[disabled]:opacity-50', className)} {...props}>
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <S.ItemIndicator>
          <Check className="size-4" />
        </S.ItemIndicator>
      </span>
      <S.ItemText>{children}</S.ItemText>
    </S.Item>
  )
}
const SelectLabel = ({ className, ...p }: React.ComponentProps<typeof S.Label>) => <S.Label className={cn('px-2 py-1 text-xs text-muted-foreground', className)} {...p} />

export { Select, SelectValue, SelectGroup, SelectTrigger, SelectContent, SelectItem, SelectLabel }

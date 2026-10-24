import * as React from 'react'
import { ArrowDown, ArrowUp, ChevronRight, Plus, Trash2, ShieldCheck, Bot, Cog, UserCheck, Hand } from 'lucide-react'
import { AgentSpecSchema, AUTOMATION_LABELS, type AgentSpec, type AgentStep, type AutomationKind } from '@shared/domain'
import { useApi } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Checkbox, Collapsible, CollapsibleContent, CollapsibleTrigger, Switch } from '@/components/ui/misc'
import { Alert } from '@/components/ui/alert'
import { Field, StatusBadge } from './common'
import { cn } from '@/lib/utils'

export const KIND_ICON: Record<AutomationKind, typeof Bot> = { agent: Bot, deterministic: Cog, human_review: UserCheck, manual: Hand }
export const KIND_HELP: Record<AutomationKind, string> = {
  agent: 'A model reads the inputs and decides what to write, optionally calling approved tools.',
  deterministic: 'Calls one tool with fixed arguments. Same inputs, same result.',
  human_review: 'Pauses the run until a person approves, edits, or rejects the result.',
  manual: 'A person does this outside Relay and marks it done; the run waits.'
}

export function KindBadge({ kind }: { kind: AutomationKind }) {
  const Icon = KIND_ICON[kind]
  const tone = kind === 'agent' ? 'primary' : kind === 'deterministic' ? 'info' : kind === 'human_review' ? 'warning' : 'neutral'
  return (
    <Badge tone={tone}>
      <Icon aria-hidden /> {AUTOMATION_LABELS[kind]}
    </Badge>
  )
}

function newStep(n: number): AgentStep {
  return { id: `step_${n}`, title: 'New step', description: '', kind: 'human_review', args: {}, prompt: '', agentTools: [], outputFields: [], approvalBefore: false, onError: 'fail', maxRetries: 1 }
}

export function validateSpec(spec: AgentSpec): string[] {
  const r = AgentSpecSchema.safeParse(spec)
  const issues = r.success ? [] : r.error.issues.map((i) => `${i.path.join(' › ')}: ${i.message}`)
  const ids = new Set<string>()
  for (const s of spec.steps) {
    if (ids.has(s.id)) issues.push(`Two steps use the id “${s.id}”.`)
    ids.add(s.id)
    if (s.kind === 'deterministic' && !s.tool) issues.push(`“${s.title}” needs a tool, or change it to a human step.`)
  }
  return issues
}

export function SpecEditor({ spec, onChange, readOnly }: { spec: AgentSpec; onChange: (s: AgentSpec) => void; readOnly?: boolean }) {
  const catalog = useApi('tools.catalog')
  const collections = useApi('data.collections')
  const providers = useApi('providers.list')
  const tools = (catalog.data?.tools ?? []).filter((t) => t.status !== 'not_supported')
  const set = (patch: Partial<AgentSpec>) => onChange({ ...spec, ...patch })
  const setStep = (i: number, patch: Partial<AgentStep>) => set({ steps: spec.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) })
  const move = (i: number, d: -1 | 1) => {
    const steps = [...spec.steps]
    const [x] = steps.splice(i, 1)
    steps.splice(i + d, 0, x)
    set({ steps })
  }
  const issues = validateSpec(spec)
  const usable = (collections.data ?? []).filter((c) => c.myPurposes.includes('retrieval') || spec.collections.includes(c.id))
  return (
    <fieldset disabled={readOnly} className="space-y-6">
      <Field label="Instructions" hint="Applies to every model step. Retrieved content is always treated as data, never as instructions.">
        <Textarea value={spec.instructions} onChange={(e) => set({ instructions: e.target.value })} rows={3} />
      </Field>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Inputs</h3>
          {!readOnly && (
            <Button type="button" size="sm" variant="outline" onClick={() => set({ inputs: [...spec.inputs, { key: `input_${spec.inputs.length + 1}`, label: 'New input', type: 'string', required: true, description: '' }] })}>
              <Plus /> Add input
            </Button>
          )}
        </div>
        {spec.inputs.length === 0 && <p className="text-sm text-muted-foreground">This agent takes no inputs.</p>}
        {spec.inputs.map((f, i) => (
          <div key={i} className="grid grid-cols-[1fr_1.4fr_9rem_auto_auto] items-end gap-2">
            <Field label="Key">
              <Input value={f.key} onChange={(e) => set({ inputs: spec.inputs.map((x, j) => (j === i ? { ...x, key: e.target.value.replace(/[^a-zA-Z0-9_]/g, '_') } : x)) })} aria-label="Input key" />
            </Field>
            <Field label="Label">
              <Input value={f.label} onChange={(e) => set({ inputs: spec.inputs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
            </Field>
            <Field label="Type">
              <Select value={f.type} onValueChange={(v) => set({ inputs: spec.inputs.map((x, j) => (j === i ? { ...x, type: v as typeof f.type } : x)) })}>
                <SelectTrigger aria-label="Input type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {['string', 'text', 'number', 'url', 'boolean'].map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <label className="flex h-9 items-center gap-2 text-sm">
              <Checkbox checked={f.required} onCheckedChange={(v) => set({ inputs: spec.inputs.map((x, j) => (j === i ? { ...x, required: !!v } : x)) })} /> Required
            </label>
            {!readOnly && (
              <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove input ${f.label}`} onClick={() => set({ inputs: spec.inputs.filter((_, j) => j !== i) })}>
                <Trash2 />
              </Button>
            )}
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Data this agent may read</h3>
        <p className="text-xs text-muted-foreground">Only collections you have “use in agents” access to are listed. Access is re-checked every time the agent runs.</p>
        <div className="flex flex-wrap gap-2">
          {usable.length === 0 && <span className="text-sm text-muted-foreground">You don’t have access to any collections yet. Request access in Data.</span>}
          {usable.map((c) => {
            const on = spec.collections.includes(c.id)
            return (
              <label key={c.id} className={cn('flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm', on && 'border-primary bg-accent/50')}>
                <Checkbox checked={on} onCheckedChange={(v) => set({ collections: v ? [...spec.collections, c.id] : spec.collections.filter((x) => x !== c.id) })} />
                {c.name}
                {!c.allowExternal && <Badge tone="neutral">Local only</Badge>}
                {!c.myPurposes.includes('retrieval') && <Badge tone="danger">No access</Badge>}
              </label>
            )
          })}
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Steps (run in order)</h3>
          {!readOnly && (
            <Button type="button" size="sm" variant="outline" onClick={() => set({ steps: [...spec.steps, newStep(spec.steps.length + 1)] })}>
              <Plus /> Add step
            </Button>
          )}
        </div>
        <ol className="space-y-3">
          {spec.steps.map((s, i) => (
            <li key={i}>
              <StepCard
                index={i}
                step={s}
                spec={spec}
                tools={tools}
                providers={providers.data ?? []}
                readOnly={readOnly}
                onChange={(p) => setStep(i, p)}
                onMove={(d) => move(i, d)}
                onRemove={() => set({ steps: spec.steps.filter((_, j) => j !== i) })}
                isFirst={i === 0}
                isLast={i === spec.steps.length - 1}
              />
            </li>
          ))}
        </ol>
      </div>

      <Collapsible>
        <CollapsibleTrigger className="group flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground">
          <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" /> Advanced: outputs, default model and limits
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-3 space-y-4">
          <Field label="Default model for model steps" hint="Leave on automatic to use the workspace default provider.">
            <Select
              value={spec.defaultModel ? `${spec.defaultModel.providerId}|${spec.defaultModel.model}` : 'auto'}
              onValueChange={(v) => set({ defaultModel: v === 'auto' ? undefined : { providerId: v.split('|')[0], model: v.split('|')[1] } })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Automatic (workspace default)</SelectItem>
                {(providers.data ?? []).flatMap((p) =>
                  p.models.map((m) => (
                    <SelectItem key={`${p.id}|${m}`} value={`${p.id}|${m}`} disabled={!p.enabled || !p.configured}>
                      {p.name} · {m} {!p.configured ? '(not configured)' : !p.enabled ? '(disabled)' : p.external ? '' : '(local)'}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </Field>
          <div>
            <div className="mb-1 text-sm font-medium">Outputs</div>
            <p className="mb-2 text-xs text-muted-foreground">
              Use <code>{'{{steps.<id>.output.<field>}}'}</code> to pick values from steps.
            </p>
            {spec.outputs.map((o, i) => (
              <div key={i} className="mb-2 grid grid-cols-[1fr_1fr_2fr_auto] gap-2">
                <Input aria-label="Output key" value={o.key} onChange={(e) => set({ outputs: spec.outputs.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })} />
                <Input aria-label="Output label" value={o.label} onChange={(e) => set({ outputs: spec.outputs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
                <Input aria-label="Output source" value={o.from} onChange={(e) => set({ outputs: spec.outputs.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)) })} className="font-mono text-xs" />
                <Button type="button" size="icon-sm" variant="ghost" aria-label="Remove output" onClick={() => set({ outputs: spec.outputs.filter((_, j) => j !== i) })}>
                  <Trash2 />
                </Button>
              </div>
            ))}
            {!readOnly && (
              <Button type="button" size="sm" variant="outline" onClick={() => set({ outputs: [...spec.outputs, { key: 'result', label: 'Result', from: `{{steps.${spec.steps[spec.steps.length - 1]?.id ?? 'step'}.output}}` }] })}>
                <Plus /> Add output
              </Button>
            )}
          </div>
          <div className="grid grid-cols-5 gap-3">
            {(
              [
                ['maxToolCalls', 'Max tool calls'],
                ['maxTokens', 'Max tokens'],
                ['maxRuntimeSec', 'Max runtime (s)'],
                ['maxRetries', 'Max retries'],
                ['maxCostUsd', 'Max cost per run ($)']
              ] as const
            ).map(([k, label]) => (
              <Field key={k} label={label}>
                <Input type="number" min={0} step={k === 'maxCostUsd' ? 0.05 : 1} value={spec.limits[k]} onChange={(e) => set({ limits: { ...spec.limits, [k]: Number(e.target.value) } })} />
              </Field>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">Company caps apply on top of these limits.</p>
        </CollapsibleContent>
      </Collapsible>

      {issues.length > 0 && (
        <Alert tone="warning" title="Fix before saving">
          <ul className="list-disc pl-4">
            {issues.slice(0, 8).map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </Alert>
      )}
    </fieldset>
  )
}

type CatalogTool = { key: string; name: string; status: string; access: string; inputSchema: unknown; description: string; external: boolean }
type ProviderItem = { id: string; name: string; models: string[]; enabled: boolean; configured: boolean; external: boolean }

function StepCard({
  index,
  step: s,
  spec,
  tools,
  providers,
  readOnly,
  onChange,
  onMove,
  onRemove,
  isFirst,
  isLast
}: {
  index: number
  step: AgentStep
  spec: AgentSpec
  tools: CatalogTool[]
  providers: ProviderItem[]
  readOnly?: boolean
  onChange: (p: Partial<AgentStep>) => void
  onMove: (d: -1 | 1) => void
  onRemove: () => void
  isFirst: boolean
  isLast: boolean
}) {
  const [argsText, setArgsText] = React.useState(() => JSON.stringify(s.args, null, 2))
  const [argsError, setArgsError] = React.useState<string | null>(null)
  React.useEffect(() => {
    // Re-sync only when args changed from outside this editor (keeps the cursor while typing).
    setArgsText((cur) => {
      try {
        if (JSON.stringify(JSON.parse(cur)) === JSON.stringify(s.args)) return cur
      } catch {
        /* text is mid-edit */
      }
      return JSON.stringify(s.args, null, 2)
    })
  }, [s.args])
  const tool = tools.find((t) => t.key === s.tool)
  const earlier = spec.steps.slice(0, index).map((x) => x.id)
  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-start gap-3 border-b px-4 py-3">
        <div className="mt-1 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums">{index + 1}</div>
        <div className="grid flex-1 gap-2 sm:grid-cols-[1fr_14rem]">
          <Input aria-label={`Step ${index + 1} title`} value={s.title} onChange={(e) => onChange({ title: e.target.value })} className="font-medium" />
          <Select value={s.kind} onValueChange={(v) => onChange({ kind: v as AutomationKind })}>
            <SelectTrigger aria-label="How this step runs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(AUTOMATION_LABELS) as AutomationKind[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {AUTOMATION_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground sm:col-span-2">{KIND_HELP[s.kind]}</p>
        </div>
        {!readOnly && (
          <div className="flex shrink-0 gap-0.5">
            <Button type="button" size="icon-sm" variant="ghost" aria-label="Move up" disabled={isFirst} onClick={() => onMove(-1)}>
              <ArrowUp />
            </Button>
            <Button type="button" size="icon-sm" variant="ghost" aria-label="Move down" disabled={isLast} onClick={() => onMove(1)}>
              <ArrowDown />
            </Button>
            <Button type="button" size="icon-sm" variant="ghost" aria-label="Remove step" onClick={onRemove}>
              <Trash2 />
            </Button>
          </div>
        )}
      </div>
      <div className="space-y-3 px-4 py-3">
        {s.kind === 'deterministic' && (
          <div className="grid gap-3 lg:grid-cols-2">
            <Field label="Tool" hint={tool ? tool.description : 'Choose what this step does.'}>
              <Select value={s.tool ?? ''} onValueChange={(v) => onChange({ tool: v })}>
                <SelectTrigger aria-label="Tool">
                  <SelectValue placeholder="Choose a tool" />
                </SelectTrigger>
                <SelectContent>
                  {tools.map((t) => (
                    <SelectItem key={t.key} value={t.key}>
                      {t.name} {t.status !== 'available' ? `— ${t.status.replace(/_/g, ' ')}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {tool && tool.status !== 'available' && (
                <div className="pt-1">
                  <StatusBadge status={tool.status} />
                </div>
              )}
            </Field>
            <Field
              label="Arguments"
              hint={
                <>
                  JSON. Reference inputs with <code>{'{{inputs.key}}'}</code>
                  {earlier.length > 0 && (
                    <>
                      {' '}
                      or earlier steps with <code>{`{{steps.${earlier[earlier.length - 1]}.output}}`}</code>
                    </>
                  )}
                  .
                </>
              }
              error={argsError}
            >
              <Textarea
                value={argsText}
                rows={Math.min(10, Math.max(3, argsText.split('\n').length))}
                className="font-mono text-xs"
                aria-label="Tool arguments as JSON"
                onChange={(e) => {
                  setArgsText(e.target.value)
                  try {
                    const v = JSON.parse(e.target.value)
                    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Arguments must be a JSON object.')
                    setArgsError(null)
                    onChange({ args: v })
                  } catch (err) {
                    setArgsError((err as Error).message)
                  }
                }}
              />
            </Field>
          </div>
        )}
        {s.kind !== 'deterministic' && (
          <Field label={s.kind === 'agent' ? 'What the model should do' : 'Instructions for the person'}>
            <Textarea value={s.prompt} onChange={(e) => onChange({ prompt: e.target.value })} rows={3} />
          </Field>
        )}
        {s.kind === 'agent' && (
          <>
            <Field label="Context passed to the model" hint="JSON with template references. Everything here is treated as data." error={argsError}>
              <Textarea
                value={argsText}
                rows={Math.min(8, Math.max(3, argsText.split('\n').length))}
                className="font-mono text-xs"
                onChange={(e) => {
                  setArgsText(e.target.value)
                  try {
                    const v = JSON.parse(e.target.value)
                    setArgsError(null)
                    onChange({ args: v })
                  } catch (err) {
                    setArgsError((err as Error).message)
                  }
                }}
              />
            </Field>
            <OutputFields step={s} onChange={onChange} readOnly={readOnly} />
            <div className="space-y-1.5">
              <div className="text-sm font-medium">Tools the model may call</div>
              <p className="text-xs text-muted-foreground">Read-only tools are safest. Each call is permission-checked and counted against the run’s limits.</p>
              <div className="flex flex-wrap gap-2">
                {tools
                  .filter((t) => t.status === 'available' && t.key !== 'model.generate' && t.key !== 'human.review' && t.key !== 'agent.invoke')
                  .map((t) => {
                    const on = s.agentTools.includes(t.key)
                    return (
                      <label key={t.key} className={cn('flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs', on && 'border-primary bg-accent/50')}>
                        <Checkbox checked={on} onCheckedChange={(v) => onChange({ agentTools: v ? [...s.agentTools, t.key] : s.agentTools.filter((k) => k !== t.key) })} />
                        {t.name}
                        {t.access !== 'read' && <Badge tone="warning">{t.access}</Badge>}
                      </label>
                    )
                  })}
              </div>
            </div>
            <Field label="Model">
              <Select value={s.model ? `${s.model.providerId}|${s.model.model}` : 'default'} onValueChange={(v) => onChange({ model: v === 'default' ? undefined : { providerId: v.split('|')[0], model: v.split('|')[1] } })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">Agent default</SelectItem>
                  {providers.flatMap((p) =>
                    p.models.map((m) => (
                      <SelectItem key={`${p.id}|${m}`} value={`${p.id}|${m}`} disabled={!p.enabled || !p.configured}>
                        {p.name} · {m} {!p.configured ? '(not configured)' : !p.enabled ? '(disabled)' : ''}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </Field>
          </>
        )}
        {(s.kind === 'human_review' || s.kind === 'manual') && (
          <Field label="What to show the person" hint="Template references to earlier results, e.g. {{steps.draft.output}}.">
            <Input className="font-mono text-xs" value={String((s.args as { data?: unknown }).data ?? '')} onChange={(e) => onChange({ args: { ...s.args, data: e.target.value } })} />
          </Field>
        )}
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={s.approvalBefore} onCheckedChange={(v) => onChange({ approvalBefore: v })} aria-label="Require approval before this step" />
          <ShieldCheck className="size-4 text-muted-foreground" aria-hidden /> Ask me to approve before this step runs
        </label>
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
            <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" /> Advanced: repeat, condition, errors
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 grid gap-3 lg:grid-cols-2">
            <Field label="Step id" hint="Used in references like {{steps.id.output}}.">
              <Input value={s.id} className="font-mono text-xs" onChange={(e) => onChange({ id: e.target.value.replace(/[^a-zA-Z0-9_]/g, '_') })} />
            </Field>
            <Field label="Repeat for each item in" hint="Optional list reference, e.g. {{steps.search.output.results}}. Use {{item}} in arguments.">
              <Input value={s.forEach ?? ''} className="font-mono text-xs" onChange={(e) => onChange({ forEach: e.target.value || undefined })} />
            </Field>
            <Field label="Only run when (optional)">
              <div className="grid grid-cols-[1fr_7rem_1fr] gap-2">
                <Input aria-label="Condition value" className="font-mono text-xs" value={s.condition?.left ?? ''} placeholder="{{steps.x.output.count}}" onChange={(e) => onChange({ condition: e.target.value ? { op: s.condition?.op ?? 'truthy', left: e.target.value, right: s.condition?.right } : undefined })} />
                <Select value={s.condition?.op ?? 'truthy'} onValueChange={(v) => s.condition && onChange({ condition: { ...s.condition, op: v as 'eq' } })}>
                  <SelectTrigger aria-label="Condition operator">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {['truthy', 'falsy', 'eq', 'neq', 'gt', 'lt', 'contains'].map((o) => (
                      <SelectItem key={o} value={o}>
                        {o}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input aria-label="Compare with" className="font-mono text-xs" value={s.condition?.right ?? ''} onChange={(e) => s.condition && onChange({ condition: { ...s.condition, right: e.target.value } })} />
              </div>
            </Field>
            <Field label="If this step fails">
              <Select value={s.onError} onValueChange={(v) => onChange({ onError: v as AgentStep['onError'] })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fail">Stop the run</SelectItem>
                  <SelectItem value="skip">Skip and continue</SelectItem>
                  <SelectItem value="review">Ask me what to do</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </div>
  )
}

function OutputFields({ step, onChange, readOnly }: { step: AgentStep; onChange: (p: Partial<AgentStep>) => void; readOnly?: boolean }) {
  return (
    <div className="space-y-1.5">
      <div className="text-sm font-medium">Expected output fields</div>
      <p className="text-xs text-muted-foreground">Structured fields make results checkable. Leave empty for free text.</p>
      {step.outputFields.map((f, i) => (
        <div key={i} className="grid grid-cols-[10rem_8rem_1fr_auto] gap-2">
          <Input aria-label="Field name" className="font-mono text-xs" value={f.key} onChange={(e) => onChange({ outputFields: step.outputFields.map((x, j) => (j === i ? { ...x, key: e.target.value.replace(/[^a-zA-Z0-9_]/g, '_') } : x)) })} />
          <Select value={f.type} onValueChange={(v) => onChange({ outputFields: step.outputFields.map((x, j) => (j === i ? { ...x, type: v as typeof f.type } : x)) })}>
            <SelectTrigger aria-label="Field type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {['string', 'number', 'boolean', 'array', 'object'].map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input aria-label="Field description" value={f.description} onChange={(e) => onChange({ outputFields: step.outputFields.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)) })} />
          <Button type="button" size="icon-sm" variant="ghost" aria-label="Remove field" onClick={() => onChange({ outputFields: step.outputFields.filter((_, j) => j !== i) })}>
            <Trash2 />
          </Button>
        </div>
      ))}
      {!readOnly && (
        <Button type="button" size="sm" variant="outline" onClick={() => onChange({ outputFields: [...step.outputFields, { key: `field_${step.outputFields.length + 1}`, type: 'string', description: '' }] })}>
          <Plus /> Add field
        </Button>
      )}
    </div>
  )
}

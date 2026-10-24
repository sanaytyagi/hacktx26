import * as React from 'react'
import { ArrowLeft, ArrowRight, ChevronRight, CircleHelp, FileVideo, Lock, MessageSquareText, Plus, Send, Sparkles, Trash2, Video, Wand2, Hand } from 'lucide-react'
import { AUTOMATION_LABELS, CAPABILITY_LABELS, STEP_CAPABILITIES, type AgentSpec, type AutomationKind, type StepCapability, type WorkflowDraft, type WorkflowStep } from '@shared/domain'
import { call, useAction, useApi, type Out } from '@/lib/api'
import { navigate, setQuery, useLeaveGuard, useRoute } from '@/lib/router'
import { bytes, duration } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, Textarea } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Alert } from '@/components/ui/alert'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Checkbox, Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/misc'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, Loading, PageHeader, Query, ReasonDialog, StatusBadge } from '@/components/app/common'
import { SpecEditor, KindBadge, validateSpec } from '@/components/app/spec-editor'
import { RecorderPanel } from './recorder'

const STEPS = ['Capture your work', 'Review steps', 'Tools & data', 'Instructions', 'Test', 'Deploy'] as const

export function CreateAgentPage() {
  const { query } = useRoute()
  const wfId = query.wf
  const step = Number(query.step ?? (wfId ? 2 : 1))
  return (
    <>
      <PageHeader title="Create an agent" description="Show or describe the work, decide what to automate, choose approved tools and data, then test before going live." breadcrumb={<a href="#/agents">Agents</a>} />
      <Stepper current={step} wfId={wfId} />
      <div className="mt-5">
        {step === 1 && <CaptureStep start={query.start} wfId={wfId} />}
        {step >= 2 && wfId && <WorkflowSteps wfId={wfId} step={step} />}
        {step >= 2 && !wfId && <Alert tone="warning">Start by capturing or describing your work.</Alert>}
      </div>
    </>
  )
}

function Stepper({ current, wfId }: { current: number; wfId?: string }) {
  return (
    <ol className="flex flex-wrap items-center gap-1 text-sm" aria-label="Progress">
      {STEPS.map((label, i) => {
        const n = i + 1
        const done = n < current
        const reachable = n <= 4 && (n === 1 || !!wfId)
        return (
          <li key={label} className="flex items-center gap-1">
            <button
              disabled={!reachable}
              aria-current={n === current ? 'step' : undefined}
              onClick={() => reachable && setQuery({ step: String(n) })}
              className={cn('flex items-center gap-2 rounded-md px-2 py-1', n === current ? 'bg-accent font-medium text-accent-foreground' : done ? 'text-foreground hover:bg-muted' : 'text-muted-foreground', !reachable && 'cursor-default')}
            >
              <span className={cn('flex size-5 items-center justify-center rounded-full border text-[11px] tabular-nums', n === current && 'border-primary bg-primary text-primary-foreground', done && 'border-primary text-primary')}>{n}</span>
              {label}
            </button>
            {n < STEPS.length && <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden />}
          </li>
        )
      })}
    </ol>
  )
}

// ---------------- Step 1: capture ----------------

function CaptureStep({ start, wfId }: { start?: string; wfId?: string }) {
  const [mode, setMode] = React.useState<'record' | 'import' | 'describe'>((start as 'record') || 'record')
  const [recordingId, setRecordingId] = React.useState<string | null>(null)
  const create = useAction('workflows.create', { quiet: false })
  if (wfId) return <DetailsForm wfId={wfId} />
  async function begin(recId: string | null) {
    const r = await create.mutateAsync({ recordingId: recId, draft: { name: 'Untitled workflow' } })
    navigate(`/agents/new?wf=${r.id}&step=1`, { replace: true, force: true })
  }
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-3" role="tablist" aria-label="How to capture">
        {(
          [
            ['record', Video, 'Record a workflow', 'Record your screen while you do the task.'],
            ['import', FileVideo, 'Import recording', 'Use a video you already have (MP4, WebM, MOV).'],
            ['describe', MessageSquareText, 'Describe a workflow', 'Write the steps instead of recording.']
          ] as const
        ).map(([key, Icon, title, desc]) => (
          <button key={key} role="tab" aria-selected={mode === key} onClick={() => setMode(key)} className={cn('rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary/60', mode === key && 'border-primary ring-2 ring-primary/25')}>
            <Icon className="mb-2 size-5 text-primary" aria-hidden />
            <div className="font-medium">{title}</div>
            <div className="text-sm text-muted-foreground">{desc}</div>
          </button>
        ))}
      </div>
      <Card>
        <CardContent className="pt-4">
          {mode === 'record' && !recordingId && <RecorderPanel onSaved={setRecordingId} />}
          {mode === 'import' && !recordingId && <ImportPanel onImported={setRecordingId} />}
          {recordingId && (
            <div className="space-y-3">
              <RecordingPlayer id={recordingId} />
              <div className="flex gap-2">
                <Button onClick={() => begin(recordingId)} loading={create.isPending}>
                  Use this recording <ArrowRight />
                </Button>
                <Button variant="outline" onClick={() => setRecordingId(null)}>
                  Record or import another
                </Button>
              </div>
            </div>
          )}
          {mode === 'describe' && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">You’ll add the task details and steps on the next screen. Nothing is sent to any provider unless you ask for it.</p>
              <Button onClick={() => begin(null)} loading={create.isPending}>
                Start describing <ArrowRight />
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function ImportPanel({ onImported }: { onImported: (id: string) => void }) {
  const imp = useAction('recordings.import', { success: 'Video imported', invalidate: [] })
  async function pick() {
    const path = await call('app.openFile', { title: 'Choose a screen recording', kind: 'video' })
    if (!path) return
    const r = await imp.mutateAsync({ path })
    onImported(r.id)
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">Relay copies the video into its local data folder. Use this when screen recording is unavailable or you recorded with another tool.</p>
      <Button onClick={pick} loading={imp.isPending}>
        <FileVideo /> Choose video file
      </Button>
    </div>
  )
}

export function RecordingPlayer({ id, compact }: { id: string; compact?: boolean }) {
  const ref = React.useRef<HTMLVideoElement>(null)
  return (
    <video
      ref={ref}
      controls
      preload="metadata"
      src={`relay-media://recording/${id}`}
      className={cn('w-full rounded-lg border bg-black', compact ? 'max-h-56' : 'max-h-[420px]')}
      aria-label="Recording playback"
      onLoadedMetadata={(e) => {
        const d = e.currentTarget.duration
        if (Number.isFinite(d) && d > 0) void call('recordings.setDuration', { id, durationSec: d }).catch(() => undefined)
      }}
    />
  )
}

type Wf = Out<'workflows.get'>

function useWorkflowDraft(wfId: string) {
  const q = useApi('workflows.get', { id: wfId })
  const [draft, setDraft] = React.useState<WorkflowDraft | null>(null)
  const [dirty, setDirty] = React.useState(false)
  const save = useAction('workflows.update', { invalidate: ['workflows.'], quiet: false })
  const edits = React.useRef(0)
  React.useEffect(() => {
    if (q.data && !dirty) setDraft(q.data.draft)
  }, [q.data, dirty])
  // Autosave so work is preserved when navigating. Only mark clean if nothing changed meanwhile.
  React.useEffect(() => {
    if (!dirty || !draft) return
    const at = edits.current
    const t = setTimeout(() => save.mutate({ id: wfId, draft }, { onSuccess: () => edits.current === at && setDirty(false) }), 700)
    return () => clearTimeout(t)
  }, [draft, dirty])
  useLeaveGuard(dirty ? 'Your latest changes are still saving. Leave anyway?' : null)
  const update = (patch: Partial<WorkflowDraft>) => {
    edits.current++
    setDraft((d) => (d ? { ...d, ...patch } : d))
    setDirty(true)
  }
  const flush = async () => {
    if (draft && dirty) {
      const at = edits.current
      await save.mutateAsync({ id: wfId, draft })
      if (edits.current === at) setDirty(false)
    }
  }
  return { q, draft, update, flush, saving: save.isPending || dirty }
}

function DetailsForm({ wfId }: { wfId: string }) {
  const { q, draft, update, flush, saving } = useWorkflowDraft(wfId)
  const [analyzeOpen, setAnalyzeOpen] = React.useState(false)
  if (!draft || !q.data) return <Query q={q}>{() => <Loading />}</Query>
  const wf = q.data
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
      <Card>
        <CardHeader>
          <CardTitle>About this task</CardTitle>
          <CardDescription>Plain language is fine. These details guide the automation plan.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="Task name" className="md:col-span-2">
            <Input value={draft.name} onChange={(e) => update({ name: e.target.value })} />
          </Field>
          <Field label="Goal" className="md:col-span-2" hint="What does “done” look like?">
            <Textarea value={draft.goal} onChange={(e) => update({ goal: e.target.value })} rows={2} />
          </Field>
          <Field label="How often do you do it? (times per week)">
            <Input type="number" min={0} step={0.5} value={draft.frequencyPerWeek} onChange={(e) => update({ frequencyPerWeek: Number(e.target.value) })} />
          </Field>
          <Field label="About how long does it take? (minutes)">
            <Input type="number" min={0} value={draft.minutesPerRun} onChange={(e) => update({ minutesPerRun: Number(e.target.value) })} />
          </Field>
          <Field label="Narration or written explanation" className="md:col-span-2" hint="Walk through what you do and why, especially anything not visible on screen.">
            <Textarea value={draft.narration} onChange={(e) => update({ narration: e.target.value })} rows={4} />
          </Field>
          <Field label="Rules you follow">
            <Textarea value={draft.rules} onChange={(e) => update({ rules: e.target.value })} rows={3} />
          </Field>
          <Field label="Exceptions and edge cases">
            <Textarea value={draft.exceptions} onChange={(e) => update({ exceptions: e.target.value })} rows={3} />
          </Field>
          <Field label="Desired output" className="md:col-span-2" hint="Fields, format, and where the result should go.">
            <Textarea value={draft.desiredOutput} onChange={(e) => update({ desiredOutput: e.target.value })} rows={2} />
          </Field>
        </CardContent>
      </Card>
      <div className="space-y-4">
        {wf.recording ? (
          <Card>
            <CardHeader>
              <CardTitle>Your recording</CardTitle>
              <CardDescription>
                {bytes(wf.recording.size)}
                {wf.recording.duration_sec ? ` · ${duration(wf.recording.duration_sec)}` : ''} · stored locally
              </CardDescription>
            </CardHeader>
            <CardContent>
              <RecordingPlayer id={wf.recording.id} compact />
            </CardContent>
          </Card>
        ) : (
          <Alert tone="neutral" title="No recording">
            You’re describing this workflow in writing.
          </Alert>
        )}
        <Card>
          <CardHeader>
            <CardTitle>Next: list the steps</CardTitle>
            <CardDescription>Let a configured model draft the steps from your recording and notes, or write them yourself.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button className="w-full" onClick={async () => { await flush(); setAnalyzeOpen(true) }}>
              <Sparkles /> Draft steps with a model
            </Button>
            <Button
              variant="outline"
              className="w-full"
              onClick={async () => {
                await flush()
                if (!draft.steps.length) await call('workflows.update', { id: wfId, draft: { ...draft, steps: [blankStep(1)] } })
                setQuery({ step: '2' })
              }}
            >
              Write the steps myself
            </Button>
            {saving && <p className="text-xs text-muted-foreground">Saving…</p>}
          </CardContent>
        </Card>
      </div>
      <AnalyzeDialog open={analyzeOpen} onOpenChange={setAnalyzeOpen} wfId={wfId} hasRecording={!!wf.recording} onDone={() => setQuery({ step: '2' })} />
    </div>
  )
}

function blankStep(n: number): WorkflowStep {
  return { id: `s${n}`, title: 'New step', description: '', application: '', inputs: '', outputs: '', timestamp: '', repeated: false, decisionPoint: false, decisionRule: '', capability: 'unknown', inputsClear: 'partly', successClear: 'partly', impact: 'medium', verification: 'moderate', collectionIds: [], uncertain: false }
}

function AnalyzeDialog({ open, onOpenChange, wfId, hasRecording, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; wfId: string; hasRecording: boolean; onDone: () => void }) {
  const preview = useApi('workflows.analysisPreview', { id: wfId }, { enabled: open })
  const [providerId, setProviderId] = React.useState<string>('')
  const [model, setModel] = React.useState<string>('')
  const [includeVideo, setIncludeVideo] = React.useState(true)
  const [confirmed, setConfirmed] = React.useState(false)
  const analyze = useAction('workflows.analyze', { success: 'Steps drafted. Review and edit them.', invalidate: ['workflows.'], onSuccess: () => { onOpenChange(false); onDone() } })
  const p = preview.data
  const options = p ? (includeVideo && hasRecording ? p.videoProviders : p.textProviders) : []
  React.useEffect(() => {
    if (options.length && !options.some((o) => o.id === providerId)) {
      setProviderId(options[0].id)
      setModel(options[0].models[0])
    }
  }, [options, providerId])
  const chosen = options.find((o) => o.id === providerId)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>Draft steps with a model</DialogTitle>
          <DialogDescription>Review exactly what will be sent and where before anything leaves this computer.</DialogDescription>
        </DialogHeader>
        <Query q={preview}>
          {(p) => (
            <div className="space-y-4">
              {hasRecording && (
                <label className="flex items-start gap-2 text-sm">
                  <Checkbox checked={includeVideo} onCheckedChange={(v) => setIncludeVideo(!!v)} className="mt-0.5" />
                  <span>
                    Include the recording{p.recording ? ` (${bytes(p.recording.sizeBytes)})` : ''}
                    <span className="block text-xs text-muted-foreground">Video analysis needs a multimodal provider (Gemini in this build).</span>
                  </span>
                </label>
              )}
              {includeVideo && hasRecording && !p.videoAnalysisAvailable && (
                <Alert tone="warning" title="Automatic video analysis is unavailable">
                  {p.explanation} You can still send only your written notes to a text model, or write the steps yourself.
                </Alert>
              )}
              {options.length === 0 ? (
                <Alert tone="neutral" title="No model provider is configured">
                  An administrator can add one in Settings → Models &amp; keys. Until then, write the steps yourself — Relay will not invent steps it hasn’t analyzed.
                </Alert>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  <Field label="Provider">
                    <Select value={providerId} onValueChange={(v) => { setProviderId(v); setModel(options.find((o) => o.id === v)?.models[0] ?? '') }}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {options.map((o) => (
                          <SelectItem key={o.id} value={o.id}>
                            {o.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Model">
                    <Select value={model} onValueChange={setModel}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(chosen?.models ?? []).map((m) => (
                          <SelectItem key={m} value={m}>
                            {m}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <div className="rounded-md border bg-muted/40 p-3 text-sm md:col-span-2">
                    <div className="font-medium">What will be sent</div>
                    <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                      <li>Your task details and notes ({p.textChars} characters)</li>
                      {includeVideo && hasRecording && p.recording && <li>The full recording ({bytes(p.recording.sizeBytes)})</li>}
                    </ul>
                    <div className="mt-2">
                      Destination: <strong>{chosen?.destination}</strong> ({chosen?.name})
                    </div>
                  </div>
                  <label className="flex items-start gap-2 text-sm md:col-span-2">
                    <Checkbox checked={confirmed} onCheckedChange={(v) => setConfirmed(!!v)} className="mt-0.5" />I reviewed the recording and notes, and they may be sent to {chosen?.destination}.
                  </label>
                </div>
              )}
            </div>
          )}
        </Query>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!confirmed || !providerId || !model} loading={analyze.isPending} onClick={() => analyze.mutate({ workflowId: wfId, providerId, model, includeVideo: includeVideo && hasRecording && !!p?.videoAnalysisAvailable && options.some((o) => o.id === providerId), confirmSend: true })}>
            <Send /> Send for analysis
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------- Steps 2–4 ----------------

function WorkflowSteps({ wfId, step }: { wfId: string; step: number }) {
  const w = useWorkflowDraft(wfId)
  if (!w.draft || !w.q.data) return <Query q={w.q}>{() => <Loading />}</Query>
  if (step === 2) return <ReviewSteps wf={w.q.data} draft={w.draft} update={w.update} flush={w.flush} />
  if (step === 3) return <ToolsAndData wf={w.q.data} draft={w.draft} update={w.update} flush={w.flush} />
  return <Instructions wf={w.q.data} flush={w.flush} />
}

type StepProps = { wf: Wf; draft: WorkflowDraft; update: (p: Partial<WorkflowDraft>) => void; flush: () => Promise<void> }

function ReviewSteps({ wf, draft, update, flush }: StepProps) {
  const plans = new Map(wf.plan.steps.map((p) => [p.stepId, p]))
  const setStep = (i: number, patch: Partial<WorkflowStep>) => update({ steps: draft.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) })
  const analysis = wf.analysis as { provider?: string; model?: string; summary?: string; unsupportedOrUnclear?: string[]; applications?: string[] }
  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_22rem]">
      <div className="space-y-4">
        {analysis.provider ? (
          <Alert tone="info" title={`Drafted by ${analysis.provider} (${analysis.model})`}>
            {analysis.summary} {analysis.applications?.length ? `Applications seen: ${analysis.applications.join(', ')}.` : ''} Check every step — the model can misread a recording.
          </Alert>
        ) : (
          <Alert tone="neutral">Steps written by you. Add one card per step, in order.</Alert>
        )}
        {analysis.unsupportedOrUnclear && analysis.unsupportedOrUnclear.length > 0 && (
          <Alert tone="warning" title="Unclear or unsupported in the recording">
            <ul className="list-disc pl-4">
              {analysis.unsupportedOrUnclear.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          </Alert>
        )}
        {draft.steps.map((s, i) => (
          <WorkflowStepCard key={s.id} index={i} step={s} plan={plans.get(s.id)} onChange={(p) => setStep(i, p)} onRemove={() => update({ steps: draft.steps.filter((_, j) => j !== i) })} />
        ))}
        <Button variant="outline" onClick={() => update({ steps: [...draft.steps, blankStep(Math.max(0, ...draft.steps.map((s) => Number(s.id.replace(/\D/g, '')) || 0)) + 1)] })}>
          <Plus /> Add step
        </Button>
      </div>
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Projected savings</CardTitle>
            <CardDescription>An estimate, not a measurement</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="text-2xl font-semibold tabular-nums">~{wf.plan.savings.hoursSavedPerMonth} h/month</div>
            <div className="text-sm text-muted-foreground">
              ≈{wf.plan.savings.minutesSavedPerRun} of {wf.plan.savings.minutesPerRunBefore} minutes per run
            </div>
            <Collapsible>
              <CollapsibleTrigger className="text-xs font-medium text-primary hover:underline">Assumptions</CollapsibleTrigger>
              <CollapsibleContent>
                <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                  {wf.plan.savings.assumptions.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          </CardContent>
        </Card>
        <Questions wf={wf} draft={draft} update={update} />
        <div className="flex justify-between">
          <Button variant="outline" onClick={() => setQuery({ step: '1' })}>
            <ArrowLeft /> Back
          </Button>
          <Button disabled={!draft.steps.length} onClick={async () => { await flush(); setQuery({ step: '3' }) }}>
            Choose tools & data <ArrowRight />
          </Button>
        </div>
      </div>
    </div>
  )
}

function Questions({ wf, draft, update }: { wf: Wf; draft: WorkflowDraft; update: (p: Partial<WorkflowDraft>) => void }) {
  const [answers, setAnswers] = React.useState<Record<string, string>>({})
  if (!wf.plan.questions.length) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CircleHelp className="size-4" aria-hidden /> A few questions
        </CardTitle>
        <CardDescription>Missing business rules keep steps from being automated safely.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {wf.plan.questions.map((q) => (
          <div key={q.id} className="space-y-1.5">
            <label className="text-sm" htmlFor={`q-${q.id}`}>
              {q.question}
            </label>
            <div className="flex gap-2">
              <Input id={`q-${q.id}`} value={answers[q.id] ?? ''} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} />
              <Button
                size="sm"
                variant="outline"
                disabled={!answers[q.id]?.trim()}
                onClick={() => {
                  const a = answers[q.id].trim()
                  const steps = draft.steps.map((s) => {
                    if (q.stepId !== s.id) return s
                    if (q.id.startsWith('rule:')) return { ...s, decisionRule: a }
                    if (q.id.startsWith('success:')) return { ...s, successClear: 'yes' as const, description: `${s.description}\nSuccess: ${a}`.trim() }
                    if (q.id.startsWith('inputs:')) return { ...s, inputsClear: 'yes' as const, inputs: a }
                    return { ...s, uncertain: false, description: a }
                  })
                  update({
                    steps,
                    answers: { ...draft.answers, [q.id]: a },
                    ...(q.id === 'output' ? { desiredOutput: a } : {}),
                    ...(q.id === 'exceptions' ? { exceptions: a } : {})
                  })
                }}
              >
                Save
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function WorkflowStepCard({ index, step: s, plan, onChange, onRemove }: { index: number; step: WorkflowStep; plan?: Wf['plan']['steps'][number]; onChange: (p: Partial<WorkflowStep>) => void; onRemove: () => void }) {
  const level = (k: 'inputsClear' | 'successClear', label: string) => (
    <Field label={label}>
      <Select value={s[k]} onValueChange={(v) => onChange({ [k]: v } as Partial<WorkflowStep>)}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="yes">Yes</SelectItem>
          <SelectItem value="partly">Partly</SelectItem>
          <SelectItem value="no">No</SelectItem>
        </SelectContent>
      </Select>
    </Field>
  )
  return (
    <Card>
      <CardContent className="space-y-3 pt-4">
        <div className="flex items-start gap-3">
          <div className="mt-1.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">{index + 1}</div>
          <div className="flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Input aria-label="Step title" value={s.title} onChange={(e) => onChange({ title: e.target.value })} className="max-w-md font-medium" />
              {s.timestamp && <Badge tone="neutral">at {s.timestamp}</Badge>}
              {s.uncertain && <Badge tone="warning">Unclear in recording</Badge>}
              {s.repeated && <Badge tone="info">Repeated</Badge>}
            </div>
            <Textarea aria-label="What happens in this step" value={s.description} onChange={(e) => onChange({ description: e.target.value })} rows={2} placeholder="What happens in this step" />
          </div>
          <Button size="icon-sm" variant="ghost" aria-label="Remove step" onClick={onRemove}>
            <Trash2 />
          </Button>
        </div>
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Kind of work">
            <Select value={s.capability} onValueChange={(v) => onChange({ capability: v as StepCapability })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STEP_CAPABILITIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {CAPABILITY_LABELS[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Application">
            <Input value={s.application} onChange={(e) => onChange({ application: e.target.value })} />
          </Field>
          <Field label="Inputs">
            <Input value={s.inputs} onChange={(e) => onChange({ inputs: e.target.value })} />
          </Field>
          <Field label="Outputs">
            <Input value={s.outputs} onChange={(e) => onChange({ outputs: e.target.value })} />
          </Field>
        </div>
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
            <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" /> Clarity, risk and decision rules
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 grid gap-3 md:grid-cols-4">
            {level('inputsClear', 'Inputs are clear?')}
            {level('successClear', 'Success is well defined?')}
            <Field label="Impact of a mistake">
              <Select value={s.impact} onValueChange={(v) => onChange({ impact: v as WorkflowStep['impact'] })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Checking the output is">
              <Select value={s.verification} onValueChange={(v) => onChange({ verification: v as WorkflowStep['verification'] })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="easy">Easy</SelectItem>
                  <SelectItem value="moderate">Moderate</SelectItem>
                  <SelectItem value="hard">Hard</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <label className="flex items-center gap-2 text-sm md:col-span-1">
              <Checkbox checked={s.decisionPoint} onCheckedChange={(v) => onChange({ decisionPoint: !!v })} /> This step makes a decision
            </label>
            {s.decisionPoint && (
              <Field label="Decision rule" className="md:col-span-3">
                <Input value={s.decisionRule} onChange={(e) => onChange({ decisionRule: e.target.value })} placeholder="If …, then …; otherwise …" />
              </Field>
            )}
          </CollapsibleContent>
        </Collapsible>
        {plan && (
          <div className="rounded-md border bg-muted/30 p-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">Recommended:</span>
              <KindBadge kind={plan.recommended} />
              <Badge tone="neutral">{plan.confidence} confidence</Badge>
              {plan.checkpoint && <Badge tone="warning">Review checkpoint added</Badge>}
              <div className="flex-1" />
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                Use instead
                <Select value={s.override ?? 'recommended'} onValueChange={(v) => onChange({ override: v === 'recommended' ? undefined : (v as AutomationKind) })}>
                  <SelectTrigger className="h-8 w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="recommended">The recommendation</SelectItem>
                    {(Object.keys(AUTOMATION_LABELS) as AutomationKind[]).map((k) => (
                      <SelectItem key={k} value={k}>
                        {AUTOMATION_LABELS[k]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            </div>
            <ul className="mt-2 grid gap-1 text-xs md:grid-cols-2">
              {plan.reasons.map((r, i) => (
                <li key={i} className="flex gap-1.5">
                  <span className={cn('mt-1 size-1.5 shrink-0 rounded-full', r.effect === 'favors' ? 'bg-success' : r.effect === 'against' ? 'bg-danger' : 'bg-muted-foreground')} aria-hidden />
                  <span>
                    <span className="font-medium">{r.factor}:</span> {r.text} <span className="sr-only">({r.effect})</span>
                  </span>
                </li>
              ))}
            </ul>
            {[...plan.policyNotes, ...(plan.missingCapability ? [plan.missingCapability] : [])].map((n, i) => (
              <div key={i} className="mt-2 text-xs text-warning">
                {n}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function ToolsAndData({ wf, draft, update, flush }: StepProps) {
  const collections = useApi('data.collections')
  const [requestTool, setRequestTool] = React.useState<string | null>(null)
  const [requestData, setRequestData] = React.useState<string | null>(null)
  const reqTool = useAction('tools.requestAccess', { success: 'Request sent for approval', onSuccess: () => setRequestTool(null), invalidate: ['tools.', 'workflows.'] })
  const reqData = useAction('data.requestAccess', { success: 'Request sent for approval', onSuccess: () => setRequestData(null), invalidate: ['data.'] })
  const [choices, setChoices] = useChoices(wf.id)
  const setStep = (id: string, patch: Partial<WorkflowStep>) => update({ steps: draft.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)) })
  return (
    <div className="space-y-4">
      <Alert tone="info">For each step, Relay suggests the smallest set of tools you’re approved to use. Missing capabilities are shown beside the step with options: request access, use an alternative, or hand the step to a person.</Alert>
      {wf.plan.steps.map((p, i) => {
        const s = draft.steps.find((x) => x.id === p.stepId)
        if (!s) return null
        const automated = p.effective === 'agent' || p.effective === 'deterministic'
        const selected = choices[s.id] ?? p.tools.find((t) => t.status === 'available')?.key ?? null
        const needsData = ['doc_search', 'data_read', 'db_query'].includes(s.capability)
        return (
          <Card key={p.stepId}>
            <CardContent className="space-y-3 pt-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex size-6 items-center justify-center rounded-full bg-muted text-xs font-semibold">{i + 1}</span>
                <span className="font-medium">{s.title}</span>
                <KindBadge kind={p.effective} />
                <Badge tone="neutral">{CAPABILITY_LABELS[s.capability]}</Badge>
              </div>
              {!automated && <p className="text-sm text-muted-foreground">{p.effective === 'human_review' ? 'A person reviews this step during each run.' : 'A person does this step; the run pauses until it is marked done.'}</p>}
              {automated && (
                <>
                  {p.tools.length === 0 ? (
                    <Alert
                      tone="warning"
                      title="No installed tool can do this"
                      action={
                        <Button size="sm" variant="outline" onClick={() => setStep(s.id, { override: 'human_review' })}>
                          <Hand /> Hand to a person
                        </Button>
                      }
                    >
                      {p.missingCapability ?? 'Choose a human step, or ask an administrator to connect a tool.'}
                    </Alert>
                  ) : (
                    <div className="space-y-2" role="radiogroup" aria-label={`Tool for ${s.title}`}>
                      {p.tools.map((t) => (
                        <div key={t.key} className={cn('flex flex-wrap items-center gap-3 rounded-md border px-3 py-2', selected === t.key && 'border-primary bg-accent/40')}>
                          <input type="radio" name={`tool-${s.id}`} aria-label={t.name} checked={selected === t.key} disabled={t.status !== 'available'} onChange={() => setChoices({ ...choices, [s.id]: t.key })} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 text-sm font-medium">
                              {t.name}
                              <StatusBadge status={t.status} />
                              {t.access !== 'read' && <Badge tone="warning">{t.access}</Badge>}
                              {t.external && <Badge tone="neutral">Sends data externally</Badge>}
                            </div>
                            <div className="truncate text-xs text-muted-foreground">{t.purpose}</div>
                          </div>
                          {t.status === 'requires_permission' && (
                            <Button size="sm" variant="outline" onClick={() => setRequestTool(t.key)}>
                              <Lock /> Request access
                            </Button>
                          )}
                          {t.status === 'needs_connection' && <span className="text-xs text-muted-foreground">{t.detail}</span>}
                        </div>
                      ))}
                      {!p.tools.some((t) => t.status === 'available') && (
                        <Button size="sm" variant="ghost" onClick={() => setStep(s.id, { override: 'human_review' })}>
                          <Hand /> Hand this step to a person instead
                        </Button>
                      )}
                    </div>
                  )}
                </>
              )}
              {needsData && (
                <div className="space-y-1.5">
                  <div className="text-sm font-medium">Data for this step</div>
                  <div className="flex flex-wrap gap-2">
                    {(collections.data ?? [])
                      .filter((c) => (s.capability === 'doc_search' ? c.kind === 'documents' : c.kind === 'table'))
                      .map((c) => {
                        const on = s.collectionIds.includes(c.id)
                        const can = c.myPurposes.includes('retrieval')
                        return (
                          <div key={c.id} className={cn('flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm', on && 'border-primary bg-accent/40')}>
                            <Checkbox aria-label={c.name} checked={on} disabled={!can} onCheckedChange={(v) => setStep(s.id, { collectionIds: v ? [...s.collectionIds, c.id] : s.collectionIds.filter((x) => x !== c.id) })} />
                            {c.name}
                            {!c.allowExternal && <Badge tone="neutral">Local only</Badge>}
                            {!can && (
                              <Button size="sm" variant="link" className="h-auto p-0" onClick={() => setRequestData(c.id)}>
                                Request access
                              </Button>
                            )}
                          </div>
                        )
                      })}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )
      })}
      <div className="flex justify-between">
        <Button variant="outline" onClick={() => setQuery({ step: '2' })}>
          <ArrowLeft /> Back
        </Button>
        <Button onClick={async () => { await flush(); setQuery({ step: '4' }) }}>
          Review instructions <ArrowRight />
        </Button>
      </div>
      <ReasonDialog open={!!requestTool} onOpenChange={(o) => !o && setRequestTool(null)} title="Request tool access" description="An administrator reviews tool access. You’ll get a notification when it’s decided." placeholder="What will you use it for?" onSubmit={(reason) => requestTool && reqTool.mutate({ toolKey: requestTool, reason })} loading={reqTool.isPending} />
      <ReasonDialog open={!!requestData} onOpenChange={(o) => !o && setRequestData(null)} title="Request data access" description="Your manager (or an administrator) reviews this. Access is for use in agents (search & read)." placeholder="Why do you need this data?" onSubmit={(reason) => requestData && reqData.mutate({ collectionId: requestData, purposes: ['retrieval'], reason })} loading={reqData.isPending} />
    </div>
  )
}

function useChoices(wfId: string) {
  const [v, setV] = React.useState<Record<string, string | null>>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(`draft:toolchoices:${wfId}`) ?? '{}')
    } catch {
      return {}
    }
  })
  React.useEffect(() => sessionStorage.setItem(`draft:toolchoices:${wfId}`, JSON.stringify(v)), [wfId, v])
  return [v, setV] as const
}

function Instructions({ wf, flush }: { wf: Wf; flush: () => Promise<void> }) {
  const [choices] = useChoices(wf.id)
  const [spec, setSpec] = React.useState<AgentSpec | null>(null)
  const [notes, setNotes] = React.useState<string[]>([])
  const [name, setName] = React.useState(wf.draft.name)
  const [description, setDescription] = React.useState(wf.draft.goal)
  const create = useAction('agents.create', { success: 'Agent created as a draft', invalidate: ['agents.', 'workflows.'] })
  React.useEffect(() => {
    void flush().then(() =>
      call('workflows.buildSpec', { id: wf.id, choices }).then((r) => {
        setSpec(r.spec)
        setNotes(r.notes)
      })
    )
  }, [wf.id])
  useLeaveGuard(spec && !create.isSuccess ? 'Leave without creating the agent? Your workflow is saved, but these instruction edits are not.' : null)
  if (wf.agentId)
    return (
      <Alert tone="success" title="An agent was already created from this workflow" action={<Button size="sm" onClick={() => navigate(`/agents/${wf.agentId}`)}>Open agent</Button>}>
        Continue testing and deploying it on the agent page.
      </Alert>
    )
  if (!spec) return <Loading label="Building the agent specification…" />
  const issues = validateSpec(spec)
  return (
    <div className="space-y-4">
      <Alert tone="info" title="Review what Relay generated">
        This is a structured specification — not code. Every tool call is permission-checked when the agent runs. Edit anything below.
      </Alert>
      {notes.length > 0 && (
        <Alert tone="warning" title="Needs attention">
          <ul className="list-disc pl-4">
            {notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </Alert>
      )}
      <Card>
        <CardContent className="grid gap-3 pt-4 md:grid-cols-2">
          <Field label="Agent name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Description">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </CardContent>
      </Card>
      <SpecEditor spec={spec} onChange={setSpec} />
      <div className="flex justify-between">
        <Button variant="outline" onClick={() => setQuery({ step: '3' })}>
          <ArrowLeft /> Back
        </Button>
        <Button
          disabled={issues.length > 0 || !name.trim()}
          loading={create.isPending}
          onClick={async () => {
            const r = await create.mutateAsync({ name: name.trim(), description, spec, workflowId: wf.id })
            navigate(`/agents/${r.id}?tab=overview&created=1`, { force: true })
          }}
        >
          <Wand2 /> Create agent and test it
        </Button>
      </div>
    </div>
  )
}


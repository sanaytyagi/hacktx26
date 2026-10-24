import * as React from 'react'
import { AppWindow, CircleStop, Mic, Monitor, RefreshCw, Square, Video, X } from 'lucide-react'
import { toast } from 'sonner'
import { call, onPush, useApi } from '@/lib/api'
import { duration } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Alert } from '@/components/ui/alert'
import { Switch } from '@/components/ui/misc'
import { Loading } from '@/components/app/common'

type Source = { id: string; name: string; kind: 'screen' | 'window'; thumbnail: string }

/**
 * Records a screen or window the user explicitly picks. Video is written to Relay's local
 * recordings folder in chunks while recording. Recordings capture pixels (and optional
 * microphone narration) only — not clicks, DOM events, or hidden application state.
 */
export function RecorderPanel({ onSaved }: { onSaved: (recordingId: string) => void }) {
  const perm = useApi('capture.permission')
  const [sources, setSources] = React.useState<Source[] | null>(null)
  const [loadingSources, setLoadingSources] = React.useState(false)
  const [chosen, setChosen] = React.useState<string | null>(null)
  const [mic, setMic] = React.useState(false)
  const [state, setState] = React.useState<'idle' | 'recording' | 'saving'>('idle')
  const [elapsed, setElapsed] = React.useState(0)
  const rec = React.useRef<{ recorder: MediaRecorder; stream: MediaStream; sessionId: string; queue: Promise<unknown>; started: number; cancelled: boolean } | null>(null)

  const loadSources = React.useCallback(async () => {
    setLoadingSources(true)
    try {
      setSources(await call('capture.sources'))
    } catch (e) {
      toast.error('Could not list screens and windows', { description: (e as Error).message })
    } finally {
      setLoadingSources(false)
    }
  }, [])
  React.useEffect(() => {
    if (perm.data && perm.data.status !== 'denied' && perm.data.status !== 'restricted') void loadSources()
  }, [perm.data, loadSources])

  React.useEffect(() => {
    if (state !== 'recording') return
    const t = setInterval(() => rec.current && setElapsed((Date.now() - rec.current.started) / 1000), 500)
    return () => clearInterval(t)
  }, [state])

  const finish = React.useCallback(
    async (cancel: boolean) => {
      const r = rec.current
      if (!r) return
      r.cancelled = cancel
      setState('saving')
      await new Promise<void>((resolve) => {
        r.recorder.addEventListener('stop', () => resolve(), { once: true })
        if (r.recorder.state !== 'inactive') r.recorder.stop()
        else resolve()
      })
      r.stream.getTracks().forEach((t) => t.stop())
      await r.queue
      await call('capture.hud', { show: false }).catch(() => undefined)
      const secs = (Date.now() - r.started) / 1000
      try {
        const saved = await call('recordings.finish', { sessionId: r.sessionId, title: `Recording ${new Date().toLocaleString()}`, durationSec: secs, cancel })
        rec.current = null
        setState('idle')
        if (saved) {
          toast.success('Recording saved on this computer')
          onSaved(saved.id)
        } else toast('Recording discarded')
      } catch (e) {
        setState('idle')
        toast.error('Could not save the recording', { description: (e as Error).message })
      }
    },
    [onSaved]
  )

  React.useEffect(() => onPush((e) => e.type === 'recorder.command' && rec.current && void finish(e.command === 'cancel')), [finish])

  async function start() {
    if (!chosen) return
    try {
      await call('capture.select', { id: chosen })
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 12 }, audio: false })
      if (mic) {
        try {
          const m = await navigator.mediaDevices.getUserMedia({ audio: true })
          m.getAudioTracks().forEach((t) => stream.addTrack(t))
        } catch {
          toast.warning('Microphone unavailable — recording without narration.')
        }
      }
      const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) ?? 'video/webm'
      const { sessionId } = await call('recordings.begin', { mime })
      const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_000_000 })
      const ctx = { recorder, stream, sessionId, queue: Promise.resolve() as Promise<unknown>, started: Date.now(), cancelled: false }
      recorder.ondataavailable = (ev) => {
        if (!ev.data.size) return
        ctx.queue = ctx.queue.then(async () => call('recordings.append', { sessionId, chunk: new Uint8Array(await ev.data.arrayBuffer()) }))
      }
      // If the user stops sharing from the operating system, treat it as Stop.
      stream.getVideoTracks()[0]?.addEventListener('ended', () => rec.current && rec.current.recorder.state !== 'inactive' && void finish(false))
      rec.current = ctx
      recorder.start(2000)
      setElapsed(0)
      setState('recording')
      await call('capture.hud', { show: true }).catch(() => undefined)
    } catch (e) {
      await call('capture.select', { id: null }).catch(() => undefined)
      toast.error('Recording could not start', { description: (e as Error).message })
    }
  }

  if (perm.isLoading) return <Loading label="Checking screen recording permission…" />
  const denied = perm.data && (perm.data.status === 'denied' || perm.data.status === 'restricted')

  if (state !== 'idle')
    return (
      <div className="flex items-center gap-4 rounded-lg border border-danger/40 bg-danger-subtle px-4 py-3" role="status" aria-live="polite">
        <span className="relative flex size-3">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-danger opacity-60" />
          <span className="relative inline-flex size-3 rounded-full bg-danger" />
        </span>
        <div className="flex-1">
          <div className="font-medium">{state === 'saving' ? 'Saving recording…' : 'Recording'}</div>
          <div className="text-sm text-muted-foreground tabular-nums">
            {duration(elapsed)} · {sources?.find((s) => s.id === chosen)?.name ?? 'Selected source'}
            {mic ? ' · with microphone' : ''}
          </div>
        </div>
        <Button variant="destructive" onClick={() => finish(false)} disabled={state === 'saving'}>
          <Square /> Stop and save
        </Button>
        <Button variant="outline" onClick={() => finish(true)} disabled={state === 'saving'}>
          <X /> Cancel
        </Button>
      </div>
    )

  return (
    <div className="space-y-4">
      {denied && (
        <Alert tone="warning" title="Screen recording permission is off" action={<Button size="sm" variant="outline" onClick={() => call('capture.openSettings')}>Open System Settings</Button>}>
          In System Settings → Privacy &amp; Security → Screen &amp; System Audio Recording, turn on Relay (shown as “Electron” during development), then quit and reopen Relay. You can also import an existing video instead.
        </Alert>
      )}
      {perm.data?.status === 'not-determined' && <Alert tone="info">macOS will ask for screen recording permission the first time you record. If thumbnails below are blank, grant permission and reopen Relay.</Alert>}
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">Choose exactly what to record</div>
        <Button size="sm" variant="ghost" onClick={loadSources} loading={loadingSources}>
          <RefreshCw /> Refresh
        </Button>
      </div>
      {!sources && loadingSources && <Loading label="Finding screens and windows…" />}
      {sources && sources.length === 0 && <Alert tone="warning">No screens or windows are available to record. Check the permission above, or import a video instead.</Alert>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4" role="radiogroup" aria-label="Screen or window to record">
        {(sources ?? []).map((s) => (
          <button
            key={s.id}
            role="radio"
            aria-checked={chosen === s.id}
            onClick={() => setChosen(s.id)}
            className={cn('overflow-hidden rounded-lg border bg-card text-left transition-colors hover:border-primary/60', chosen === s.id && 'border-primary ring-2 ring-primary/30')}
          >
            <div className="flex aspect-video items-center justify-center bg-muted">{s.thumbnail ? <img src={s.thumbnail} alt="" className="h-full w-full object-cover" /> : s.kind === 'screen' ? <Monitor className="size-6 text-muted-foreground" /> : <AppWindow className="size-6 text-muted-foreground" />}</div>
            <div className="flex items-center gap-1.5 px-2 py-1.5 text-xs">
              {s.kind === 'screen' ? <Monitor className="size-3.5" aria-hidden /> : <AppWindow className="size-3.5" aria-hidden />}
              <span className="truncate">{s.name}</span>
            </div>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={mic} onCheckedChange={setMic} aria-label="Include microphone narration" />
          <Mic className="size-4 text-muted-foreground" aria-hidden /> Include microphone narration
        </label>
        <Button onClick={start} disabled={!chosen} size="lg">
          <Video /> Start recording
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Recordings stay in Relay’s local data folder. Nothing is sent anywhere until you review the recording and choose to analyze it. Screen recordings capture what is visible — not clicks, page structure, or hidden app state.</p>
    </div>
  )
}

/** Small always-on-top window shown while recording, so the indicator stays visible over other apps. */
export function RecordingHud() {
  const [start] = React.useState(Date.now())
  const [, tick] = React.useState(0)
  React.useEffect(() => {
    document.documentElement.classList.add('dark')
    const t = setInterval(() => tick((x) => x + 1), 500)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="drag flex h-screen items-center gap-3 bg-[#18181b] px-3 text-white" role="status" aria-label="Relay is recording">
      <span className="relative flex size-3">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-500 opacity-60" />
        <span className="relative inline-flex size-3 rounded-full bg-red-500" />
      </span>
      <div className="flex-1 text-sm">
        <div className="font-medium">Relay is recording</div>
        <div className="text-xs text-zinc-400 tabular-nums">{duration((Date.now() - start) / 1000)}</div>
      </div>
      <button className="no-drag flex items-center gap-1 rounded-md bg-red-600 px-2 py-1 text-xs font-medium hover:bg-red-500" onClick={() => call('capture.hudCommand', { command: 'stop' })}>
        <CircleStop className="size-3.5" /> Stop
      </button>
      <button className="no-drag rounded-md px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-700" onClick={() => call('capture.hudCommand', { command: 'cancel' })}>
        Cancel
      </button>
    </div>
  )
}

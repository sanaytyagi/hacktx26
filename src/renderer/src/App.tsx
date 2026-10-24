import * as React from 'react'
import { useApi } from './lib/api'
import { match, useRoute } from './lib/router'
import { AppShell, SessionContext } from './components/app/shell'
import { ErrorState, Loading } from './components/app/common'
import { HomePage } from './pages/home'
import { AgentsPage } from './pages/agents/list'
import { CreateAgentPage } from './pages/agents/create'
import { AgentDetailPage } from './pages/agents/detail'
import { RunsPage } from './pages/runs/list'
import { RunDetailPage } from './pages/runs/detail'
import { ApprovalsPage } from './pages/approvals'
import { DataPage } from './pages/data/index'
import { CollectionPage } from './pages/data/collection'
import { OpportunitiesPage } from './pages/data/opportunities'
import { ToolsPage } from './pages/tools'
import { ModelsPage } from './pages/models/index'
import { TrainPage } from './pages/models/train'
import { JobPage } from './pages/models/job'
import { ModelPage } from './pages/models/model'
import { BudgetPage } from './pages/budget'
import { SettingsPage } from './pages/settings'
import { RecordingHud } from './pages/agents/recorder'

const ROUTES: [string, (p: Record<string, string>) => React.ReactNode][] = [
  ['/', () => <HomePage />],
  ['/agents', () => <AgentsPage />],
  ['/agents/new', () => <CreateAgentPage />],
  ['/agents/:id', (p) => <AgentDetailPage id={p.id} />],
  ['/runs', () => <RunsPage />],
  ['/runs/:id', (p) => <RunDetailPage id={p.id} />],
  ['/approvals', () => <ApprovalsPage />],
  ['/approvals/:id', (p) => <ApprovalsPage selected={p.id} />],
  ['/data', () => <DataPage />],
  ['/data/:id', (p) => <CollectionPage id={p.id} />],
  ['/data/:id/opportunities', (p) => <OpportunitiesPage collectionId={p.id} />],
  ['/tools', () => <ToolsPage />],
  ['/models', () => <ModelsPage />],
  ['/models/train', () => <TrainPage />],
  ['/models/jobs/:id', (p) => <JobPage id={p.id} />],
  ['/models/:id', (p) => <ModelPage id={p.id} />],
  ['/budget', () => <BudgetPage />],
  ['/settings', () => <SettingsPage />]
]

export function App() {
  const { path } = useRoute()
  if (path === '/recording-hud') return <RecordingHud />
  return <Main path={path} />
}

function Main({ path }: { path: string }) {
  const session = useApi('session.get')
  if (session.isLoading) return <Loading label="Opening workspace…" className="justify-center pt-24" />
  if (session.error || !session.data) return <div className="p-8"><ErrorState error={session.error} retry={() => session.refetch()} /></div>
  let page: React.ReactNode = <div className="text-sm text-muted-foreground">Page not found.</div>
  for (const [pattern, render] of ROUTES) {
    const params = match(pattern, path)
    if (params) {
      page = render(params)
      break
    }
  }
  return (
    <SessionContext.Provider value={session.data}>
      <AppShell session={session.data}>
        <React.Fragment key={`${session.data.actor.id}:${path}`}>{page}</React.Fragment>
      </AppShell>
    </SessionContext.Provider>
  )
}

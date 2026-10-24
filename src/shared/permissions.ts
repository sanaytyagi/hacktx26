// Role capability matrix for the local demo personas.
//
// These capabilities are coarse "may attempt" rights. Every service additionally checks
// resource-level authority (collection grants, team membership, delegation rights, budget
// ceilings). A Manager title alone never grants data access: data use always requires a grant.

export type Role = 'employee' | 'manager' | 'admin'

export const CAPABILITIES = [
  'agents.create', // create/edit/test own agents
  'agents.view_team', // see agents and runs owned by members of own team
  'agents.manage_all', // see/manage every agent in the workspace
  'deploy.personal', // deploy own agent for personal use within limits
  'deploy.request_shared', // ask for a team/shared deployment
  'approvals.decide_team', // decide requests from own team, within admin ceilings
  'approvals.decide_all', // decide any request
  'data.request_access',
  'data.delegate', // re-grant collections the actor holds a delegable grant for (own team only)
  'data.administer', // configure sources, publish collections, grant anyone
  'tools.request_access',
  'tools.administer', // register integrations, approve tools per team
  'opportunities.explore',
  'training.run',
  'models.activate',
  'models.administer',
  'budgets.view_team',
  'budgets.view_all',
  'budgets.edit',
  'pricing.edit',
  'policies.edit',
  'credentials.manage',
  'audit.view_team',
  'audit.view_all',
  'retention.manage',
  'workspace.reset'
] as const

export type Capability = (typeof CAPABILITIES)[number]

export const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
  employee: ['agents.create', 'deploy.personal', 'deploy.request_shared', 'data.request_access', 'tools.request_access'],
  manager: [
    'agents.create',
    'agents.view_team',
    'deploy.personal',
    'deploy.request_shared',
    'approvals.decide_team',
    'data.request_access',
    'data.delegate',
    'tools.request_access',
    'opportunities.explore',
    'training.run',
    'models.activate',
    'budgets.view_team',
    'audit.view_team'
  ],
  admin: [
    'agents.create',
    'agents.view_team',
    'agents.manage_all',
    'deploy.personal',
    'deploy.request_shared',
    'approvals.decide_team',
    'approvals.decide_all',
    'data.request_access',
    'data.delegate',
    'data.administer',
    'tools.request_access',
    'tools.administer',
    'opportunities.explore',
    'training.run',
    'models.activate',
    'models.administer',
    'budgets.view_team',
    'budgets.view_all',
    'budgets.edit',
    'pricing.edit',
    'policies.edit',
    'credentials.manage',
    'audit.view_team',
    'audit.view_all',
    'retention.manage',
    'workspace.reset'
  ]
}

export function roleHas(role: Role, cap: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(cap)
}

export type NavKey = 'home' | 'agents' | 'runs' | 'approvals' | 'data' | 'tools' | 'models' | 'budget' | 'settings'

/** Navigation areas relevant to each role. Hiding is a UX choice; services enforce access. */
export const ROLE_NAV: Record<Role, NavKey[]> = {
  employee: ['home', 'agents', 'runs', 'approvals', 'data', 'tools', 'budget', 'settings'],
  manager: ['home', 'agents', 'runs', 'approvals', 'data', 'tools', 'models', 'budget', 'settings'],
  admin: ['home', 'agents', 'runs', 'approvals', 'data', 'tools', 'models', 'budget', 'settings']
}

export const PURPOSES = ['retrieval', 'analysis', 'training', 'export'] as const
export type Purpose = (typeof PURPOSES)[number]

export const PURPOSE_LABELS: Record<Purpose, string> = {
  retrieval: 'Use in agents (search & read)',
  analysis: 'Profiling & opportunity analysis',
  training: 'Train models',
  export: 'Export outside Relay'
}

export const TOOL_ACCESS = ['read', 'write', 'send', 'delete', 'admin'] as const
export type ToolAccess = (typeof TOOL_ACCESS)[number]

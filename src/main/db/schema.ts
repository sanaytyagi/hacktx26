// SQLite schema. Applied in order; each migration runs once (tracked in schema_migrations).
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, manager_id TEXT);
  CREATE TABLE users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, title TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('employee','manager','admin')),
    team_id TEXT REFERENCES teams(id), switchable INTEGER NOT NULL DEFAULT 0, email TEXT
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor_id TEXT, actor_role TEXT, action TEXT NOT NULL,
    target_type TEXT, target_id TEXT, team_id TEXT, outcome TEXT NOT NULL DEFAULT 'ok', details TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX audit_ts ON audit_events(ts);

  CREATE TABLE notifications (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', link TEXT,
    kind TEXT NOT NULL DEFAULT 'info', read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );

  -- Credentials: secret values are encrypted with the OS keychain (Electron safeStorage) when available.
  CREATE TABLE credentials (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, service TEXT NOT NULL, secret BLOB NOT NULL,
    storage TEXT NOT NULL, hint TEXT NOT NULL DEFAULT '', created_by TEXT, created_at TEXT NOT NULL, last_used_at TEXT
  );

  CREATE TABLE providers (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, base_url TEXT, credential_id TEXT,
    enabled INTEGER NOT NULL DEFAULT 1, external INTEGER NOT NULL DEFAULT 1, models TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'unchecked', status_detail TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
  );
  CREATE TABLE prices (
    id TEXT PRIMARY KEY, provider_kind TEXT NOT NULL, model TEXT NOT NULL, unit TEXT NOT NULL,
    input_price REAL, output_price REAL, call_price REAL, currency TEXT NOT NULL DEFAULT 'USD',
    source TEXT NOT NULL, effective_date TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', updated_by TEXT, updated_at TEXT NOT NULL
  );

  CREATE TABLE sources (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, path TEXT, config TEXT NOT NULL DEFAULT '{}',
    owner_id TEXT, origin TEXT NOT NULL DEFAULT 'local_import', status TEXT NOT NULL DEFAULT 'ready', status_detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, refreshed_at TEXT
  );
  CREATE TABLE source_items (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE, rel_path TEXT NOT NULL,
    kind TEXT NOT NULL, size INTEGER, mtime TEXT, status TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', UNIQUE(source_id, rel_path)
  );

  CREATE TABLE collections (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    owner_id TEXT, owner_team_id TEXT, selection TEXT NOT NULL, purposes TEXT NOT NULL, allow_external INTEGER NOT NULL DEFAULT 0,
    visibility TEXT NOT NULL DEFAULT 'discoverable', sensitivity TEXT NOT NULL DEFAULT 'internal', status TEXT NOT NULL DEFAULT 'published',
    version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, refreshed_at TEXT, is_synthetic INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE collection_versions (
    id TEXT PRIMARY KEY, collection_id TEXT NOT NULL, version INTEGER NOT NULL, selection TEXT NOT NULL, purposes TEXT NOT NULL,
    allow_external INTEGER NOT NULL, created_by TEXT, created_at TEXT NOT NULL, note TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE grants (
    id TEXT PRIMARY KEY, collection_id TEXT NOT NULL REFERENCES collections(id), principal_type TEXT NOT NULL CHECK (principal_type IN ('user','team')),
    principal_id TEXT NOT NULL, purposes TEXT NOT NULL, can_delegate INTEGER NOT NULL DEFAULT 0, granted_by TEXT, created_at TEXT NOT NULL,
    revoked_at TEXT, revoked_by TEXT, note TEXT NOT NULL DEFAULT ''
  );
  -- Search index for document collections. Rebuilt per collection version; dropped on revocation/retention.
  CREATE VIRTUAL TABLE doc_chunks USING fts5(collection_id UNINDEXED, version UNINDEXED, rel_path UNINDEXED, chunk UNINDEXED, body, tokenize='porter');
  CREATE TABLE doc_index_state (collection_id TEXT PRIMARY KEY, version INTEGER NOT NULL, indexed_at TEXT NOT NULL, files INTEGER, chunks INTEGER, warnings TEXT NOT NULL DEFAULT '[]');

  CREATE TABLE integrations (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}', credential_id TEXT,
    status TEXT NOT NULL DEFAULT 'not_connected', status_detail TEXT NOT NULL DEFAULT '', last_checked_at TEXT,
    discovered TEXT NOT NULL DEFAULT '[]', created_by TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE tools (
    key TEXT PRIMARY KEY, version INTEGER NOT NULL, kind TEXT NOT NULL, category TEXT NOT NULL, integration_id TEXT,
    declaration TEXT NOT NULL, impl TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE tool_versions (key TEXT NOT NULL, version INTEGER NOT NULL, declaration TEXT NOT NULL, impl TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (key, version));
  CREATE TABLE tool_grants (
    id TEXT PRIMARY KEY, tool_key TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
    granted_by TEXT, created_at TEXT NOT NULL, revoked_at TEXT
  );
  CREATE TABLE tool_health (
    tool_key TEXT PRIMARY KEY, status TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', checked_at TEXT NOT NULL, schema_hash TEXT
  );

  CREATE TABLE recordings (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, title TEXT NOT NULL, file_path TEXT NOT NULL, mime TEXT NOT NULL,
    size INTEGER NOT NULL, duration_sec REAL, origin TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE workflows (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, recording_id TEXT, draft TEXT NOT NULL, analysis TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'draft', agent_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );

  CREATE TABLE agents (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, team_id TEXT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft', deployment TEXT, workflow_id TEXT, draft_version_id TEXT, live_version_id TEXT,
    kill_switch INTEGER NOT NULL DEFAULT 0, notify_on_failure TEXT NOT NULL DEFAULT '[]', is_template INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE agent_versions (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, version INTEGER NOT NULL, spec TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '', tested_run_id TEXT, source TEXT NOT NULL DEFAULT 'edit', UNIQUE(agent_id, version)
  );

  CREATE TABLE runs (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, agent_version_id TEXT NOT NULL, environment TEXT NOT NULL, trigger TEXT NOT NULL,
    status TEXT NOT NULL, inputs TEXT NOT NULL DEFAULT '{}', outputs TEXT, context TEXT NOT NULL DEFAULT '{}', error TEXT,
    created_by TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, is_fixture INTEGER NOT NULL DEFAULT 0,
    tool_calls INTEGER NOT NULL DEFAULT 0, retries INTEGER NOT NULL DEFAULT 0, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
    cost_estimated REAL NOT NULL DEFAULT 0, cost_metered REAL NOT NULL DEFAULT 0, parent_run_id TEXT, eval_set_id TEXT, schedule_id TEXT, pause_requested INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX runs_agent ON runs(agent_id, created_at);
  CREATE TABLE run_steps (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_id TEXT NOT NULL, iteration INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, output TEXT, error TEXT, explanation TEXT NOT NULL DEFAULT '', taint TEXT NOT NULL DEFAULT '[]',
    started_at TEXT, finished_at TEXT, UNIQUE(run_id, step_id, iteration)
  );
  CREATE TABLE run_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, ts TEXT NOT NULL, type TEXT NOT NULL, step_id TEXT,
    message TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX run_events_run ON run_events(run_id, id);
  -- Results of side-effecting tool calls, keyed by idempotency key, so resume never repeats a completed write.
  CREATE TABLE tool_effects (idempotency_key TEXT PRIMARY KEY, run_id TEXT NOT NULL, tool_key TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL);

  CREATE TABLE review_tasks (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_id TEXT NOT NULL, iteration INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL,
    assignee_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', title TEXT NOT NULL, prompt TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
    response TEXT, created_at TEXT NOT NULL, resolved_at TEXT, resolved_by TEXT
  );

  CREATE TABLE output_tables (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, columns TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, UNIQUE(owner_id, name));
  CREATE TABLE output_rows (
    id TEXT PRIMARY KEY, table_id TEXT NOT NULL, run_id TEXT, idempotency_key TEXT UNIQUE, data TEXT NOT NULL, taint TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
  );
  CREATE TABLE exports (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, run_id TEXT, path TEXT NOT NULL, format TEXT NOT NULL, rows INTEGER NOT NULL, created_at TEXT NOT NULL
  );

  CREATE TABLE schedules (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, config TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, next_run_at TEXT,
    last_run_at TEXT, created_by TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE schedule_events (id INTEGER PRIMARY KEY AUTOINCREMENT, schedule_id TEXT NOT NULL, due_at TEXT NOT NULL, outcome TEXT NOT NULL, run_id TEXT, recorded_at TEXT NOT NULL);
  CREATE TABLE api_triggers (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_by TEXT, created_at TEXT NOT NULL);
  CREATE TABLE webhooks (
    id TEXT PRIMARY KEY, direction TEXT NOT NULL, name TEXT NOT NULL, agent_id TEXT, url TEXT, events TEXT NOT NULL DEFAULT '[]',
    credential_id TEXT, enabled INTEGER NOT NULL DEFAULT 1, allow_private INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at TEXT NOT NULL, last_status TEXT
  );

  CREATE TABLE approvals (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', requester_id TEXT NOT NULL,
    team_id TEXT, status TEXT NOT NULL DEFAULT 'pending', payload TEXT NOT NULL DEFAULT '{}', target_type TEXT, target_id TEXT,
    decided_by TEXT, decided_at TEXT, decision_comment TEXT, created_at TEXT NOT NULL, is_fixture INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE approval_comments (id TEXT PRIMARY KEY, approval_id TEXT NOT NULL, author_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);

  CREATE TABLE budgets (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK (scope IN ('workspace','team','agent','job')), scope_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('operating','training')), period TEXT NOT NULL DEFAULT 'monthly', limit_usd REAL NOT NULL,
    alert_pct INTEGER NOT NULL DEFAULT 80, hard_limit INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(scope, scope_id, kind)
  );
  -- Centralized ledger. Reservations are taken before paid calls and reconciled afterwards.
  CREATE TABLE ledger (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, entry_type TEXT NOT NULL CHECK (entry_type IN ('reservation','charge')),
    status TEXT NOT NULL CHECK (status IN ('open','reconciled','released','final')), amount_usd REAL NOT NULL,
    basis TEXT NOT NULL CHECK (basis IN ('estimate','metered','provider_reported','manual')),
    team_id TEXT, agent_id TEXT, job_id TEXT, run_id TEXT, model TEXT, project TEXT, user_id TEXT, description TEXT NOT NULL DEFAULT '',
    reservation_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX ledger_status ON ledger(status, kind);
  CREATE TABLE usage (
    id TEXT PRIMARY KEY, run_id TEXT, job_id TEXT, provider TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
    calls INTEGER NOT NULL DEFAULT 1, cost_usd REAL, basis TEXT NOT NULL, price_id TEXT, created_at TEXT NOT NULL
  );

  CREATE TABLE opportunities (
    id TEXT PRIMARY KEY, collection_id TEXT NOT NULL, collection_version INTEGER NOT NULL, created_by TEXT NOT NULL, profile TEXT NOT NULL,
    card TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', created_at TEXT NOT NULL
  );
  CREATE TABLE datasets (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, collection_id TEXT NOT NULL, collection_version INTEGER NOT NULL, opportunity_id TEXT,
    version INTEGER NOT NULL, parent_id TEXT, config TEXT NOT NULL, stats TEXT NOT NULL DEFAULT '{}', path TEXT NOT NULL,
    status TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE training_jobs (
    id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, opportunity_id TEXT, name TEXT NOT NULL, config TEXT NOT NULL, status TEXT NOT NULL,
    phase TEXT NOT NULL DEFAULT '', progress REAL NOT NULL DEFAULT 0, dir TEXT NOT NULL, metrics TEXT, baseline_metrics TEXT, hardware TEXT,
    error TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, approval_id TEXT, pid INTEGER, elapsed_sec REAL
  );
  CREATE TABLE training_events (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, ts TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
  CREATE TABLE models (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL, task TEXT NOT NULL, base_model TEXT NOT NULL, job_id TEXT,
    dataset_id TEXT, dataset_version INTEGER, collection_ids TEXT NOT NULL DEFAULT '[]', artifact_dir TEXT NOT NULL, labels TEXT NOT NULL DEFAULT '[]',
    metrics TEXT NOT NULL DEFAULT '{}', config TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL, review_reason TEXT, is_smoke INTEGER NOT NULL DEFAULT 0,
    created_by TEXT, created_at TEXT NOT NULL, activated_at TEXT, activated_by TEXT, UNIQUE(name, version)
  );

  CREATE TABLE feedback (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_id TEXT, user_id TEXT NOT NULL, kind TEXT NOT NULL, category TEXT,
    corrected_output TEXT, comment TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'new', created_at TEXT NOT NULL
  );
  CREATE TABLE eval_examples (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, inputs TEXT NOT NULL, expected TEXT NOT NULL, split TEXT NOT NULL CHECK (split IN ('improvement','holdout')),
    source TEXT NOT NULL, feedback_id TEXT, created_by TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE improvement_proposals (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, base_version_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, rationale TEXT NOT NULL,
    change TEXT NOT NULL, evidence TEXT NOT NULL, expected_effect TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'proposed', evaluation TEXT,
    candidate_version_id TEXT, approval_id TEXT, created_by TEXT, created_at TEXT NOT NULL
  );
  `
]

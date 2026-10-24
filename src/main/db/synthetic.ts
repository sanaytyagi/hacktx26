// Deterministic synthetic data for the demo workspace. Everything here is fictional.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { toCsv } from '../connectors/parse'

export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SERVICES = ['checkout', 'billing', 'search', 'auth-gateway', 'inventory', 'shipping-tracker', 'notifications', 'warehouse-sync', 'pricing', 'customer-portal']

const INCIDENT_PATTERNS: Record<string, string[]> = {
  Database: [
    'connection pool exhausted on {svc} primary; queries timing out',
    'replication lag on {svc} read replica above {n} seconds',
    'deadlocks in {svc} order tables during batch job',
    'slow queries after index was dropped on {svc}',
    '{svc} postgres disk IOPS saturated, p99 latency up',
    'migration locked a large table in {svc}; writes blocked',
    'too many open connections reported by {svc} db proxy'
  ],
  Network: [
    'packet loss between {svc} and the edge load balancer',
    'DNS resolution intermittently failing for {svc}.internal',
    '502s from the load balancer in front of {svc}',
    'TLS handshake timeouts to {svc} from region us-west',
    'cross-zone traffic dropped; {svc} pods unreachable',
    'VPN tunnel to warehouse site flapping, {svc} sync stalled',
    'elevated latency on the service mesh for {svc} calls'
  ],
  Deployment: [
    'bad config pushed with {svc} release {v}; feature flag misread',
    'canary for {svc} {v} failed health checks and rolled back',
    '{svc} release {v} missing environment variable after deploy',
    'container image for {svc} built without the right base layer',
    'rollout of {svc} {v} stuck at 40% in the pipeline',
    'schema change shipped before code in {svc} {v}',
    'helm chart change for {svc} reset replica count'
  ],
  Authentication: [
    'users logged out repeatedly; {svc} session tokens rejected',
    'SSO login loop for staff accounts on {svc}',
    'expired signing certificate broke token validation in {svc}',
    'MFA codes not delivered for {svc} sign-ins',
    'OAuth callback misconfigured after {svc} domain change',
    'password reset links failing on {svc}',
    'service account credentials rotated without updating {svc}'
  ],
  Storage: [
    'object storage bucket for {svc} returning access denied',
    'disk full on {svc} worker nodes; logs not rotating',
    'backup job for {svc} failed checksum verification',
    'file uploads in {svc} corrupted after storage class change',
    'NFS mount for {svc} went read-only',
    'blob store quota exceeded for {svc} attachments',
    'snapshot restore of {svc} volume taking hours'
  ],
  'Third-party API': [
    'carrier rate API returning 429s; {svc} quotes failing',
    'payment processor webhook delays affecting {svc}',
    'address validation vendor outage hit {svc}',
    'SMS provider dropping messages from {svc}',
    'tax calculation API timeouts in {svc}',
    'maps provider changed response format, {svc} parsing errors',
    'fraud scoring vendor returning errors to {svc}'
  ]
}

const CONFUSERS = [
  'Started shortly after a deploy.',
  'Customers reported errors at checkout.',
  'Alert fired from synthetic monitoring.',
  'On-call paged at night.',
  'Retries made it worse.',
  'Similar to last month.',
  'Dashboard showed elevated error rate.',
  'Partial outage for EU customers.',
  'Restarting pods helped temporarily.',
  ''
]

const FIRST = ['Ana', 'Ben', 'Chen', 'Dara', 'Eli', 'Fatima', 'Gus', 'Hana', 'Ivan', 'Jae', 'Kofi', 'Lena', 'Mo', 'Nia', 'Oscar', 'Pia']
const LAST = ['Okoro', 'Silva', 'Novak', 'Kim', 'Patel', 'Garcia', 'Nguyen', 'Haddad', 'Moreau', 'Lind']

export function incidents(n = 900) {
  const r = rng(42)
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)]
  const cats = Object.keys(INCIDENT_PATTERNS)
  const weights = [0.24, 0.2, 0.2, 0.13, 0.11, 0.12]
  const rows: Record<string, string | number | null>[] = []
  const start = new Date('2025-01-06T08:00:00Z').getTime()
  for (let i = 0; i < n; i++) {
    let x = r()
    let cat = cats[cats.length - 1]
    for (let k = 0; k < cats.length; k++) {
      if (x < weights[k]) {
        cat = cats[k]
        break
      }
      x -= weights[k]
    }
    const svc = pick(SERVICES)
    const base = pick(INCIDENT_PATTERNS[cat]).replace('{svc}', svc).replace('{n}', String(Math.floor(r() * 300) + 20)).replace('{v}', `v${Math.floor(r() * 9) + 1}.${Math.floor(r() * 20)}`)
    const extra = pick(CONFUSERS)
    // A share of descriptions mention another category's symptom, so keywords alone are ambiguous.
    const mixed = r() < 0.22 ? ` Also saw ${pick(INCIDENT_PATTERNS[pick(cats)]).replace('{svc}', pick(SERVICES)).replace('{n}', '30').replace('{v}', 'v2.1').split(';')[0]}.` : ''
    let label: string | null = cat
    if (r() < 0.05) label = pick(cats) // reviewer disagreement / label noise
    if (r() < 0.035) label = null // unlabeled
    const who = `${pick(FIRST)} ${pick(LAST)}`
    rows.push({
      incident_id: `INC-${(10000 + i).toString()}`,
      opened_at: new Date(start + i * 9.7 * 3600_000 + Math.floor(r() * 3600_000)).toISOString().slice(0, 19) + 'Z',
      service: svc,
      severity: pick(['SEV1', 'SEV2', 'SEV2', 'SEV3', 'SEV3', 'SEV3', 'SEV4']),
      summary: base.charAt(0).toUpperCase() + base.slice(1),
      description: `${base}. ${extra}${mixed} Reported by ${who}.`.replace(/\s+/g, ' ').trim(),
      reporter_email: `${who.split(' ')[0].toLowerCase()}.${who.split(' ')[1].toLowerCase()}@northwind.example`,
      category: label,
      resolution_team: label === 'Database' ? 'Data Platform' : label === 'Network' ? 'Infrastructure' : label === 'Deployment' ? 'Release Eng' : label === 'Authentication' ? 'Identity' : label === 'Storage' ? 'Infrastructure' : label ? 'Integrations' : null,
      reviewed: r() < 0.9 ? 'yes' : 'no'
    })
    // Occasional duplicate filings of the same incident.
    if (r() < 0.03) rows.push({ ...rows[rows.length - 1], incident_id: `INC-${(10000 + i).toString()}-dup` })
  }
  return rows
}

const TICKET_PATTERNS: Record<string, string[]> = {
  Billing: ['I was charged twice for order {o}', 'Invoice {o} shows the wrong tax amount', 'How do I update the card on file?', 'Refund for {o} has not arrived', 'Why did my subscription price change?'],
  Shipping: ['Package for order {o} has not moved in 5 days', 'Tracking says delivered but nothing arrived', 'Can I change the delivery address for {o}?', 'Shipment {o} arrived damaged', 'Delivery estimate keeps slipping'],
  'Account Access': ['I cannot log in after resetting my password', 'Locked out after too many attempts', 'Not receiving the verification code', 'Need to change the email on my account', 'Two-factor app was lost with my phone'],
  Technical: ['The portal shows an error when I export reports', 'API returns 500 when creating shipments', 'Webhook stopped firing yesterday', 'Mobile app crashes on the orders screen', 'Integration with our ERP is timing out'],
  Returns: ['How do I return item from order {o}?', 'Return label for {o} is not generating', 'Received the wrong item, want to exchange', 'Return was received but no refund issued', 'Can I return after 30 days?']
}

export function tickets(n = 700) {
  const r = rng(7)
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)]
  const routes = Object.keys(TICKET_PATTERNS)
  const rows: Record<string, string | number | null>[] = []
  const start = new Date('2025-03-01T12:00:00Z').getTime()
  for (let i = 0; i < n; i++) {
    const route = pick(routes)
    const o = `ORD-${Math.floor(r() * 90000) + 10000}`
    const text = pick(TICKET_PATTERNS[route]).replace('{o}', o)
    const who = `${pick(FIRST)} ${pick(LAST)}`
    rows.push({
      ticket_id: `T-${50000 + i}`,
      created_at: new Date(start + i * 5.3 * 3600_000).toISOString().slice(0, 19) + 'Z',
      channel: pick(['email', 'chat', 'web form', 'phone']),
      subject: text.slice(0, 60),
      body: `${text}. ${pick(['Please help.', 'This is urgent.', 'Thanks in advance.', `You can reach me at ${who.split(' ')[0].toLowerCase()}@customer.example or 555-01${Math.floor(r() * 90 + 10)}-${Math.floor(r() * 9000 + 1000)}.`, ''])}`.trim(),
      customer_email: `${who.split(' ')[0].toLowerCase()}.${who.split(' ')[1].toLowerCase()}@customer.example`,
      priority: pick(['low', 'normal', 'normal', 'high']),
      route_to: r() < 0.04 ? pick(routes) : route
    })
  }
  return rows
}

/** Minimal valid PDF with a text layer (Helvetica). An empty lines array produces a page with no text. */
export function makePdf(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  const content = lines.length
    ? `BT /F1 11 Tf 56 760 Td 14 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`
    : '0.85 g 56 400 500 300 re f'
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out))
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = Buffer.byteLength(out)
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

const PROCEDURES: Record<string, string> = {
  'vendor-security-review.md': `# Vendor security review procedure (synthetic)

Applies to any vendor that will store or process Northwind customer data or employee data.

## Requirements
- Vendors handling customer data must hold a current **SOC 2 Type II** report, or **ISO/IEC 27001** certification with a published Statement of Applicability.
- Data must be encrypted in transit (TLS 1.2+) and at rest.
- The vendor must support SSO (SAML or OIDC) for staff access.
- Vendors processing EU personal data must offer a GDPR Data Processing Addendum.
- Sub-processors must be listed publicly.

## Process
1. Check the Approved Vendor Register. If the vendor is already approved and the review is less than 12 months old, no new review is needed.
2. Collect evidence from the vendor's trust or security page. Record certifications and the date of the latest report.
3. Note gaps. A missing SOC 2/ISO certification is a **blocking gap** for customer-data use.
4. Draft an assessment: approve, approve with conditions, or reject.
5. The Operations manager signs off. Do not email vendors directly from automation.

## Output
Record each review in the "Vendor reviews" table: vendor, certifications found, gaps, recommendation, reviewer, date.
`,
  'incident-response.md': `# Incident response runbook (synthetic)

## Severity
- SEV1: customer-facing outage of checkout, billing or auth. Page incident commander immediately.
- SEV2: degraded service for many customers. Page the owning team.
- SEV3: limited impact; fix during business hours.
- SEV4: cosmetic or internal.

## Triage
1. Identify the affected service and owning team from the Service Inventory.
2. Classify the incident category: Database, Network, Deployment, Authentication, Storage, Third-party API.
3. For Deployment incidents, check whether a rollback is possible before debugging.
4. For Third-party API incidents, check the vendor status page and open a vendor ticket.
5. Post updates every 30 minutes for SEV1/SEV2.

## Routing
| Category | Team |
|---|---|
| Database | Data Platform |
| Network, Storage | Infrastructure |
| Deployment | Release Engineering |
| Authentication | Identity |
| Third-party API | Integrations |
`,
  'change-management.md': `# Change management (synthetic)

All production changes require a ticket. Schema migrations must ship before dependent code.
Freeze windows: the last three business days of each quarter.
Rollback plans are mandatory for SEV1-capable services (checkout, billing, auth-gateway).
`,
  'on-call-handbook.md': `# On-call handbook (synthetic)

On-call engineers acknowledge pages within 5 minutes. Escalate to the secondary after 15 minutes.
Use the incident channel for coordination. Hand off with a written summary at shift end.
The on-call directory lists primary and secondary contacts per service.
`
}

const POSTMORTEMS: Record<string, string> = {
  'pm-2025-03-credential-exposure.md': `# Postmortem: credential exposure (RESTRICTED, synthetic)\n\nA service token was committed to a private repository and rotated within 40 minutes. Affected system: auth-gateway.\nRoot cause: missing pre-commit secret scanning. Actions: enforce scanning, shorten token lifetimes.`,
  'pm-2025-06-phishing.md': `# Postmortem: phishing campaign (RESTRICTED, synthetic)\n\nThree staff accounts received targeted phishing. One password was entered; MFA blocked access.\nActions: phishing-resistant MFA for finance and IT.`
}

export function writeSeedFiles(root: string) {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  const inc = incidents()
  writeFileSync(join(root, 'incidents.csv'), toCsv(Object.keys(inc[0]), inc))
  writeFileSync(join(root, 'support_tickets.jsonl'), tickets().map((t) => JSON.stringify(t)).join('\n'))
  const proc = join(root, 'procedures')
  mkdirSync(proc, { recursive: true })
  for (const [f, body] of Object.entries(PROCEDURES)) writeFileSync(join(proc, f), body)
  writeFileSync(
    join(proc, 'data-retention-policy.pdf'),
    makePdf([
      'Northwind Logistics - Data Retention Policy (synthetic)',
      '',
      'Customer support tickets: retain 3 years, then delete.',
      'Incident records: retain 5 years for trend analysis.',
      'Screen recordings used for automation design: retain 30 days.',
      'Training datasets derived from customer data require manager approval',
      'and must exclude direct identifiers such as email addresses and phone numbers.',
      'Exports of customer data outside approved systems are prohibited.'
    ])
  )
  writeFileSync(join(proc, 'scanned-memo.pdf'), makePdf([]))
  writeFileSync(join(proc, 'budget-2026.xlsx'), Buffer.from('PK\u0003\u0004 synthetic placeholder - not a real workbook'))
  const pm = join(root, 'security_postmortems')
  mkdirSync(pm, { recursive: true })
  for (const [f, body] of Object.entries(POSTMORTEMS)) writeFileSync(join(pm, f), body)
  const dbPath = join(root, 'ops_inventory.sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE services (service TEXT PRIMARY KEY, owner_team TEXT, tier TEXT, oncall_email TEXT, runbook TEXT, cost_center TEXT);
           CREATE TABLE vendors (vendor TEXT PRIMARY KEY, category TEXT, status TEXT, last_review TEXT, certifications TEXT, risk_rating TEXT, contract_owner TEXT);`)
  const r = rng(99)
  const teams = ['Data Platform', 'Infrastructure', 'Release Eng', 'Identity', 'Integrations', 'Commerce']
  const insS = db.prepare('INSERT INTO services VALUES (?,?,?,?,?,?)')
  SERVICES.forEach((s, i) => insS.run(s, teams[i % teams.length], i < 3 ? 'tier-1' : i < 7 ? 'tier-2' : 'decommissioned', `${s}-oncall@northwind.example`, `runbooks/${s}.md`, `CC-${400 + i}`))
  const vendors: [string, string, string, string, string, string][] = [
    ['Parcelwise', 'Carrier API', 'approved', '2026-02-11', 'SOC 2 Type II', 'low'],
    ['Taxly', 'Tax calculation', 'approved', '2025-07-30', 'ISO 27001', 'medium'],
    ['Signalbird', 'SMS provider', 'conditional', '2025-11-02', 'SOC 2 Type I', 'medium'],
    ['MapNorth', 'Maps & geocoding', 'approved', '2026-05-19', 'SOC 2 Type II, ISO 27001', 'low'],
    ['FraudLens', 'Fraud scoring', 'under review', '2026-09-01', 'unknown', 'high'],
    ['OldPost', 'Legacy mail', 'terminated', '2023-04-14', 'none', 'high']
  ]
  const insV = db.prepare('INSERT INTO vendors VALUES (?,?,?,?,?,?,?)')
  for (const v of vendors) insV.run(...v, `${['Priya', 'Omar', 'Alex'][Math.floor(r() * 3)]} (Operations)`)
  db.close()
  return { root, dbPath }
}


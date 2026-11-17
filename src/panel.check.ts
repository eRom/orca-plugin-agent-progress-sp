// Scénarios de `orca plugin check` et de `orca plugin shot --scenario` : le worker réel tourne sur le même hôte,
// d'où `workspace.list` vide ; l'instantané que le panneau lit est celui de `progress.snapshot`.
import { defineCheck } from 'orca/testing'
import type { AgentRow, Snapshot, WorkspaceView } from './protocol'
import type { TaskRow, Workstream } from './model/workstream'

const NOW = Date.now()
const MINUTE = 60_000
const DAY = 86_400_000
const results = { 'workspace.list': { workspaces: [], truncated: false } }

function workstream(overrides: Partial<Workstream> = {}): Workstream {
  return {
    key: 'acme-api:billing',
    label: 'billing-v2',
    stage: 'tasks',
    hasIntent: true,
    skippedStages: [],
    docs: {
      intent: '/work/acme-api/docs/superpowers/intents/i.md',
      spec: '/work/acme-api/docs/superpowers/specs/s.md',
      plan: '/work/acme-api/docs/superpowers/plans/p.md',
      ledger: '/work/acme-api/.superpowers/sdd/billing/progress.md',
    },
    tasks: [],
    tasksDone: 0,
    tasksTotal: 0,
    unparsedLines: 0,
    notes: [],
    lastMovedAt: NOW - 20_000,
    ledgerUpdatedAt: NOW - 20_000,
    live: true,
    ...overrides,
  }
}

const TITLES = [
  'Invoice schema',
  'Tax rules',
  'Checkout endpoint',
  'Webhook retries',
  'Idempotency keys',
  'Acceptance pass',
  'README',
]

/** `count` tâches : les `done` premières faites, la suivante en correction (tour 2 sur 5) si `fixing`. */
function tasks(count: number, done: number, fixing = true): TaskRow[] {
  return Array.from({ length: count }, (_, index): TaskRow => {
    const id = String(index + 1)
    const title = TITLES[index] ?? `Generated task number ${index + 1} with a fairly long title`
    if (index < done) return { id, title, status: 'done' }
    if (index === done && fixing) return { id, title, status: 'fix', fix: { round: 2, max: 5 } }
    return { id, title, status: 'todo' }
  })
}

function agent(state: AgentRow['state'], minutesAgo: number, terminalId: string | null = 't1'): AgentRow {
  return { terminalId, agent: 'claude', state, since: NOW - minutesAgo * MINUTE }
}

function view(overrides: Partial<WorkspaceView> = {}): WorkspaceView {
  return {
    workspaceId: 'w-api',
    name: 'acme-api',
    branch: 'main',
    root: '/work/acme-api',
    workstreams: [workstream({ tasks: tasks(7, 3), tasksDone: 3, tasksTotal: 7 })],
    agents: [agent('working', 4)],
    needsYou: false,
    ...overrides,
  }
}

const mobileApp = view({
  workspaceId: 'w-app',
  name: 'mobile-app',
  branch: 'feat/offline',
  root: '/work/mobile-app',
  workstreams: [workstream({ key: 'app:offline', label: 'offline-sync', stage: 'review', tasks: tasks(5, 5, false), tasksDone: 5, tasksTotal: 5 })],
  agents: [agent('blocked', 2, 't2')],
  needsYou: true,
})
const docsSite = view({
  workspaceId: 'w-docs',
  name: 'docs-site',
  branch: 'dev',
  root: '/work/docs-site',
  workstreams: [workstream({ key: 'docs:spec', label: 'docs-site-spec', stage: 'spec', hasIntent: false, docs: {}, tasks: [] })],
  agents: [agent('working', 9, 't3')],
})
const resting = [
  { workspaceId: 'r1', name: 'acme-cli', lastDoc: 'cli-completions', lastMovedAt: NOW - 9 * DAY },
  { workspaceId: 'r2', name: 'old-experiment', lastDoc: 'tiny-spike', lastMovedAt: NOW - 31 * DAY },
]

function snapshot(live: WorkspaceView[], overrides: Partial<Snapshot> = {}): Snapshot {
  const focusedView = live[0]
  return {
    focusedWorkspaceId: focusedView?.workspaceId ?? null,
    focused: focusedView ? { workspaceId: focusedView.workspaceId, name: focusedView.name, branch: focusedView.branch } : null,
    live,
    resting: [],
    anySuperpowers: live.length > 0,
    localRoots: live.map((item) => item.root),
    ...overrides,
  }
}

const stub = (value: Snapshot) => ({ results, requests: { 'progress.snapshot': value } })

export default defineCheck({
  empty: stub(snapshot([], { anySuperpowers: false })),
  focused: stub(snapshot([view(), mobileApp, docsSite], { resting })),
  focusedResting: stub(
    snapshot([mobileApp, docsSite], {
      focusedWorkspaceId: 'w-idle',
      focused: { workspaceId: 'w-idle', name: 'acme-cli', branch: 'main' },
      resting,
    }),
  ),
  needsYou: stub(
    snapshot([
      view({ agents: [agent('waiting', 7), agent('working', 3, 't9')], needsYou: true }),
      mobileApp,
    ]),
  ),
  multiple: stub(
    snapshot([
      view({
        workstreams: [
          workstream({ tasks: tasks(7, 3), tasksDone: 3, tasksTotal: 7 }),
          workstream({ key: 'acme-api:search', label: 'search-filters', stage: 'plan', tasks: [], lastMovedAt: NOW - 3 * DAY }),
        ],
      }),
      mobileApp,
    ]),
  ),
  upstream: stub(
    snapshot([
      view({
        workstreams: [
          workstream({
            key: 'acme-api:upstream',
            label: 'upstream-sdd',
            stage: 'tasks',
            hasIntent: false,
            skippedStages: ['spec'],
            docs: { plan: '/work/acme-api/docs/superpowers/plans/p.md', ledger: '/work/acme-api/.superpowers/sdd/up/progress.md' },
            tasks: tasks(4, 1, false),
            tasksDone: 1,
            tasksTotal: 4,
            unparsedLines: 2,
            notes: ['spec lives outside this project'],
          }),
        ],
        agents: [],
      }),
    ]),
  ),
  // Pire cas de la frise : tout le chemin parcouru, intent compris, avec la coche sur chaque étape passée.
  review: stub(
    snapshot([
      view({ workstreams: [workstream({ stage: 'review', tasks: tasks(7, 7, false), tasksDone: 7, tasksTotal: 7 })] }),
    ]),
  ),
  longPlan: stub(
    snapshot([view({ workstreams: [workstream({ tasks: tasks(60, 20), tasksDone: 20, tasksTotal: 60 })] })]),
  ),
})

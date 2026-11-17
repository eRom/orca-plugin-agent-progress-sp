// Joue le panneau comme Orca le ferait : mockHost, le worker est simulé par `requests`, les changements par `view.post`.
import { afterEach, assert, mockHost, mount, test, type TestPanel } from 'orca/testing'
import type { TaskRow, Workstream } from './model/workstream'
import * as panelModule from './panel'
import { retryDelay, snapshotRetry } from './panel/state'
import type { AgentRow, RestingView, Snapshot, WorkspaceView } from './protocol'

let view: TestPanel | undefined
afterEach(() => view?.unmount())

const NOW = Date.now()
const DAY = 86_400_000

function workstream(overrides: Partial<Workstream> = {}): Workstream {
  return {
    key: 'k1',
    label: 'demo-plan',
    stage: 'tasks',
    hasIntent: false,
    skippedStages: [],
    docs: {},
    tasks: [],
    tasksDone: 0,
    tasksTotal: 0,
    unparsedLines: 0,
    notes: [],
    lastMovedAt: NOW - 1000,
    ledgerUpdatedAt: null,
    live: true,
    ...overrides,
  }
}

/** 7 tâches : 3 faites, la 4 en correction (tour 2 sur 5), le reste à faire. */
function sevenTasks(): TaskRow[] {
  return [1, 2, 3, 4, 5, 6, 7].map((n): TaskRow => {
    if (n <= 3) return { id: String(n), title: `Task title ${n}`, status: 'done' }
    if (n === 4) return { id: '4', title: 'Task title 4', status: 'fix', fix: { round: 2, max: 5 } }
    return { id: String(n), title: `Task title ${n}`, status: 'todo' }
  })
}

function workspaceView(overrides: Partial<WorkspaceView> = {}): WorkspaceView {
  return {
    workspaceId: 'w1',
    name: 'EROM-HQ',
    branch: 'main',
    root: '/work/hq',
    workstreams: [workstream()],
    agents: [],
    needsYou: false,
    ...overrides,
  }
}

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  const live = overrides.live ?? [workspaceView()]
  const focusedView = live.find((candidate) => candidate.workspaceId === (overrides.focusedWorkspaceId ?? 'w1'))
  return {
    focusedWorkspaceId: 'w1',
    focused: focusedView ? { workspaceId: focusedView.workspaceId, name: focusedView.name, branch: focusedView.branch } : null,
    live,
    resting: [],
    anySuperpowers: true,
    localRoots: live.map((candidate) => candidate.root),
    ...overrides,
  }
}

type Calls = {
  openFile: { workspaceId: string; path: string }[]
  openWorkspace: { workspaceId: string }[]
  focusTerminal: { terminalId: string }[]
}

async function mountWith(initial: Snapshot): Promise<{ panel: TestPanel; calls: Calls }> {
  const calls: Calls = { openFile: [], openWorkspace: [], focusTerminal: [] }
  const host = mockHost({
    requests: {
      'progress.snapshot': initial,
      'progress.openFile': (input) => {
        calls.openFile.push(input)
        return { opened: true }
      },
      'progress.openWorkspace': (input) => {
        calls.openWorkspace.push(input)
        return { opened: true }
      },
      'progress.focusTerminal': (input) => {
        calls.focusTerminal.push(input)
        return { focused: true }
      },
    },
  })
  const panel = await mount(panelModule, { host })
  view = panel
  return { panel, calls }
}

function assertClean(panel: TestPanel): void {
  assert.deepEqual(panel.errors, [])
  assert.deepEqual(panel.refusals, [])
}

type Row = { key: string; cells: Record<string, unknown> }
const rowsOf = (panel: TestPanel, label: string | RegExp): Row[] => {
  const table = panel.find({ type: 'Table', label })
  assert.ok(table, `table ${String(label)} should be drawn`)
  return table.props.rows as Row[]
}
const collapsibleTitled = (panel: TestPanel, title: string) =>
  panel.findAll({ type: 'Collapsible' }).find((element) => element.props.title === title)

test('a snapshot without any Superpowers file draws the empty state', async () => {
  const { panel } = await mountWith(
    snapshot({ live: [], focusedWorkspaceId: null, focused: null, anySuperpowers: false, localRoots: [] }),
  )
  assert.ok(panel.find({ label: 'No Superpowers work in progress' }))
  assert.match(
    String(panel.find({ type: 'EmptyState' })?.props.description),
    /^Requires Superpowers\. This panel follows the specs, plans and ledgers that Superpowers writes in your workspaces\. Install Superpowers, start a brainstorm, and the work shows up here\.$/,
  )
  assertClean(panel)
})

test('the header shows the focused workspace and its branch', async () => {
  const { panel } = await mountWith(snapshot())
  assert.ok(panel.find({ type: 'Heading', text: 'Superpowers' }))
  assert.ok(panel.find({ text: 'EROM-HQ · main' }))
  assertClean(panel)
})

test('the header shows the focused workspace even when it has no live work', async () => {
  const other = workspaceView({ workspaceId: 'w2', name: 'lazaret', root: '/work/lazaret' })
  const { panel } = await mountWith(
    snapshot({
      live: [other],
      focusedWorkspaceId: 'w9',
      focused: { workspaceId: 'w9', name: 'idle-ws', branch: null },
    }),
  )
  assert.ok(panel.find({ text: 'idle-ws' }))
  assertClean(panel)
})

test('a workspace at the Tasks stage draws the strip, the progress and the task rows', async () => {
  const live = workspaceView({
    workstreams: [
      workstream({
        stage: 'tasks',
        hasIntent: true,
        tasks: sevenTasks(),
        tasksDone: 3,
        tasksTotal: 7,
        docs: { spec: '/work/hq/docs/superpowers/specs/s.md', plan: '/work/hq/docs/superpowers/plans/p.md' },
      }),
    ],
  })
  const { panel } = await mountWith(snapshot({ live: [live] }))
  assert.ok(panel.find({ type: 'Text', text: '✓ Intent' }))
  assert.ok(panel.find({ type: 'Text', text: '✓ Spec' }))
  assert.ok(panel.find({ type: 'Text', text: '✓ Plan' }))
  assert.ok(panel.find({ type: 'Badge', text: 'Tasks' }))
  assert.equal(panel.find({ type: 'Text', text: 'Review' })?.props.muted, true)
  assert.equal(panel.find({ type: 'Text', text: 'Done' })?.props.muted, true)
  assert.equal(panel.find({ type: 'Progress' })?.label, 'Tasks 3 of 7')
  const rows = rowsOf(panel, /^Tasks/)
  assert.equal(rows.length, 7)
  assert.deepEqual(rows.map((row) => row.cells.status), ['Done', 'Done', 'Done', 'Fix 2/5', '–', '–', '–'])
  assertClean(panel)
})

test('the in-progress status reads In progress', async () => {
  const tasks: TaskRow[] = [
    { id: '1', title: 'one', status: 'done' },
    { id: '2', title: 'two', status: 'in-progress' },
  ]
  const live = workspaceView({ workstreams: [workstream({ tasks, tasksDone: 1, tasksTotal: 2 })] })
  const { panel } = await mountWith(snapshot({ live: [live] }))
  assert.deepEqual(rowsOf(panel, /^Tasks/).map((row) => row.cells.status), ['Done', 'In progress'])
  assertClean(panel)
})

test('a work item without tasks draws neither progress nor task table', async () => {
  const live = workspaceView({ workstreams: [workstream({ stage: 'spec', tasksTotal: 0 })] })
  const { panel } = await mountWith(snapshot({ live: [live] }))
  assert.equal(panel.find({ type: 'Progress' }), null)
  assert.equal(panel.find({ type: 'Table' }), null)
  assert.ok(panel.find({ type: 'Badge', text: 'Spec' }))
  assertClean(panel)
})

test('the Intent step only shows when the work has an intent', async () => {
  const without = await mountWith(snapshot({ live: [workspaceView({ workstreams: [workstream({ hasIntent: false })] })] }))
  assert.equal(without.panel.find({ text: /Intent/ }), null)
  assertClean(without.panel)

  const withIntent = await mountWith(snapshot({ live: [workspaceView({ workstreams: [workstream({ hasIntent: true })] })] }))
  assert.ok(withIntent.panel.find({ type: 'Text', text: '✓ Intent' }))
  assertClean(withIntent.panel)
})

test('a skipped stage is drawn muted, without a check mark', async () => {
  const live = workspaceView({ workstreams: [workstream({ stage: 'tasks', skippedStages: ['spec'] })] })
  const { panel } = await mountWith(snapshot({ live: [live] }))
  assert.equal(panel.find({ text: '✓ Spec' }), null)
  assert.equal(panel.find({ type: 'Text', text: 'Spec' })?.props.muted, true)
  assert.ok(panel.find({ type: 'Text', text: '✓ Plan' }))
  assertClean(panel)
})

test('other workspaces with live work are counted in a collapsed section', async () => {
  const live = [
    workspaceView(),
    workspaceView({ workspaceId: 'w2', name: 'agent-network', root: '/work/an', needsYou: true }),
    workspaceView({ workspaceId: 'w3', name: 'lazaret', root: '/work/laz' }),
  ]
  const { panel } = await mountWith(snapshot({ live }))
  const section = collapsibleTitled(panel, 'Other work in progress')
  assert.ok(section)
  assert.equal(section.props.description, '2 in progress · 1 needs you')
  assertClean(panel)
})

test('the other-work description pluralizes the needs-you count', async () => {
  const live = [
    workspaceView(),
    workspaceView({ workspaceId: 'w2', name: 'a', root: '/work/a', needsYou: true }),
    workspaceView({ workspaceId: 'w3', name: 'b', root: '/work/b', needsYou: true }),
  ]
  const { panel } = await mountWith(snapshot({ live }))
  assert.equal(collapsibleTitled(panel, 'Other work in progress')?.props.description, '2 in progress · 2 need you')
  assertClean(panel)
})

test('the other-work table puts the workspaces that need you first and reads each stage', async () => {
  const live = [
    workspaceView(),
    workspaceView({
      workspaceId: 'w2',
      name: 'quiet',
      root: '/work/q',
      workstreams: [workstream({ stage: 'tasks', tasksTotal: 7, tasksDone: 3, tasks: sevenTasks() })],
      agents: [{ terminalId: 't1', agent: 'claude', state: 'working', since: NOW }],
    }),
    workspaceView({
      workspaceId: 'w3',
      name: 'waiting',
      root: '/work/w',
      workstreams: [workstream({ stage: 'review' })],
      needsYou: true,
      agents: [{ terminalId: 't2', agent: 'claude', state: 'waiting', since: NOW }],
    }),
  ]
  const { panel } = await mountWith(snapshot({ live }))
  await panel.toggle({ type: 'Collapsible', label: 'Other work in progress' })
  const rows = rowsOf(panel, /work in progress/i)
  assert.deepEqual(rows.map((row) => row.key), ['w3', 'w2'])
  assert.deepEqual(rows[0].cells, { workspace: 'waiting', stage: 'Review', agent: '● Needs you' })
  assert.deepEqual(rows[1].cells, { workspace: 'quiet', stage: 'Task 4/7', agent: 'Working' })
  assertClean(panel)
})

test('a focused workspace without live work shows the table in the open, not in a Collapsible', async () => {
  const live = [
    workspaceView({ workspaceId: 'w2', name: 'lazaret', root: '/work/laz' }),
    workspaceView({ workspaceId: 'w3', name: 'agent-network', root: '/work/an', needsYou: true }),
  ]
  const { panel } = await mountWith(
    snapshot({ live, focusedWorkspaceId: 'w9', focused: { workspaceId: 'w9', name: 'idle-ws', branch: 'main' } }),
  )
  assert.equal(collapsibleTitled(panel, 'Other work in progress'), undefined)
  const rows = rowsOf(panel, /work in progress/i)
  assert.deepEqual(rows.map((row) => row.key), ['w3', 'w2'])
  assert.equal(panel.find({ type: 'Progress' }), null)
  assertClean(panel)
})

test('with no focus at all the table is shown in the open', async () => {
  const live = [workspaceView({ workspaceId: 'w2', name: 'lazaret', root: '/work/laz' })]
  const { panel } = await mountWith(snapshot({ live, focusedWorkspaceId: null, focused: null }))
  assert.equal(collapsibleTitled(panel, 'Other work in progress'), undefined)
  assert.equal(rowsOf(panel, /work in progress/i).length, 1)
  assertClean(panel)
})

test('activating a row of the table brings Orca to that workspace', async () => {
  const live = [workspaceView(), workspaceView({ workspaceId: 'w2', name: 'lazaret', root: '/work/laz' })]
  const { panel, calls } = await mountWith(snapshot({ live }))
  await panel.toggle({ type: 'Collapsible', label: 'Other work in progress' })
  await panel.activateRow({ type: 'Table', label: /work in progress/i }, 'w2')
  assert.deepEqual(calls.openWorkspace, [{ workspaceId: 'w2' }])
  assertClean(panel)
})

test('pressing a document button opens that document through the worker', async () => {
  const plan = '/work/hq/docs/superpowers/plans/p.md'
  const live = workspaceView({ workstreams: [workstream({ docs: { plan, ledger: '/work/hq/.superpowers/sdd/x/progress.md' } })] })
  const { panel, calls } = await mountWith(snapshot({ live: [live] }))
  await panel.press({ role: 'button', text: 'Plan' })
  assert.deepEqual(calls.openFile, [{ workspaceId: 'w1', path: plan }])
  assert.ok(panel.find({ role: 'button', text: 'Ledger' }))
  assert.equal(panel.find({ role: 'button', text: 'Spec' }), null)
  assertClean(panel)
})

test('a document outside every local root has no button, one under another local root has', async () => {
  const outside = '/elsewhere/docs/superpowers/specs/s.md'
  const sibling = '/work/other-checkout/docs/superpowers/plans/p.md'
  const live = workspaceView({ workstreams: [workstream({ docs: { spec: outside, plan: sibling } })] })
  const { panel, calls } = await mountWith(
    snapshot({ live: [live], localRoots: ['/work/hq', '/work/other-checkout'] }),
  )
  assert.equal(panel.find({ role: 'button', text: 'Spec' }), null)
  await panel.press({ role: 'button', text: 'Plan' })
  assert.deepEqual(calls.openFile, [{ workspaceId: 'w1', path: sibling }])
  assertClean(panel)
})

test('a path that merely shares a root prefix does not count as under that root', async () => {
  const live = workspaceView({ workstreams: [workstream({ docs: { plan: '/work/hq-copy/docs/p.md' } })] })
  const { panel } = await mountWith(snapshot({ live: [live] }))
  assert.equal(panel.find({ role: 'button', text: 'Plan' }), null)
  assertClean(panel)
})

test('agents are listed with their state, the ones waiting for you first, and a terminal button', async () => {
  const agents: AgentRow[] = [
    { terminalId: 't9', agent: 'claude', state: 'blocked', since: NOW - 4 * 60_000 },
    { terminalId: 't2', agent: null, state: 'working', since: NOW - 60_000 },
    { terminalId: null, agent: 'codex', state: 'done', since: NOW - 120_000 },
  ]
  const { panel, calls } = await mountWith(snapshot({ live: [workspaceView({ agents, needsYou: true })] }))
  const lines = panel.findAll({ type: 'Text', text: /(working|needs you|idle) for/ }).map((element) => element.text)
  assert.equal(lines.length, 3)
  assert.match(lines[0], /^Claude needs you for/)
  assert.match(lines[1], /^Agent working for/)
  assert.match(lines[2], /^Codex idle for/)
  const buttons = panel.findAll({ type: 'IconButton', label: 'Go to terminal' })
  assert.equal(buttons.length, 2, 'an agent without a terminal has no button')
  await panel.press(buttons[0])
  assert.deepEqual(calls.focusTerminal, [{ terminalId: 't9' }])
  assertClean(panel)
})

test('the footer gives the label, the ledger age, the lines not understood and the notes', async () => {
  const live = workspaceView({
    workstreams: [
      workstream({
        label: 'portal-bilingual',
        ledgerUpdatedAt: NOW - 20_000,
        unparsedLines: 2,
        notes: ['plan moved', 'spec outside project'],
      }),
    ],
  })
  const { panel } = await mountWith(snapshot({ live: [live] }))
  const footer = panel.find({ type: 'Text', text: /^portal-bilingual/ })
  assert.ok(footer)
  assert.equal(footer.props.muted, true)
  assert.equal(footer.props.size, 'xs')
  assert.match(footer.text, /^portal-bilingual · ledger updated .+ · 2 lines not understood · plan moved · spec outside project$/)
  assertClean(panel)
})

test('the footer stays bare without ledger, unparsed lines or notes, and singularizes one line', async () => {
  const bare = await mountWith(snapshot({ live: [workspaceView({ workstreams: [workstream({ label: 'bare' })] })] }))
  assert.equal(bare.panel.find({ type: 'Text', text: /^bare/ })?.text, 'bare')
  const single = await mountWith(
    snapshot({ live: [workspaceView({ workstreams: [workstream({ label: 'one', unparsedLines: 1 })] })] }),
  )
  assert.equal(single.panel.find({ type: 'Text', text: /^one/ })?.text, 'one · 1 line not understood')
  assertClean(single.panel)
})

test('several work items offer a Work selector, the most recent first, and the choice is kept', async () => {
  const recent = workstream({ key: 'a', label: 'recent-plan', stage: 'plan', tasksTotal: 0 })
  const older = workstream({ key: 'b', label: 'older-plan', stage: 'review' })
  const { panel } = await mountWith(snapshot({ live: [workspaceView({ workstreams: [recent, older] })] }))
  assert.equal(panel.valueOf({ type: 'Select', label: 'Work' }), 'a')
  assert.ok(panel.find({ type: 'Badge', text: 'Plan' }))
  await panel.select({ type: 'Select', label: 'Work' }, 'b')
  assert.ok(panel.find({ type: 'Badge', text: 'Review' }))
  assert.ok(panel.find({ type: 'Text', text: 'older-plan' }))
  assertClean(panel)
})

test('a single work item draws no Work selector', async () => {
  const { panel } = await mountWith(snapshot())
  assert.equal(panel.find({ type: 'Select' }), null)
  assertClean(panel)
})

test('a changed snapshot moves the sheet to the new focused workspace', async () => {
  const first = snapshot({ live: [workspaceView({ workstreams: [workstream({ stage: 'plan' })] })] })
  const { panel } = await mountWith(first)
  assert.ok(panel.find({ type: 'Badge', text: 'Plan' }))
  assert.ok(panel.find({ text: 'EROM-HQ · main' }))

  const next = snapshot({
    live: [
      workspaceView({ workspaceId: 'w2', name: 'lazaret', branch: 'dev', root: '/work/laz', workstreams: [workstream({ stage: 'review' })] }),
    ],
    focusedWorkspaceId: 'w2',
  })
  await panel.post('progress.changed', next)
  assert.ok(panel.find({ type: 'Badge', text: 'Review' }))
  assert.equal(panel.find({ type: 'Badge', text: 'Plan' }), null)
  assert.ok(panel.find({ text: 'lazaret · dev' }))
  assertClean(panel)
})

test('resting workspaces are listed in a collapsed section with a fixed age', async () => {
  const resting: RestingView[] = [
    { workspaceId: 'r1', name: 'old-one', lastDoc: 'big-plan', lastMovedAt: NOW - 9 * DAY },
    { workspaceId: 'r2', name: 'older-one', lastDoc: 'tiny-plan', lastMovedAt: NOW - 30 * DAY },
  ]
  const { panel } = await mountWith(snapshot({ resting }))
  const section = collapsibleTitled(panel, 'At rest')
  assert.ok(section)
  assert.equal(section.props.description, '2 workspaces, nothing moved in 7 days')
  await panel.toggle({ type: 'Collapsible', label: 'At rest' })
  const items = panel.findAll({ type: 'ListItem' })
  assert.deepEqual(items.map((item) => item.props.title), ['old-one', 'older-one'])
  assert.deepEqual(items.map((item) => item.props.description), ['big-plan, 9 days ago', 'tiny-plan, 30 days ago'])
  assertClean(panel)
})

test('one resting workspace reads in the singular', async () => {
  const resting: RestingView[] = [{ workspaceId: 'r1', name: 'solo', lastDoc: 'plan', lastMovedAt: NOW - DAY * 8 }]
  const { panel } = await mountWith(snapshot({ resting }))
  assert.equal(collapsibleTitled(panel, 'At rest')?.props.description, '1 workspace, nothing moved in 7 days')
  assertClean(panel)
})

test('only resting work: no sheet, no other-work section, the resting section is there', async () => {
  const resting: RestingView[] = [{ workspaceId: 'r1', name: 'solo', lastDoc: 'plan', lastMovedAt: NOW - DAY * 8 }]
  const { panel } = await mountWith(
    snapshot({ live: [], focusedWorkspaceId: 'r1', focused: { workspaceId: 'r1', name: 'solo', branch: 'main' }, resting, localRoots: [] }),
  )
  assert.equal(panel.find({ type: 'EmptyState' }), null)
  assert.equal(panel.find({ type: 'Table' }), null)
  assert.ok(collapsibleTitled(panel, 'At rest'))
  assertClean(panel)
})

test('a plan of 60 tasks draws without a single panel issue', async () => {
  const tasks: TaskRow[] = Array.from({ length: 60 }, (_, index) => ({
    id: String(index + 1),
    title: `A rather long task title number ${index + 1} that goes on and on`,
    status: index < 20 ? 'done' : 'todo',
  }))
  const live = workspaceView({ workstreams: [workstream({ tasks, tasksDone: 20, tasksTotal: 60 })] })
  const { panel } = await mountWith(snapshot({ live: [live] }))
  assert.equal(panel.find({ type: 'Progress' })?.label, 'Tasks 20 of 60')
  assert.equal(rowsOf(panel, /^Tasks/).length, 60)
  assert.deepEqual(panel.errors, [])
  assert.deepEqual(panel.warnings, [])
  assertClean(panel)
})

test('a refused document open leaves a visible notice instead of failing silently', async () => {
  const plan = '/work/hq/docs/superpowers/plans/p.md'
  const host = mockHost({
    requests: {
      'progress.snapshot': snapshot({ live: [workspaceView({ workstreams: [workstream({ docs: { plan } })] })] }),
      'progress.openFile': () => ({ opened: false }),
    },
  })
  const panel = await mount(panelModule, { host })
  view = panel
  await panel.press({ role: 'button', text: 'Plan' })
  assert.ok(panel.find({ text: 'Could not open this document.' }))
  assertClean(panel)
})

test('the relative times carry the style of the line around them', async () => {
  const agents: AgentRow[] = [
    { terminalId: 't1', agent: 'claude', state: 'blocked', since: NOW - 60_000 },
    { terminalId: 't2', agent: 'claude', state: 'working', since: NOW - 60_000 },
  ]
  const live = workspaceView({ agents, needsYou: true, workstreams: [workstream({ ledgerUpdatedAt: NOW - 20_000 })] })
  const { panel } = await mountWith(snapshot({ live: [live] }))
  const times = panel.findAll({ type: 'RelativeTime' })
  assert.equal(times.length, 3)
  const byFormat = (format: string) => times.filter((element) => element.props.format === format)
  const durations = byFormat('duration')
  assert.equal(durations[0].props.tone, 'warning', 'the waiting agent time takes the warning tone')
  assert.equal(durations[1].props.tone, undefined, 'a working agent time keeps the default tone')
  assert.equal(byFormat('short')[0].props.muted, true, 'the footer time is muted like the footer')
  assertClean(panel)
})

test('a failed first snapshot shows a notice that the next snapshot clears', async () => {
  const host = mockHost({
    requests: {
      'progress.snapshot': () => {
        throw new Error('worker down')
      },
    },
  })
  const panel = await mount(panelModule, { host })
  view = panel
  assert.ok(panel.find({ text: 'Could not read the work in progress.' }))
  await panel.post('progress.changed', snapshot())
  assert.equal(panel.find({ text: 'Could not read the work in progress.' }), null)
  assert.ok(panel.find({ type: 'Badge', text: 'Tasks' }))
  assertClean(panel)
})

test('a failed document open leaves a notice that the next snapshot clears', async () => {
  const plan = '/work/hq/docs/superpowers/plans/p.md'
  const first = snapshot({ live: [workspaceView({ workstreams: [workstream({ docs: { plan } })] })] })
  const host = mockHost({
    requests: {
      'progress.snapshot': first,
      'progress.openFile': () => ({ opened: false }),
    },
  })
  const panel = await mount(panelModule, { host })
  view = panel
  await panel.press({ role: 'button', text: 'Plan' })
  assert.ok(panel.find({ text: 'Could not open this document.' }))
  await panel.post('progress.changed', first)
  assert.equal(panel.find({ text: 'Could not open this document.' }), null)
  assertClean(panel)
})

// Retries du premier instantané : les délais sont injectables, pas de vrais 2 s dans les tests.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitUntil(done: () => boolean, label: string): Promise<void> {
  for (let waited = 0; waited < 1000; waited += 5) {
    if (done()) return
    await sleep(5)
  }
  assert.fail(`timed out waiting for ${label}`)
}
const originalTiming = { ...snapshotRetry }
afterEach(() => Object.assign(snapshotRetry, originalTiming))

test('the retry delay doubles from the first delay and stays at the cap', () => {
  const timing = { firstMs: 2000, maxMs: 10_000 }
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((attempt) => retryDelay(attempt, timing)), [2000, 4000, 8000, 10_000, 10_000, 10_000])
})

test('a first snapshot request that fails is retried until a snapshot arrives, without any progress.changed', async () => {
  Object.assign(snapshotRetry, { firstMs: 5, maxMs: 10 })
  let calls = 0
  const host = mockHost({
    requests: {
      'progress.snapshot': () => {
        calls += 1
        if (calls === 1) throw new Error('awaiting approval')
        return snapshot()
      },
    },
  })
  const panel = await mount(panelModule, { host })
  view = panel
  assert.ok(panel.find({ text: 'Could not read the work in progress.' }))
  await waitUntil(() => calls >= 2, 'the second request')
  await panel.settled()
  assert.equal(panel.find({ text: 'Could not read the work in progress.' }), null, 'the next snapshot clears the notice')
  assert.ok(panel.find({ type: 'Badge', text: 'Tasks' }))
  await sleep(40)
  assert.equal(calls, 2, 'no request is sent once a snapshot is applied')
  assertClean(panel)
})

test('slow snapshot requests are retried without waiting for them, and stop for good once progress.changed lands', async () => {
  Object.assign(snapshotRetry, { firstMs: 5, maxMs: 10 })
  let calls = 0
  const stale = snapshot({ focused: { workspaceId: 'w1', name: 'stale-reply', branch: null } })
  const host = mockHost({
    requests: {
      'progress.snapshot': async () => {
        calls += 1
        // `mount` et `post` attendent les appels en cours : seul le premier échoue vite, les relances répondent tard.
        if (calls === 1) throw new Error('awaiting approval')
        await sleep(150)
        return stale
      },
    },
  })
  const panel = await mount(panelModule, { host })
  view = panel
  await waitUntil(() => calls >= 3, 'a retry sent while the previous one is still unanswered')
  await panel.post('progress.changed', snapshot())
  assert.ok(panel.find({ text: 'EROM-HQ · main' }), 'the pushed snapshot is shown, not the late stale reply')
  assert.equal(panel.find({ text: 'stale-reply' }), null)
  const callsAtSnapshot = calls
  await sleep(60)
  assert.equal(calls, callsAtSnapshot, 'no request is sent after the snapshot was applied')
  assertClean(panel)
})

test('closing the panel stops the snapshot retries', async () => {
  Object.assign(snapshotRetry, { firstMs: 5, maxMs: 10 })
  let calls = 0
  const host = mockHost({
    requests: {
      'progress.snapshot': () => {
        calls += 1
        throw new Error('worker down')
      },
    },
  })
  const panel = await mount(panelModule, { host })
  view = panel
  await waitUntil(() => calls >= 2, 'a retry')
  await panel.unmount()
  const callsAtClose = calls
  await sleep(60)
  assert.equal(calls, callsAtClose, 'no request is sent after the panel is closed')
})

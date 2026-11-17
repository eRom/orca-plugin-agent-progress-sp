// Joue statusBarFor sur des instantanés construits à la main : un par ligne de la table de la spec.
import { assert, test } from 'orca/testing'
import type { Stage, TaskRow, Workstream } from './model/workstream'
import type { Snapshot } from './protocol'
import { statusBarFor } from './status-bar'

function task(id: string, status: TaskRow['status'], fix?: TaskRow['fix']): TaskRow {
  return { id, title: `task ${id}`, status, ...(fix ? { fix } : {}) }
}

function workstream(stage: Stage, tasks: TaskRow[] = [], overrides: Partial<Workstream> = {}): Workstream {
  return {
    key: `p:${stage}`,
    label: 'demo',
    stage,
    hasIntent: false,
    skippedStages: [],
    docs: {},
    tasks,
    tasksDone: tasks.filter((row) => row.status === 'done').length,
    tasksTotal: tasks.length,
    unparsedLines: 0,
    notes: [],
    lastMovedAt: 1000,
    ledgerUpdatedAt: null,
    live: true,
    ...overrides,
  }
}

function snapshotOf(workstreams: Workstream[], options: { needsYou?: boolean; focused?: string | null } = {}): Snapshot {
  const focused = options.focused === undefined ? 'w1' : options.focused
  return {
    focusedWorkspaceId: focused,
    focused: focused === null ? null : { workspaceId: focused, name: 'Portal', branch: 'main' },
    live: [
      {
        workspaceId: 'w1',
        name: 'Portal',
        branch: 'main',
        root: '/r',
        workstreams,
        agents: [],
        needsYou: options.needsYou ?? false,
      },
    ],
    resting: [],
    anySuperpowers: true,
    localRoots: ['/r'],
  }
}

const seven = (statuses: TaskRow[]): TaskRow[] => [
  ...statuses,
  ...Array.from({ length: 7 - statuses.length }, (_, index) => task(String(statuses.length + index + 1), 'todo')),
]

test('shows the stage name for intent, spec, review and done', () => {
  for (const [stage, text] of [['intent', 'Intent'], ['spec', 'Spec'], ['review', 'Review'], ['done', 'Done']] as const) {
    const bar = statusBarFor(snapshotOf([workstream(stage)]))
    assert.deepEqual(bar, { visible: true, text, tone: 'neutral', tooltip: `Portal · demo` })
  }
})

test('shows the task count at the plan stage', () => {
  const bar = statusBarFor(snapshotOf([workstream('plan', seven([]))]))
  assert.equal(bar.visible && bar.text, 'Plan · 7 tasks')
})

test('shows the current task rank at the tasks stage', () => {
  const tasks = seven([task('1', 'done'), task('2', 'done'), task('3', 'done'), task('4', 'in-progress')])
  const bar = statusBarFor(snapshotOf([workstream('tasks', tasks)]))
  assert.equal(bar.visible && bar.text, 'Tasks 4/7')
})

test('adds the fix round when the current task is in correction', () => {
  const tasks = seven([task('1', 'done'), task('2', 'done'), task('3', 'done'), task('4', 'fix', { round: 2, max: 5 })])
  const bar = statusBarFor(snapshotOf([workstream('tasks', tasks)]))
  assert.equal(bar.visible && bar.text, 'Tasks 4/7 · fix 2/5')
})

test('uses the most recently moved live workstream of the focused workspace', () => {
  const older = workstream('spec', [], { label: 'older', lastMovedAt: 100 })
  const newer = workstream('review', [], { label: 'newer', lastMovedAt: 900 })
  const bar = statusBarFor(snapshotOf([older, newer]))
  assert.equal(bar.visible && bar.text, 'Review')
  assert.equal(bar.visible && bar.tooltip, 'Portal · newer')
})

test('turns warning when an agent needs the user', () => {
  const bar = statusBarFor(snapshotOf([workstream('review')], { needsYou: true }))
  assert.equal(bar.visible && bar.tone, 'warning')
})

test('is hidden without a focused workspace', () => {
  assert.deepEqual(statusBarFor(snapshotOf([workstream('review')], { focused: null })), { visible: false })
})

test('is hidden when the focused workspace has no live workstream', () => {
  assert.deepEqual(statusBarFor(snapshotOf([workstream('review')], { focused: 'w9' })), { visible: false })
})

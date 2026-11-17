// Joue l'assemblage de l'instantané : workspaces vivants, au repos, focus, agents. Pur, sans Orca.
import { assert, test } from 'orca/testing'
import type { Workstream } from './model/workstream'
import type { AgentRow } from './protocol'
import { assembleSnapshot, type WorkspaceMeta } from './snapshot'

function meta(workspaceId: string, projectKey = 'p1', name = workspaceId): WorkspaceMeta {
  return { workspaceId, projectKey, name, branch: 'main', root: `/r/${workspaceId}` }
}

function workstream(label: string, lastMovedAt: number, live: boolean): Workstream {
  return {
    key: `p1:${label}`,
    label,
    stage: 'tasks',
    hasIntent: false,
    skippedStages: [],
    docs: {},
    tasks: [],
    tasksDone: 0,
    tasksTotal: 0,
    unparsedLines: 0,
    notes: [],
    lastMovedAt,
    ledgerUpdatedAt: null,
    live,
  }
}

function agent(state: AgentRow['state'], terminalId: string): AgentRow {
  return { terminalId, agent: 'claude', state, since: 1 }
}

test('splits workspaces into live, resting and absent', () => {
  const snapshot = assembleSnapshot({
    focus: null,
    workspaces: [meta('live', 'p1'), meta('old', 'p2'), meta('empty', 'p3')],
    workstreams: { live: [workstream('fresh', 900, true)], old: [workstream('stale', 100, false)], empty: [] },
    agents: {},
  })
  assert.deepEqual(snapshot.live.map((view) => view.workspaceId), ['live'])
  assert.deepEqual(snapshot.resting, [{ workspaceId: 'old', name: 'old', lastDoc: 'stale', lastMovedAt: 100 }])
  assert.equal(snapshot.anySuperpowers, true)
})

test('says no superpowers when no workspace has a workstream', () => {
  const snapshot = assembleSnapshot({ focus: null, workspaces: [meta('a')], workstreams: { a: [] }, agents: {} })
  assert.deepEqual(snapshot, { focusedWorkspaceId: null, focused: null, live: [], resting: [], anySuperpowers: false })
})

test('keeps only live workstreams in a live workspace, most recent first', () => {
  const snapshot = assembleSnapshot({
    focus: null,
    workspaces: [meta('a')],
    workstreams: { a: [workstream('mid', 500, true), workstream('dead', 999, false), workstream('top', 800, true)] },
    agents: {},
  })
  assert.deepEqual(snapshot.live[0].workstreams.map((item) => item.label), ['top', 'mid'])
})

test('hides a resting workspace whose project has live work in another workspace', () => {
  const snapshot = assembleSnapshot({
    focus: null,
    workspaces: [meta('main-checkout', 'p1'), meta('worktree', 'p1'), meta('elsewhere', 'p2')],
    workstreams: {
      'main-checkout': [workstream('plan-old', 100, false)],
      worktree: [workstream('plan-live', 900, true)],
      elsewhere: [workstream('other-old', 100, false)],
    },
    agents: {},
  })
  assert.deepEqual(snapshot.resting.map((view) => view.workspaceId), ['elsewhere'])
})

test('orders live workspaces by most recent movement and resting ones the same way', () => {
  const snapshot = assembleSnapshot({
    focus: null,
    workspaces: [meta('a', 'p1'), meta('b', 'p2'), meta('c', 'p3'), meta('d', 'p4')],
    workstreams: {
      a: [workstream('x', 100, true)],
      b: [workstream('y', 900, true)],
      c: [workstream('old1', 10, false)],
      d: [workstream('old2', 50, false)],
    },
    agents: {},
  })
  assert.deepEqual(snapshot.live.map((view) => view.workspaceId), ['b', 'a'])
  assert.deepEqual(snapshot.resting.map((view) => view.workspaceId), ['d', 'c'])
})

test('lists agents that need the user first and sets needsYou for blocked or waiting', () => {
  const snapshot = assembleSnapshot({
    focus: null,
    workspaces: [meta('a'), meta('b', 'p2')],
    workstreams: { a: [workstream('x', 1, true)], b: [workstream('y', 1, true)] },
    agents: {
      a: [agent('working', 't1'), agent('done', 't2'), agent('waiting', 't3')],
      b: [agent('working', 't4'), agent('done', 't5')],
    },
  })
  const [first, second] = snapshot.live
  const byId = Object.fromEntries([first, second].map((view) => [view.workspaceId, view]))
  assert.equal(byId.a.agents[0].terminalId, 't3')
  assert.equal(byId.a.needsYou, true)
  assert.equal(byId.b.needsYou, false)
})

test('reports the focused workspace even without a live workstream, from the list or the context', () => {
  const listed = assembleSnapshot({
    focus: { workspaceId: 'a', displayName: 'ctx name', branch: 'ctx-branch' },
    workspaces: [meta('a', 'p1', 'Listed name')],
    workstreams: { a: [] },
    agents: {},
  })
  assert.equal(listed.focusedWorkspaceId, 'a')
  assert.deepEqual(listed.focused, { workspaceId: 'a', name: 'Listed name', branch: 'main' })

  const unlisted = assembleSnapshot({
    focus: { workspaceId: 'z', displayName: 'ctx name', branch: 'ctx-branch' },
    workspaces: [meta('a')],
    workstreams: {},
    agents: {},
  })
  assert.deepEqual(unlisted.focused, { workspaceId: 'z', name: 'ctx name', branch: 'ctx-branch' })
})

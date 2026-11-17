// Joue l'assemblage de l'instantané : projets vivants, au repos, focus, agents. Pur, sans Orca.
import { assert, test } from 'orca/testing'
import type { Workstream } from './model/workstream'
import type { AgentRow } from './protocol'
import { assembleSnapshot, type WorkspaceMeta } from './snapshot'

function meta(workspaceId: string, projectKey = 'p1', name = workspaceId, branch: string | null = 'main'): WorkspaceMeta {
  return { workspaceId, projectKey, name, branch, root: `/r/${workspaceId}` }
}

function workstream(label: string, lastMovedAt: number, live: boolean, ledgerUpdatedAt: number | null = null): Workstream {
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
    ledgerUpdatedAt,
    live,
  }
}

function agent(state: AgentRow['state'], terminalId: string): AgentRow {
  return { terminalId, agent: 'claude', state, since: 1 }
}

test('splits projects into live, resting and absent', () => {
  const snapshot = assembleSnapshot({
    focus: null,
    workspaces: [meta('live', 'p1'), meta('old', 'p2'), meta('empty', 'p3')],
    workstreams: { live: [workstream('fresh', 900, true)], old: [workstream('stale', 100, false)], empty: [] },
    agents: {},
  })
  assert.deepEqual(snapshot.live.map((view) => view.projectKey), ['p1'])
  assert.deepEqual(snapshot.resting, [{ workspaceId: 'old', name: 'old', lastDoc: 'stale', lastMovedAt: 100 }])
  assert.equal(snapshot.anySuperpowers, true)
})

test('says no superpowers when no workspace has a workstream', () => {
  const snapshot = assembleSnapshot({ focus: null, workspaces: [meta('a')], workstreams: { a: [] }, agents: {} })
  assert.deepEqual(snapshot, {
    focusedWorkspaceId: null,
    focusedProjectKey: null,
    focused: null,
    live: [],
    resting: [],
    anySuperpowers: false,
    localRoots: ['/r/a'],
  })
})

test('keeps only live workstreams in a live project, most recent first', () => {
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

test('orders live projects by most recent movement and resting ones the same way', () => {
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
  assert.deepEqual(snapshot.live.map((view) => view.projectKey), ['p2', 'p1'])
  assert.deepEqual(snapshot.resting.map((view) => view.workspaceId), ['d', 'c'])
})

test('lists agents that need the user first and sets needsYou for blocked or waiting', () => {
  const snapshot = assembleSnapshot({
    focus: null,
    workspaces: [meta('a', 'p1'), meta('b', 'p2')],
    workstreams: { a: [workstream('x', 1, true)], b: [workstream('y', 1, true)] },
    agents: {
      a: [agent('working', 't1'), agent('done', 't2'), agent('waiting', 't3')],
      b: [agent('working', 't4'), agent('done', 't5')],
    },
  })
  const byKey = Object.fromEntries(snapshot.live.map((view) => [view.projectKey, view]))
  assert.equal(byKey.p1.agents[0].terminalId, 't3')
  assert.equal(byKey.p1.needsYou, true)
  assert.equal(byKey.p2.needsYou, false)
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

test('lists the root of every given workspace as a local root, without duplicates', () => {
  const snapshot = assembleSnapshot({
    focus: null,
    workspaces: [meta('a'), meta('b'), { ...meta('c'), root: '/r/a' }],
    workstreams: {},
    agents: {},
  })
  assert.deepEqual(snapshot.localRoots, ['/r/a', '/r/b'])
})

test('gathers the live workstreams of every workspace of a project into one view, each tagged with its workspace', () => {
  const snapshot = assembleSnapshot({
    focus: null,
    workspaces: [meta('main', 'p1', 'main-name', 'main'), meta('wt', 'p1', 'wt-name', 'worktree-login'), meta('other', 'p2', 'other-name', 'main')],
    workstreams: {
      main: [workstream('export-pdf', 500, true)],
      wt: [workstream('login-oauth', 800, true)],
      other: [workstream('docs', 100, true)],
    },
    agents: {},
  })
  assert.equal(snapshot.live.length, 2)
  const view = snapshot.live.find((candidate) => candidate.projectKey === 'p1')
  assert.equal(view?.name, 'main-name')
  const tagged = view?.workstreams.map((item) => ({ label: item.label, workspaceId: item.workspaceId, branch: item.branch }))
  assert.equal(tagged?.length, 2)
  assert.ok(tagged?.some((item) => item.label === 'login-oauth' && item.workspaceId === 'wt' && item.branch === 'worktree-login'))
  assert.ok(tagged?.some((item) => item.label === 'export-pdf' && item.workspaceId === 'main' && item.branch === 'main'))
})

test('puts a workstream with an open ledger first, the most recently written ledger first', () => {
  const snapshot = assembleSnapshot({
    focus: null,
    workspaces: [meta('a')],
    workstreams: {
      a: [workstream('spec', 2000, true), workstream('a', 500, true, 500), workstream('b', 800, true, 800), workstream('old', 100, true)],
    },
    agents: {},
  })
  assert.deepEqual(snapshot.live[0].workstreams.map((item) => item.label), ['b', 'a', 'spec', 'old'])
})

test('lists the agents of every workspace of the project once, tagged with their workspace, waiting first', () => {
  const snapshot = assembleSnapshot({
    focus: null,
    workspaces: [meta('main', 'p1', 'repo', 'main'), meta('wt', 'p1', 'wt-name', 'worktree-login'), meta('third', 'p1', 'third', 'third')],
    workstreams: { wt: [workstream('login-oauth', 800, true, 800)] },
    agents: {
      main: [agent('working', 't1'), agent('waiting', 't2')],
      wt: [agent('working', 't3')],
      third: [],
    },
  })
  const view = snapshot.live[0]
  assert.deepEqual(view.agents.map((item) => item.terminalId), ['t2', 't1', 't3'])
  const t2 = view.agents[0]
  assert.equal(t2.workspaceId, 'main')
  assert.equal(t2.location, 'main', 'the branch, not the workspace name')
  assert.equal(view.agents[2].location, 'worktree-login')
  assert.equal(view.needsYou, true)
})

test('keeps one workstream per key in a project, the one with a ledger first', () => {
  const specKey = 'p1:docs/superpowers/specs/s.md'
  const planKey = 'p1:docs/superpowers/plans/p.md'
  const snapshot = assembleSnapshot({
    focus: null,
    workspaces: [meta('main', 'p1', 'repo', 'main'), meta('wt', 'p1', 'repo-wt', 'worktree-login')],
    workstreams: {
      main: [
        { ...workstream('spec', 900, true), key: specKey },
        { ...workstream('plan', 900, true), key: planKey },
      ],
      wt: [
        { ...workstream('spec', 500, true), key: specKey },
        { ...workstream('plan', 400, true, 400), key: planKey },
      ],
    },
    agents: {},
  })
  const view = snapshot.live[0]
  assert.equal(view.workstreams.length, 2)
  assert.equal(view.workstreams.find((item) => item.key === planKey)?.workspaceId, 'wt', 'the ledger wins')
  assert.equal(view.workstreams.find((item) => item.key === specKey)?.workspaceId, 'main', 'the largest lastMovedAt wins')

  const tie = assembleSnapshot({
    focus: null,
    workspaces: [meta('first', 'p1'), meta('second', 'p1')],
    workstreams: {
      first: [{ ...workstream('spec', 700, true), key: specKey }],
      second: [{ ...workstream('spec', 700, true), key: specKey }],
    },
    agents: {},
  })
  assert.equal(tie.live[0].workstreams.length, 1)
  assert.equal(tie.live[0].workstreams[0].workspaceId, 'first', 'the first workspace in input order wins a full tie')
})

test('an agent of a workspace without a branch is located by the workspace name', () => {
  const snapshot = assembleSnapshot({
    focus: null,
    workspaces: [meta('f1', 'p1', 'scratch-folder', null)],
    workstreams: { f1: [workstream('x', 1, true)] },
    agents: { f1: [agent('working', 't1')] },
  })
  assert.equal(snapshot.live[0].agents[0].location, 'scratch-folder')
})

test('gives the project of the focused workspace, even when that workspace has no live work of its own', () => {
  const listed = assembleSnapshot({
    focus: { workspaceId: 'main', displayName: 'ctx', branch: 'main' },
    workspaces: [meta('main', 'p1'), meta('wt', 'p1')],
    workstreams: { wt: [workstream('login-oauth', 800, true)] },
    agents: {},
  })
  assert.equal(listed.focusedProjectKey, 'p1')

  const unlisted = assembleSnapshot({
    focus: { workspaceId: 'z', displayName: 'ctx name', branch: 'ctx-branch' },
    workspaces: [meta('a')],
    workstreams: {},
    agents: {},
  })
  assert.equal(unlisted.focusedProjectKey, null)
  assert.deepEqual(unlisted.focused, { workspaceId: 'z', name: 'ctx name', branch: 'ctx-branch' })
})

// Joue le worker comme Orca le ferait : mockHost, dossiers temporaires peuplés à la main, tours déclenchés par le test.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, assert, mockHost, mountWorker, test } from 'orca/testing'
import type { AgentRow, Snapshot } from './protocol'
import { createScanner, nodeScanFs, type ScanFs } from './scan'
import * as main from './worker'
import { createProgressWorker, type ProgressWorker } from './worker'

const MEMORY_KEY = 'ledgerMemory'

/** Dossiers temporaires de chaque test, supprimés après lui. */
const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-progress-sp-worker-'))
  roots.push(root)
  return root
}

async function put(root: string, relativePath: string, text: string): Promise<string> {
  const path = join(root, relativePath)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, text, 'utf8')
  return path
}

const PLAN_REL = 'docs/superpowers/plans/p.md'
const LEDGER_REL = '.superpowers/sdd/demo/progress.md'
const PLAN_TEXT = '# Demo plan\n\n### Task 1: first\n\n### Task 2: second\n\n### Task 3: third\n'

/** Un workspace avec un plan de 3 tâches et un ledger dont la tâche 1 est faite. */
async function seedWorkspace(root: string, planPointer = PLAN_REL): Promise<void> {
  await put(root, PLAN_REL, PLAN_TEXT)
  await put(root, LEDGER_REL, `# SDD ledger — plan: ${planPointer}\nTask 1: complete (review clean)\n`)
}

type ListRow = {
  id: string
  kind: 'worktree' | 'folder'
  name: string
  project: string | null
  projectId: string | null
  path: string
  branch: string | null
  hostId: string | null
}

function row(id: string, path: string, overrides: Partial<ListRow> = {}): ListRow {
  return { id, kind: 'worktree', name: `Name ${id}`, project: 'P', projectId: 'p1', path, branch: 'main', hostId: 'local', ...overrides }
}

type AgentListItem = { terminalId: string | null; title: string | null; agent: string | null; state: AgentRow['state']; stateStartedAt: number }

type Fixture = {
  rows: ListRow[]
  context: { workspaceId?: string; branch: string; displayName: string; terminals: [] } | null
  agents: Record<string, AgentListItem[]>
}

function context(workspaceId: string, displayName = `Name ${workspaceId}`): NonNullable<Fixture['context']> {
  return { workspaceId, branch: 'main', displayName, terminals: [] }
}

/** Un hôte dont chaque réponse lit l'état du test au moment de l'appel. */
function makeHost(fixture: Fixture, storage?: Record<string, never>, overrides: Record<string, unknown> = {}) {
  return mockHost({
    storage,
    results: {
      'workspace.list': () => ({ workspaces: fixture.rows, truncated: false }),
      'workspace.readContext': () => fixture.context,
      'agents.list': (params: { workspaceId?: string }) => ({ agents: fixture.agents[params.workspaceId ?? ''] ?? [] }),
      'statusBar.update': { ok: true },
      'editor.open': { opened: true },
      'workspace.open': { opened: true },
      'terminal.focus': { focused: true },
      'commands.run': { ran: true },
      ...overrides,
    },
  })
}

type Mounted = { host: ReturnType<typeof mockHost>; test: Awaited<ReturnType<typeof mountWorker>>; progress: ProgressWorker }

/** Monte createProgressWorker avec un `schedule` qui n'arme rien : le test appelle tick() lui-même. */
async function mountProgress(host: ReturnType<typeof mockHost>, deps: Parameters<typeof createProgressWorker>[1] = {}): Promise<Mounted> {
  let progress: ProgressWorker | undefined
  const mounted = await mountWorker(
    {
      default: (orca) => {
        progress = createProgressWorker(orca, { schedule: () => () => {}, ...deps })
      },
      deactivate: () => progress?.stop(),
    },
    { host },
  )
  if (!progress) throw new Error('activate did not run')
  return { host, test: mounted, progress }
}

const lastOf = <T>(items: readonly T[]): T => items[items.length - 1]
const snapshotOf = (mounted: Mounted) => mounted.test.request('progress.snapshot')
const memoryWrites = (host: ReturnType<typeof mockHost>) =>
  host.callsOf('storage.set').filter((call) => JSON.stringify(call).includes(MEMORY_KEY))
const statusUpdates = (host: ReturnType<typeof mockHost>) =>
  host.callsOf('statusBar.update') as unknown as ({ params: Record<string, unknown> } | Record<string, unknown>)[]
const paramsOf = (call: unknown): Record<string, unknown> => {
  const value = call as { params?: Record<string, unknown> }
  return value.params ?? (call as Record<string, unknown>)
}

test('scans a local workspace and never touches the disk for an ssh row', async () => {
  const root = await tempRoot()
  await seedWorkspace(root)
  const scanned: string[] = []
  const inner = createScanner()
  const scanner = {
    ...inner,
    scanWorkspace: (path: string) => {
      scanned.push(path)
      return inner.scanWorkspace(path)
    },
  }
  const fixture: Fixture = {
    rows: [row('w1', root), row('remote', '/definitely/not/here', { hostId: 'ssh:box', projectId: 'p2' }), row('blank', '', { projectId: 'p3' })],
    context: context('w1'),
    agents: {},
  }
  const mounted = await mountProgress(makeHost(fixture), { scanner })
  await mounted.progress.tick()

  const snapshot = await snapshotOf(mounted)
  assert.deepEqual(snapshot.live.map((view) => view.workspaceId), ['w1'])
  assert.deepEqual(scanned, [root])
  assert.equal(snapshot.live[0].workstreams[0].stage, 'tasks')
  assert.deepEqual(mounted.test.refusals, [])
  await mounted.test.deactivate()
})

test('shows the stage in the status bar for the focused workspace', async () => {
  const root = await tempRoot()
  await seedWorkspace(root)
  const fixture: Fixture = { rows: [row('w1', root)], context: context('w1'), agents: {} }
  const mounted = await mountProgress(makeHost(fixture))
  await mounted.progress.tick()

  const update = paramsOf(lastOf(statusUpdates(mounted.host)))
  assert.deepEqual(update, { id: 'progress', visible: true, text: 'Tasks 2/3', tone: 'neutral', tooltip: 'P · p' })
  assert.deepEqual(mounted.test.refusals, [])
  await mounted.test.deactivate()
})

test('has no focused workspace and a hidden status bar when readContext answers null', async () => {
  const root = await tempRoot()
  await seedWorkspace(root)
  const fixture: Fixture = { rows: [row('w1', root)], context: null, agents: {} }
  const mounted = await mountProgress(makeHost(fixture))
  await mounted.progress.tick()

  const snapshot = await snapshotOf(mounted)
  assert.equal(snapshot.focusedWorkspaceId, null)
  assert.equal(snapshot.focused, null)
  assert.equal(snapshot.live.length, 1)
  assert.deepEqual(paramsOf(lastOf(statusUpdates(mounted.host))), { id: 'progress', visible: false })
  assert.deepEqual(mounted.test.refusals, [])
  await mounted.test.deactivate()
})

test('writes the ledger memory once when nothing changes on disk', async () => {
  const root = await tempRoot()
  await seedWorkspace(root)
  const fixture: Fixture = { rows: [row('w1', root)], context: context('w1'), agents: {} }
  const mounted = await mountProgress(makeHost(fixture))
  await mounted.progress.tick()
  await mounted.progress.tick()

  assert.equal(memoryWrites(mounted.host).length, 1)
  assert.deepEqual(mounted.test.refusals, [])
  await mounted.test.deactivate()
})

test('survives a missing workspace.list and answers an empty snapshot', async () => {
  const host = mockHost({ results: { 'workspace.readContext': null, 'statusBar.update': { ok: true } } })
  const mounted = await mountProgress(host)
  await mounted.progress.tick()

  const snapshot = await snapshotOf(mounted)
  assert.deepEqual(snapshot, { focusedWorkspaceId: null, focused: null, live: [], resting: [], anySuperpowers: false, localRoots: [] })
  assert.ok(mounted.test.logs.length > 0, 'the failure is logged')
  await mounted.test.deactivate()
})

test('a deleted ledger becomes Done and the memory survives a worker restart', async () => {
  const root = await tempRoot()
  await seedWorkspace(root)
  const fixture: Fixture = { rows: [row('w1', root)], context: context('w1'), agents: {} }
  const host = makeHost(fixture)
  const first = await mountProgress(host)
  await first.progress.tick()
  assert.equal((await snapshotOf(first)).live[0].workstreams[0].stage, 'tasks')

  await rm(join(root, '.superpowers'), { recursive: true, force: true })
  await first.progress.tick()
  assert.equal((await snapshotOf(first)).live[0].workstreams[0].stage, 'done')
  const stored = host.data().storage[MEMORY_KEY] as Record<string, { goneAt?: number }>
  assert.ok(Object.values(stored).some((entry) => typeof entry.goneAt === 'number'))
  await first.test.deactivate()

  const second = await mountProgress(host)
  await second.progress.tick()
  assert.equal((await snapshotOf(second)).live[0].workstreams[0].stage, 'done')
  assert.deepEqual(second.test.refusals, [])
  await second.test.deactivate()
})

test('keeps the previous result and the memory of a project whose scan throws', async () => {
  const root = await tempRoot()
  await seedWorkspace(root)
  let broken = false
  const fs: ScanFs = {
    ...nodeScanFs,
    readdir: async (path) => {
      if (broken && path.endsWith('/docs/superpowers/plans')) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      return nodeScanFs.readdir(path)
    },
  }
  const fixture: Fixture = { rows: [row('w1', root)], context: context('w1'), agents: {} }
  const host = makeHost(fixture)
  const mounted = await mountProgress(host, { scanner: createScanner(fs) })
  await mounted.progress.tick()
  broken = true
  await mounted.progress.tick()

  const workstream = (await snapshotOf(mounted)).live[0].workstreams[0]
  assert.equal(workstream.stage, 'tasks')
  const stored = host.data().storage[MEMORY_KEY] as Record<string, { goneAt?: number }>
  assert.ok(Object.values(stored).every((entry) => entry.goneAt === undefined))
  assert.ok(mounted.test.logs.some((line) => line.includes('permission denied')))
  await mounted.test.deactivate()
})

test('follows the focus from workspace.changed without waiting for a tick', async () => {
  const root1 = await tempRoot()
  const root2 = await tempRoot()
  await seedWorkspace(root1)
  await seedWorkspace(root2)
  const fixture: Fixture = {
    rows: [row('w1', root1), row('w2', root2, { projectId: 'p2' })],
    context: context('w1'),
    agents: {},
  }
  const mounted = await mountProgress(makeHost(fixture))
  await mounted.progress.tick()
  const before = mounted.test.posts.length

  await mounted.test.emit('workspace.changed', { context: context('w2') })

  assert.equal(mounted.test.posts.length, before + 1)
  const post = lastOf(mounted.test.posts)
  assert.equal(post.event, 'progress.changed')
  assert.equal((post.payload as Snapshot).focusedWorkspaceId, 'w2')
  assert.equal(paramsOf(lastOf(statusUpdates(mounted.host))).tooltip, 'P · p')
  assert.deepEqual(mounted.test.refusals, [])
  await mounted.test.deactivate()
})

test('relists agents once per real state change and flags waiting agents', async () => {
  const root = await tempRoot()
  await seedWorkspace(root)
  const fixture: Fixture = { rows: [row('w1', root)], context: context('w1'), agents: { w1: [] } }
  const mounted = await mountProgress(makeHost(fixture))
  await mounted.progress.tick()
  const afterTick = mounted.host.callsOf('agents.list').length
  assert.equal((await snapshotOf(mounted)).live[0].needsYou, false)

  fixture.agents.w1 = [{ terminalId: 't1', title: null, agent: 'claude', state: 'waiting', stateStartedAt: 5 }]
  const event = { workspaceId: 'native-id', workspaceListId: 'w1', paneKey: 'pane-1', terminalId: 't1', state: 'waiting' as const, receivedAt: 1 }
  await mounted.test.emit('agent.status.changed', event)
  await mounted.test.emit('agent.status.changed', event)

  assert.equal(mounted.host.callsOf('agents.list').length, afterTick + 1)
  const view = (await snapshotOf(mounted)).live[0]
  assert.equal(view.needsYou, true)
  assert.deepEqual(view.agents, [{ terminalId: 't1', agent: 'claude', state: 'waiting', since: 5 }])
  assert.equal(paramsOf(lastOf(statusUpdates(mounted.host))).tone, 'warning')
  assert.deepEqual(mounted.test.refusals, [])
  await mounted.test.deactivate()
})

test('keeps the same workstream key from tick to tick when the plan is external', async () => {
  const root = await tempRoot()
  const other = await tempRoot()
  const externalPlan = await put(other, PLAN_REL, PLAN_TEXT)
  await put(root, LEDGER_REL, `# SDD ledger — plan: ${externalPlan}\nTask 1: complete (review clean)\n`)
  const fixture: Fixture = { rows: [row('w1', root)], context: context('w1'), agents: {} }
  const mounted = await mountProgress(makeHost(fixture))

  await mounted.progress.tick()
  const first = (await snapshotOf(mounted)).live[0].workstreams[0]
  await mounted.progress.tick()
  const second = (await snapshotOf(mounted)).live[0].workstreams[0]

  assert.equal(first.tasksTotal, 3)
  assert.equal(second.key, first.key)
  assert.equal(second.tasksTotal, 3)
  assert.deepEqual(mounted.test.refusals, [])
  await mounted.test.deactivate()
})

test('opens a workspace file with a path relative to the workspace and refuses paths outside it', async () => {
  const root = await tempRoot()
  await seedWorkspace(root)
  const fixture: Fixture = { rows: [row('w1', root)], context: context('w1'), agents: {} }
  const mounted = await mountProgress(makeHost(fixture))
  await mounted.progress.tick()

  const opened = await mounted.test.request('progress.openFile', { workspaceId: 'w1', path: join(root, PLAN_REL) })
  assert.deepEqual(opened, { opened: true })
  assert.deepEqual(mounted.host.callsOf('editor.open').map(paramsOf), [{ workspaceId: 'w1', path: PLAN_REL }])

  for (const path of ['/etc/hosts', `${root}-sibling/x.md`, '../escape.md', `${root}/../escape.md`]) {
    assert.deepEqual(await mounted.test.request('progress.openFile', { workspaceId: 'w1', path }), { opened: false })
  }
  assert.deepEqual(await mounted.test.request('progress.openFile', { workspaceId: 'unknown', path: PLAN_REL }), { opened: false })
  assert.equal(mounted.host.callsOf('editor.open').length, 1)
  assert.deepEqual(mounted.test.refusals, [])
  await mounted.test.deactivate()
})

test('focuses a terminal, opens a workspace and toggles the sidebar', async () => {
  const root = await tempRoot()
  await seedWorkspace(root)
  const fixture: Fixture = { rows: [row('w1', root)], context: context('w1'), agents: {} }
  const mounted = await mountProgress(makeHost(fixture))

  assert.deepEqual(await mounted.test.request('progress.focusTerminal', { terminalId: 't1' }), { focused: true })
  assert.deepEqual(mounted.host.callsOf('terminal.focus').map(paramsOf), [{ terminalId: 't1' }])
  assert.deepEqual(await mounted.test.request('progress.openWorkspace', { workspaceId: 'w1' }), { opened: true })
  assert.deepEqual(mounted.host.callsOf('workspace.open').map(paramsOf), [{ workspaceId: 'w1' }])

  await mounted.test.command('progress.toggle')
  assert.deepEqual(mounted.host.callsOf('commands.run').map(paramsOf), [{ action: 'sidebar.right.toggle' }])
  assert.deepEqual(mounted.test.refusals, [])
  await mounted.test.deactivate()
})

test('the default export runs the first tick on demand and stops on deactivate', async () => {
  const root = await tempRoot()
  await seedWorkspace(root)
  const fixture: Fixture = { rows: [row('w1', root)], context: context('w1'), agents: {} }
  const host = makeHost(fixture)
  const worker = await mountWorker(main, { host })

  const snapshot = await worker.request('progress.snapshot')
  assert.equal(snapshot.live.length, 1)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

// ---------------------------------------------------------------------------------------------
// Fix round 1
// ---------------------------------------------------------------------------------------------

test('drops a stale waiting agent when workspace.changed reports a closed terminal', async () => {
  const root = await tempRoot()
  await seedWorkspace(root)
  const fixture: Fixture = {
    rows: [row('w1', root)],
    context: context('w1'),
    agents: { w1: [{ terminalId: 't1', title: null, agent: 'claude', state: 'waiting', stateStartedAt: 5 }] },
  }
  const mounted = await mountProgress(makeHost(fixture))
  await mounted.progress.tick()
  assert.equal((await snapshotOf(mounted)).live[0].needsYou, true)
  assert.equal(paramsOf(lastOf(statusUpdates(mounted.host))).tone, 'warning')

  fixture.agents.w1 = []
  await mounted.test.emit('workspace.changed', { context: context('w1') })

  assert.equal((await snapshotOf(mounted)).live[0].needsYou, false)
  assert.equal(paramsOf(lastOf(statusUpdates(mounted.host))).tone, 'neutral')
  assert.deepEqual(mounted.test.refusals, [])
  await mounted.test.deactivate()
})

test('relists every tracked workspace every ninth tick', async () => {
  const root = await tempRoot()
  await seedWorkspace(root)
  const fixture: Fixture = {
    rows: [row('w1', root)],
    context: context('w1'),
    agents: { w1: [{ terminalId: 't1', title: null, agent: 'claude', state: 'waiting', stateStartedAt: 5 }] },
  }
  const mounted = await mountProgress(makeHost(fixture))
  await mounted.progress.tick()
  fixture.agents.w1 = []
  for (let index = 1; index < 9; index++) await mounted.progress.tick()
  assert.equal((await snapshotOf(mounted)).live[0].needsYou, true, 'ticks 1 to 8 do not relist a tracked workspace')

  await mounted.progress.tick()
  assert.equal((await snapshotOf(mounted)).live[0].needsYou, false)
  await mounted.test.deactivate()
})

test('opens a doc of another workspace of the same project with that workspace id', async () => {
  const root1 = await tempRoot()
  const root2 = await tempRoot()
  await seedWorkspace(root1)
  const fixture: Fixture = { rows: [row('w1', root1), row('w2', root2)], context: context('w2'), agents: {} }
  const mounted = await mountProgress(makeHost(fixture))
  await mounted.progress.tick()

  const opened = await mounted.test.request('progress.openFile', { workspaceId: 'w2', path: join(root1, PLAN_REL) })
  assert.deepEqual(opened, { opened: true })
  assert.deepEqual(mounted.host.callsOf('editor.open').map(paramsOf), [{ workspaceId: 'w1', path: PLAN_REL }])
  await mounted.test.deactivate()
})

test('prefers the requested workspace when several roots contain the path', async () => {
  const outer = await tempRoot()
  const inner = join(outer, 'nested')
  await mkdir(inner, { recursive: true })
  const fixture: Fixture = { rows: [row('outer', outer), row('inner', inner)], context: null, agents: {} }
  const mounted = await mountProgress(makeHost(fixture))
  await mounted.progress.tick()

  await mounted.test.request('progress.openFile', { workspaceId: 'outer', path: join(inner, 'a.md') })
  assert.deepEqual(mounted.host.callsOf('editor.open').map(paramsOf), [{ workspaceId: 'outer', path: 'nested/a.md' }])
  await mounted.test.deactivate()
})

test('refuses a path under no local root, even for a listed ssh workspace', async () => {
  const root = await tempRoot()
  const fixture: Fixture = {
    rows: [row('w1', root), row('remote', '/remote/box', { hostId: 'ssh:box', projectId: 'p2' })],
    context: null,
    agents: {},
  }
  const mounted = await mountProgress(makeHost(fixture))
  await mounted.progress.tick()

  assert.deepEqual(await mounted.test.request('progress.openFile', { workspaceId: 'remote', path: '/remote/box/docs/x.md' }), { opened: false })
  assert.equal(mounted.host.callsOf('editor.open').length, 0)
  assert.deepEqual((await snapshotOf(mounted)).localRoots, [root])
  await mounted.test.deactivate()
})

test('does not post a snapshot from an event before the first tick has completed', async () => {
  const root = await tempRoot()
  await seedWorkspace(root)
  const fixture: Fixture = { rows: [row('w1', root)], context: context('w1'), agents: {} }
  let postsWhileListing = -1
  let mounted: Mounted | undefined
  const host = makeHost(fixture, undefined, {
    // Le tour est encore en cours quand cette réponse arrive : l'événement a déjà été traité.
    'workspace.list': async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      postsWhileListing = mounted?.test.posts.length ?? -1
      return { workspaces: fixture.rows, truncated: false }
    },
  })
  mounted = await mountProgress(host)
  const firstTick = mounted.progress.tick()
  await mounted.test.emit('workspace.changed', { context: context('w1') })
  await firstTick

  assert.equal(postsWhileListing, 0, 'no empty snapshot is posted while the first tick runs')
  const posts = mounted.test.posts.map((post) => post.payload as Snapshot)
  assert.ok(posts.length > 0)
  assert.ok(posts.every((post) => post.live.length === 1), 'the first post already carries the workstream')
  await mounted.test.deactivate()
})

test('never writes the memory until a read of it has succeeded, then keeps the stored entries', async () => {
  const root = await tempRoot()
  await seedWorkspace(root)
  const fixture: Fixture = { rows: [row('w1', root)], context: context('w1'), agents: {} }
  const stored = { 'p1:docs/superpowers/plans/gone.md': { projectKey: 'p1', total: 3, done: 3, lastSeenAt: 1, goneAt: Date.now() } }
  let reads = 0
  const host = makeHost(fixture, undefined, {
    'storage.get': () => {
      reads++
      if (reads === 1) throw new Error('storage unavailable')
      return { value: stored }
    },
  })
  const mounted = await mountProgress(host)

  await mounted.progress.tick()
  assert.equal(memoryWrites(host).length, 0, 'a failed read must not be followed by a write')

  await mounted.progress.tick()
  assert.equal(memoryWrites(host).length, 1)
  const written = JSON.stringify(memoryWrites(host)[0])
  assert.ok(written.includes('gone.md') && written.includes('goneAt'), 'the stored goneAt entry is preserved')
  await mounted.test.deactivate()
})

test('reads a relative plan pointer that lives outside docs/superpowers and shows its real task count', async () => {
  const root = await tempRoot()
  const plan = `# Plan\n\n${Array.from({ length: 7 }, (_, index) => `### Task ${index + 1}: step ${index + 1}\n`).join('\n')}`
  await put(root, 'docs/plans/x.md', plan)
  await put(root, LEDGER_REL, '# SDD ledger — plan: docs/plans/x.md\nTask 1: complete (review clean)\n')
  const fixture: Fixture = { rows: [row('w1', root)], context: context('w1'), agents: {} }
  const mounted = await mountProgress(makeHost(fixture))
  await mounted.progress.tick()

  const workstream = (await snapshotOf(mounted)).live[0].workstreams[0]
  assert.equal(workstream.tasksTotal, 7)
  assert.equal(workstream.stage, 'tasks')
  assert.deepEqual(workstream.notes, [])
  await mounted.test.deactivate()
})

test('an unreadable linked file does not freeze the project: the rest is still scanned', async () => {
  const root = await tempRoot()
  await seedWorkspace(root, '/definitely/not/here/docs/superpowers/plans/other.md')
  const denied = '/definitely/not/here/docs/superpowers/plans/other.md'
  const fs: ScanFs = {
    ...nodeScanFs,
    stat: async (path) => {
      if (path === denied) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      return nodeScanFs.stat(path)
    },
  }
  const fixture: Fixture = { rows: [row('w1', root)], context: context('w1'), agents: {} }
  const mounted = await mountProgress(makeHost(fixture), { scanner: createScanner(fs) })
  await mounted.progress.tick()

  const workstream = (await snapshotOf(mounted)).live[0].workstreams[0]
  assert.equal(workstream.stage, 'tasks')
  assert.ok(mounted.test.logs.every((line) => !line.includes('scan failed')))
  await mounted.test.deactivate()
})

test('a worktree dropping out of workspace.list does not turn its ledger into a Done in the main checkout', async () => {
  const main = await tempRoot()
  const worktree = await tempRoot()
  await put(main, PLAN_REL, PLAN_TEXT)
  await put(worktree, PLAN_REL, PLAN_TEXT)
  await put(worktree, LEDGER_REL, `# SDD ledger — plan: ${PLAN_REL}\nTask 1: complete (review clean)\n`)
  const fixture: Fixture = { rows: [row('w1', main), row('w2', worktree)], context: context('w1'), agents: {} }
  const host = makeHost(fixture)
  const mounted = await mountProgress(host)
  await mounted.progress.tick()
  assert.equal((await snapshotOf(mounted)).live.find((view) => view.workspaceId === 'w2')?.workstreams[0].stage, 'tasks')

  // Le worktree sort de la liste (relue au prochain tour grâce à listDue) : son ledger n'est pas « disparu ».
  fixture.rows = [row('w1', main)]
  await mounted.test.emit('workspace.changed', { context: context('w1') })
  await mounted.progress.tick()
  const view = (await snapshotOf(mounted)).live.find((candidate) => candidate.workspaceId === 'w1')
  assert.notEqual(view?.workstreams[0]?.stage, 'done')
  const stored = host.data().storage[MEMORY_KEY] as Record<string, { goneAt?: number }>
  assert.ok(Object.values(stored).every((entry) => entry.goneAt === undefined))
  await mounted.test.deactivate()
})

test('labels a main checkout with its project name in the snapshot', async () => {
  const root = await tempRoot()
  await seedWorkspace(root)
  const fixture: Fixture = { rows: [row('w1', root, { name: 'main', project: 'acme-api', branch: 'main' })], context: context('w1'), agents: {} }
  const mounted = await mountProgress(makeHost(fixture))
  await mounted.progress.tick()

  const snapshot = await snapshotOf(mounted)
  assert.equal(snapshot.live[0].name, 'acme-api')
  assert.equal(snapshot.live[0].branch, 'main')
  assert.equal(snapshot.focused?.name, 'acme-api')
  await mounted.test.deactivate()
})

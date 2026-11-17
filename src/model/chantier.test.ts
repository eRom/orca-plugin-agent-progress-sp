// Joue l'assemblage des chantiers : étapes, fraîcheur, identité entre workspaces, mémoire des ledgers.
// Les documents sont construits en mémoire ; aucun accès disque.
import { assert, test } from 'orca/testing'
import {
  buildProject,
  externalPointers,
  LIVE_WINDOW_MS,
  sameMemory,
  type Chantier,
  type DocFile,
  type LedgerMemory,
  type WorkspaceFiles,
  type WorkspaceInput,
} from './chantier'

const now = new Date(2026, 10, 17, 12, 0).getTime()
const HOUR = 3_600_000

const PLAN_DIR = 'docs/superpowers/plans'
const SPEC_DIR = 'docs/superpowers/specs'
const INTENT_DIR = 'docs/superpowers/intents'

// Plan de 3 tâches, avec ou sans en-tête `**Spec:**`.
function planText(specPointer?: string): string {
  const header = specPointer ? `**Spec:** \`${specPointer}\`\n\n` : ''
  return `# Demo plan\n\n${header}### Task 1: first step\n\n### Task 2: second step\n\n### Task 3: third step\n`
}

function ledgerText(planPath: string, lines: string[]): string {
  return [`# SDD ledger — plan: ${planPath}`, ...lines, ''].join('\n')
}

function doc(path: string, text: string, mtimeMs = now - 400 * 24 * HOUR): DocFile {
  return { path, text, mtimeMs }
}

function files(partial: Partial<WorkspaceFiles> = {}): WorkspaceFiles {
  return { intents: [], specs: [], plans: [], ledgers: [], ...partial }
}

function workspace(workspaceId: string, root: string, partial: Partial<WorkspaceFiles> = {}, projectKey = 'p1'): WorkspaceInput {
  return { workspaceId, projectKey, root, files: files(partial) }
}

function build(workspaces: WorkspaceInput[], memory: LedgerMemory = {}, external: Record<string, DocFile> = {}) {
  return buildProject({ workspaces, external, memory, now })
}

function only(chantiers: Chantier[]): Chantier {
  assert.equal(chantiers.length, 1, `expected one chantier, got ${chantiers.map((c) => c.key).join(', ')}`)
  return chantiers[0]
}

const SPEC_PATH = `${SPEC_DIR}/2026-11-10-demo-design.md`
const PLAN_REL = `${PLAN_DIR}/2026-11-10-demo.md`
const LEDGER_REL = '.superpowers/sdd/2026-11-10-demo/progress.md'

test('an intent alone is a chantier at the intent stage', () => {
  const intent = doc(`/r/${INTENT_DIR}/2026-11-17-demo-intent.md`, '# Intent\n')
  const result = build([workspace('w1', '/r', { intents: [intent] })])
  const chantier = only(result.byWorkspace.w1)
  assert.equal(chantier.stage, 'intent')
  assert.equal(chantier.hasIntent, true)
  assert.equal(chantier.docs.intent, intent.path)
  assert.equal(chantier.label, 'demo-intent')
  assert.deepEqual(chantier.skippedStages, [])
})

test('a spec pointing to an intent is at the spec stage and owns the intent', () => {
  const intent = doc(`/r/${INTENT_DIR}/2026-11-09-demo-intent.md`, '# Intent\n')
  const spec = doc(`/r/${SPEC_PATH}`, `Intent record : \`${INTENT_DIR}/2026-11-09-demo-intent.md\`\n\n# Demo design\n`)
  const result = build([workspace('w1', '/r', { intents: [intent], specs: [spec] })])
  const chantier = only(result.byWorkspace.w1)
  assert.equal(chantier.stage, 'spec')
  assert.equal(chantier.hasIntent, true)
  assert.equal(chantier.docs.intent, intent.path)
  assert.equal(chantier.docs.spec, spec.path)
  assert.equal(chantier.key, `p1:${SPEC_PATH}`)
})

test('an upstream spec without intent pointer has no intent', () => {
  const spec = doc(`/r/${SPEC_PATH}`, '# Demo design\n\nNo pointer here.\n')
  const chantier = only(build([workspace('w1', '/r', { specs: [spec] })]).byWorkspace.w1)
  assert.equal(chantier.stage, 'spec')
  assert.equal(chantier.hasIntent, false)
  assert.equal(chantier.docs.intent, undefined)
})

test('a plan without ledger is at the plan stage and resolves its spec', () => {
  const spec = doc(`/r/${SPEC_PATH}`, '# Demo design\n')
  const plan = doc(`/r/${PLAN_REL}`, planText(SPEC_PATH))
  const chantier = only(build([workspace('w1', '/r', { specs: [spec], plans: [plan] })]).byWorkspace.w1)
  assert.equal(chantier.stage, 'plan')
  assert.equal(chantier.tasksTotal, 3)
  assert.equal(chantier.tasksDone, 0)
  assert.equal(chantier.docs.spec, spec.path)
  assert.equal(chantier.docs.plan, plan.path)
  assert.equal(chantier.key, `p1:${PLAN_REL}`)
  assert.equal(chantier.label, 'demo')
  assert.deepEqual(chantier.skippedStages, [])
  assert.deepEqual(chantier.tasks.map((task) => task.status), ['todo', 'todo', 'todo'])
})

test('a plan and a ledger with 2 of 3 tasks done is at the tasks stage, the fix task carries its round', () => {
  const plan = doc(`/r/${PLAN_REL}`, planText())
  const ledger = doc(
    `/r/${LEDGER_REL}`,
    ledgerText(PLAN_REL, ['Task 1: complete (review clean)', 'Task 2: complete (review clean)', 'Task 3: fix round 2/5']),
    now - HOUR,
  )
  // Seules 2 tâches sont Done : la 3e est en correction.
  const chantier = only(build([workspace('w1', '/r', { plans: [plan], ledgers: [ledger] })]).byWorkspace.w1)
  assert.equal(chantier.stage, 'tasks')
  assert.equal(chantier.tasksDone, 2)
  assert.equal(chantier.tasksTotal, 3)
  assert.deepEqual(chantier.tasks[2], { id: '3', title: 'third step', status: 'fix', fix: { round: 2, max: 5 } })
  assert.equal(chantier.docs.ledger, ledger.path)
  assert.equal(chantier.ledgerUpdatedAt, now - HOUR)
})

test('a plan and a ledger with 3 of 3 tasks done is at the review stage', () => {
  const plan = doc(`/r/${PLAN_REL}`, planText())
  const ledger = doc(`/r/${LEDGER_REL}`, ledgerText(PLAN_REL, ['Task 1: complete', 'Task 2: complete', 'Task 3: complete']))
  const chantier = only(build([workspace('w1', '/r', { plans: [plan], ledgers: [ledger] })]).byWorkspace.w1)
  assert.equal(chantier.stage, 'review')
  assert.equal(chantier.tasksDone, 3)
})

test('a recorded ledger that disappeared makes the chantier done, with the recorded count in the notes', () => {
  const plan = doc(`/r/${PLAN_REL}`, planText())
  const key = `p1:${PLAN_REL}`
  const memory: LedgerMemory = { [key]: { projectKey: 'p1', total: 3, done: 2, lastSeenAt: now - 24 * HOUR } }
  const result = build([workspace('w1', '/r', { plans: [plan] })], memory)
  const chantier = only(result.byWorkspace.w1)
  assert.equal(chantier.stage, 'done')
  assert.ok(chantier.notes.includes('2 of 3 tasks recorded'))
  assert.equal(chantier.tasksDone, 2)
  assert.equal(chantier.tasksTotal, 3)
  assert.equal(result.memory[key].goneAt, now)
  assert.equal(chantier.live, true)
})

test('a fully recorded done chantier carries no recorded-count note', () => {
  const plan = doc(`/r/${PLAN_REL}`, planText())
  const key = `p1:${PLAN_REL}`
  const memory: LedgerMemory = { [key]: { projectKey: 'p1', total: 3, done: 3, lastSeenAt: now - HOUR } }
  const chantier = only(build([workspace('w1', '/r', { plans: [plan] })], memory).byWorkspace.w1)
  assert.equal(chantier.stage, 'done')
  assert.deepEqual(chantier.notes, [])
})

test('a returning ledger clears goneAt and records the current counts', () => {
  const plan = doc(`/r/${PLAN_REL}`, planText())
  const ledger = doc(`/r/${LEDGER_REL}`, ledgerText(PLAN_REL, ['Task 1: complete']), now - HOUR)
  const key = `p1:${PLAN_REL}`
  const memory: LedgerMemory = { [key]: { projectKey: 'p1', total: 3, done: 2, lastSeenAt: now - 48 * HOUR, goneAt: now - 24 * HOUR } }
  const result = build([workspace('w1', '/r', { plans: [plan], ledgers: [ledger] })], memory)
  assert.equal(only(result.byWorkspace.w1).stage, 'tasks')
  assert.deepEqual(result.memory[key], { projectKey: 'p1', total: 3, done: 1, lastSeenAt: now })
})

test('memory of another project is left untouched when its ledger is absent', () => {
  const other = { projectKey: 'p2', total: 5, done: 1, lastSeenAt: now - 24 * HOUR }
  const result = build([workspace('w1', '/r')], { 'p2:docs/superpowers/plans/x.md': other })
  assert.deepEqual(result.memory['p2:docs/superpowers/plans/x.md'], other)
})

test('a gone entry older than 30 days is dropped, a younger one is kept', () => {
  const day = 24 * HOUR
  const memory: LedgerMemory = {
    'p1:old': { projectKey: 'p1', total: 2, done: 2, lastSeenAt: now - 50 * day, goneAt: now - 31 * day },
    'p1:young': { projectKey: 'p1', total: 2, done: 2, lastSeenAt: now - 50 * day, goneAt: now - 29 * day },
  }
  const result = build([workspace('w1', '/r')], memory)
  assert.equal(result.memory['p1:old'], undefined)
  assert.equal(result.memory['p1:young'].goneAt, now - 29 * day)
})

test('freshness follows the date in the file name, or the ledger date when it is more recent', () => {
  const live = doc('/r/docs/superpowers/plans/2026-11-10-live.md', planText())
  const dormant = doc('/r/docs/superpowers/plans/2026-11-09-dormant.md', planText())
  const dormantKey = 'p1:docs/superpowers/plans/2026-11-09-dormant.md'
  const byLabel = (chantiers: Chantier[], label: string) => chantiers.find((c) => c.label === label)
  const plain = build([workspace('w1', '/r', { plans: [live, dormant] })]).byWorkspace.w1
  assert.equal(byLabel(plain, 'live')?.live, true)
  assert.equal(byLabel(plain, 'dormant')?.live, false)
  assert.equal(byLabel(plain, 'dormant')?.key, dormantKey)

  const ledger = doc('/r/.superpowers/sdd/x/progress.md', ledgerText('docs/superpowers/plans/2026-11-09-dormant.md', ['Task 1: complete']), now - HOUR)
  const withLedger = build([workspace('w1', '/r', { plans: [dormant], ledgers: [ledger] })]).byWorkspace.w1
  assert.equal(only(withLedger).live, true)
})

test('a file without a date in its name falls back to its mtime; the file date counts until the end of that day', () => {
  const undated = doc('/r/docs/superpowers/plans/notes-plan.md', planText(), now - 2 * HOUR)
  assert.equal(only(build([workspace('w1', '/r', { plans: [undated] })]).byWorkspace.w1).lastMovedAt, now - 2 * HOUR)
  const dated = doc('/r/docs/superpowers/plans/2026-11-10-dated.md', planText())
  assert.equal(only(build([workspace('w1', '/r', { plans: [dated] })]).byWorkspace.w1).lastMovedAt, new Date(2026, 10, 10, 23, 59, 59, 999).getTime())
})

test('the live window is 7 days: exactly 7 days old is at rest, one millisecond less is live', () => {
  const atRest = doc('/r/docs/superpowers/plans/undated-plan.md', planText(), now - LIVE_WINDOW_MS)
  const live = doc('/r/docs/superpowers/plans/undated-plan.md', planText(), now - LIVE_WINDOW_MS + 1)
  assert.equal(only(build([workspace('w1', '/r', { plans: [atRest] })]).byWorkspace.w1).live, false)
  assert.equal(only(build([workspace('w1', '/r', { plans: [live] })]).byWorkspace.w1).live, true)
})

test('a chantier that went done more than 7 days ago is at rest', () => {
  const oldPlanRel = `${PLAN_DIR}/2026-10-01-old.md`
  const plan = doc(`/r/${oldPlanRel}`, planText())
  const key = `p1:${oldPlanRel}`
  const memory: LedgerMemory = { [key]: { projectKey: 'p1', total: 3, done: 3, lastSeenAt: now - 20 * 24 * HOUR, goneAt: now - 8 * 24 * HOUR } }
  const chantier = only(build([workspace('w1', '/r', { plans: [plan] })], memory).byWorkspace.w1)
  assert.equal(chantier.stage, 'done')
  assert.equal(chantier.live, false)
})

test('a plan shared by two workspaces of one project is shown only where the ledger is', () => {
  const plan = (root: string) => doc(`${root}/${PLAN_REL}`, planText())
  const ledger = doc(`/r2/${LEDGER_REL}`, ledgerText(PLAN_REL, ['Task 1: complete']), now - HOUR)
  const result = build([
    workspace('w1', '/r1', { plans: [plan('/r1')] }),
    workspace('w2', '/r2', { plans: [plan('/r2')], ledgers: [ledger] }),
  ])
  assert.equal(result.byWorkspace.w1.length, 0)
  assert.equal(only(result.byWorkspace.w2).stage, 'tasks')
})

test('without any ledger, each workspace of the project shows the plan once', () => {
  const plan = (root: string) => doc(`${root}/${PLAN_REL}`, planText())
  const result = build([workspace('w1', '/r1', { plans: [plan('/r1')] }), workspace('w2', '/r2', { plans: [plan('/r2')] })])
  assert.equal(only(result.byWorkspace.w1).key, `p1:${PLAN_REL}`)
  assert.equal(only(result.byWorkspace.w2).key, `p1:${PLAN_REL}`)
})

test('a plan outside the project, read through external, is keyed by its absolute path', () => {
  const planPath = '/ext/repo/docs/superpowers/plans/2026-09-16-x.md'
  const ledger = doc('/r/.superpowers/sdd/x/progress.md', ledgerText(planPath, ['Task 1: complete']), now - HOUR)
  const external = { [planPath]: doc(planPath, planText()) }
  const chantier = only(build([workspace('w1', '/r', { ledgers: [ledger] })], {}, external).byWorkspace.w1)
  assert.equal(chantier.key, `abs:${planPath}`)
  assert.equal(chantier.tasksTotal, 3)
  assert.equal(chantier.tasks[0].title, 'first step')
  assert.equal(chantier.docs.plan, planPath)
})

test('an unresolved absolute plan falls back to the same file name in the workspace plans folder', () => {
  const fallback = doc('/r/docs/superpowers/plans/2026-09-16-x.md', planText())
  const ledger = doc('/r/.superpowers/sdd/x/progress.md', ledgerText('/ext/repo/docs/superpowers/plans/2026-09-16-x.md', ['Task 1: complete']), now - HOUR)
  const chantier = only(build([workspace('w1', '/r', { plans: [fallback], ledgers: [ledger] })]).byWorkspace.w1)
  assert.equal(chantier.docs.plan, fallback.path)
  assert.equal(chantier.key, 'p1:docs/superpowers/plans/2026-09-16-x.md')
  assert.deepEqual(chantier.notes, [])
})

test('a plan found nowhere is noted and the tasks come from the ledger', () => {
  const ledger = doc(
    '/r/.superpowers/sdd/x/progress.md',
    ledgerText('/ext/repo/docs/superpowers/plans/2026-09-16-x.md', ['Task 1: complete', 'Task 2: dispatched']),
    now - HOUR,
  )
  const chantier = only(build([workspace('w1', '/r', { ledgers: [ledger] })]).byWorkspace.w1)
  assert.ok(chantier.notes.includes('plan not found'))
  assert.equal(chantier.docs.plan, undefined)
  assert.deepEqual(chantier.tasks, [
    { id: '1', title: '', status: 'done' },
    { id: '2', title: '', status: 'in-progress' },
  ])
  assert.equal(chantier.tasksTotal, 2)
  assert.equal(chantier.stage, 'tasks')
  assert.equal(chantier.key, 'p1:.superpowers/sdd/x/progress.md')
  assert.deepEqual(chantier.skippedStages, ['spec', 'plan'])
  assert.equal(chantier.label, 'x')
})

test('externalPointers lists absolute paths outside the project roots and skips the known ones', () => {
  const external = '/ext/repo/docs/superpowers/plans/2026-09-16-x.md'
  const ledger = doc('/r/.superpowers/sdd/x/progress.md', ledgerText(external, ['Task 1: complete']))
  const inside = doc('/r/.superpowers/sdd/y/progress.md', ledgerText('/r/docs/superpowers/plans/2026-11-01-y.md', ['Task 1: complete']))
  const input = files({ ledgers: [ledger, inside] })
  assert.deepEqual(externalPointers(input, ['/r'], {}), [external])
  assert.deepEqual(externalPointers(input, ['/r'], { [external]: doc(external, planText()) }), [])
})

test('externalPointers follows the spec pointer of a plan already read outside the project', () => {
  const planPath = '/ext/repo/docs/superpowers/plans/2026-09-16-x.md'
  const specPath = '/ext/repo/docs/superpowers/specs/2026-09-15-x-design.md'
  const ledger = doc('/r/.superpowers/sdd/x/progress.md', ledgerText(planPath, ['Task 1: complete']))
  const known = { [planPath]: doc(planPath, planText('docs/superpowers/specs/2026-09-15-x-design.md')) }
  assert.deepEqual(externalPointers(files({ ledgers: [ledger] }), ['/r'], known), [specPath])
})

test('same project, absolute pointer: the ledger of one workspace designates the plan of another', () => {
  const planPath = '/r1/docs/superpowers/plans/2026-11-15-x.md'
  const plan = doc(planPath, planText())
  const ledger = doc('/r2/.superpowers/sdd/x/progress.md', ledgerText(planPath, ['Task 1: complete']), now - HOUR)
  const w1 = workspace('w1', '/r1', { plans: [plan] })
  const w2 = workspace('w2', '/r2', { ledgers: [ledger] })
  const result = build([w1, w2])
  const chantier = only(result.byWorkspace.w2)
  assert.equal(chantier.key, 'p1:docs/superpowers/plans/2026-11-15-x.md')
  assert.equal(chantier.docs.plan, planPath)
  assert.equal(chantier.tasksTotal, 3)
  assert.equal(result.byWorkspace.w1.length, 0)
  assert.deepEqual(externalPointers(w2.files, ['/r1', '/r2'], {}), [])
})

test('an intents/ file that does not end with -intent.md opens nothing; one that does opens a chantier', () => {
  const study = doc(`/r/${INTENT_DIR}/2026-11-17-x-etude.md`, '# Study\n')
  assert.equal(build([workspace('w1', '/r', { intents: [study] })]).byWorkspace.w1.length, 0)
  const intent = doc(`/r/${INTENT_DIR}/2026-11-17-x-intent.md`, '# Intent\n')
  assert.equal(only(build([workspace('w1', '/r', { intents: [intent] })]).byWorkspace.w1).stage, 'intent')
})

test('an intent designated by a spec does not open a second chantier', () => {
  const intent = doc(`/r/${INTENT_DIR}/2026-11-17-x-intent.md`, '# Intent\n')
  const spec = doc(`/r/${SPEC_DIR}/2026-11-17-x-design.md`, `Intent record : \`${INTENT_DIR}/2026-11-17-x-intent.md\`\n\n# Design\n`)
  const chantier = only(build([workspace('w1', '/r', { intents: [intent], specs: [spec] })]).byWorkspace.w1)
  assert.equal(chantier.stage, 'spec')
})

test('a study in intents/ designated by a plan as its spec belongs to the plan chantier', () => {
  const study = doc(`/r/${INTENT_DIR}/2026-11-10-network-etude.md`, '# Study\n')
  const plan = doc(`/r/${PLAN_REL}`, planText(`${INTENT_DIR}/2026-11-10-network-etude.md`))
  const chantier = only(build([workspace('w1', '/r', { intents: [study], plans: [plan] })]).byWorkspace.w1)
  assert.equal(chantier.stage, 'plan')
  assert.equal(chantier.docs.spec, study.path)
})

test('a plan without a Spec header skips the spec stage', () => {
  const plan = doc(`/r/${PLAN_REL}`, planText())
  const chantier = only(build([workspace('w1', '/r', { plans: [plan] })]).byWorkspace.w1)
  assert.deepEqual(chantier.skippedStages, ['spec'])
  assert.equal(chantier.hasIntent, false)
})

test('a plans/ file without any task title is not a chantier', () => {
  const rulings = doc('/r/docs/superpowers/plans/2026-11-17-rulings.md', '# Rulings\n\nNothing to do.\n')
  assert.equal(build([workspace('w1', '/r', { plans: [rulings] })]).byWorkspace.w1.length, 0)
})

test('a ledger whose lines are not understood reports them', () => {
  const plan = doc(`/r/${PLAN_REL}`, planText())
  const ledger = doc(`/r/${LEDGER_REL}`, ledgerText(PLAN_REL, ['Task 1: complete', 'Task 2: mystery']), now - HOUR)
  const chantier = only(build([workspace('w1', '/r', { plans: [plan], ledgers: [ledger] })]).byWorkspace.w1)
  assert.equal(chantier.unparsedLines, 1)
})

test('sameMemory ignores lastSeenAt and sees every other difference', () => {
  const base: LedgerMemory = { k: { projectKey: 'p1', total: 3, done: 2, lastSeenAt: 1 } }
  assert.equal(sameMemory(base, { k: { projectKey: 'p1', total: 3, done: 2, lastSeenAt: 999 } }), true)
  assert.equal(sameMemory(base, { k: { projectKey: 'p1', total: 3, done: 2, lastSeenAt: 1, goneAt: 5 } }), false)
  assert.equal(sameMemory(base, { k: { projectKey: 'p1', total: 4, done: 2, lastSeenAt: 1 } }), false)
  assert.equal(sameMemory(base, {}), false)
  assert.equal(sameMemory({}, {}), true)
})

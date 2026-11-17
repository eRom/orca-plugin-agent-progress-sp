// Joue le lecteur de ledger sur des extraits de vrais ledgers (src/fixtures/ledgers) et sur des cas limites écrits à la main.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { assert, test } from 'orca/testing'
import { parseLedger, type LedgerRead } from './ledger'

// Lit une fixture et retire la ligne de commentaire `<!-- source: … -->` : un vrai ledger n'en porte pas,
// et le parseur lit l'en-tête sur la toute première ligne.
async function readFixture(name: string): Promise<LedgerRead> {
  const path = fileURLToPath(new URL(`../fixtures/ledgers/${name}`, import.meta.url))
  const text = await readFile(path, 'utf8')
  const lines = text.split('\n')
  assert.ok(lines[0].startsWith('<!-- source:'), `${name} must start with a source comment`)
  return parseLedger(lines.slice(1).join('\n'))
}

test('reads the upstream SDD ledger: header plan, done, fix, and known no-effect forms', async () => {
  const ledger = await readFixture('upstream-sdd.md')
  assert.equal(ledger.planPath, 'docs/superpowers/plans/2026-01-01-demo.md')
  assert.deepEqual(ledger.tasks['1'], { kind: 'done' })
  assert.deepEqual(ledger.tasks['2'], { kind: 'done' })
  assert.deepEqual(ledger.tasks['3'], { kind: 'fix', round: 2, max: 5 })
  assert.equal(ledger.unparsedLines, 0)
})

test('reads the upstream inline ledger', async () => {
  const ledger = await readFixture('upstream-inline.md')
  assert.deepEqual(ledger.tasks['1'], { kind: 'done' })
  assert.equal(ledger.unparsedLines, 0)
})

test('reads bulleted tasks and counts exactly the one unknown line', async () => {
  const ledger = await readFixture('erom-bullets.md')
  assert.equal(ledger.planPath, '/Users/demo/project/docs/superpowers/plans/2026-11-16-demo-plugin.md')
  for (const number of ['1', '2', '3', '4', '5', '6']) {
    assert.deepEqual(ledger.tasks[number], { kind: 'done' }, `task ${number}`)
  }
  assert.equal(ledger.tasks['7'], undefined)
  assert.equal(ledger.unparsedLines, 1)
})

test('accepts a space before the colon', async () => {
  const ledger = await readFixture('erom-space-colon.md')
  for (const number of ['1', '2', '5']) {
    assert.deepEqual(ledger.tasks[number], { kind: 'done' }, `task ${number}`)
  }
  // Les lignes `released` sont connues, sans effet et non comptées.
  assert.equal(ledger.unparsedLines, 0)
})

test('a grouped line applies to every task it names and an unknown group line is counted', async () => {
  const ledger = await readFixture('erom-groups.md')
  assert.deepEqual(ledger.tasks['3'], { kind: 'done' })
  assert.deepEqual(ledger.tasks['4'], { kind: 'done' })
  assert.equal(ledger.unparsedLines, 1)
})

test('expands a range and keeps in-progress from dispatched then review', async () => {
  const ledger = await readFixture('erom-range.md')
  for (const number of ['2', '3', '4']) {
    assert.deepEqual(ledger.tasks[number], { kind: 'in-progress' }, `task ${number}`)
  }
  assert.equal(ledger.tasks['1'], undefined)
  assert.equal(ledger.tasks['5'], undefined)
  assert.equal(ledger.unparsedLines, 0)
})

test('maps implemented, implementer and re-review to in-progress, note and BASE to no effect', async () => {
  const ledger = await readFixture('erom-in-progress.md')
  assert.deepEqual(ledger.tasks['1'], { kind: 'in-progress' })
  assert.deepEqual(ledger.tasks['2'], { kind: 'in-progress' })
  assert.deepEqual(ledger.tasks['3'], { kind: 'in-progress' })
  assert.equal(ledger.tasks['4'], undefined)
  assert.equal(ledger.tasks['5'], undefined)
  assert.equal(ledger.unparsedLines, 0)
})

test('a legacy ledger without a plan header has no plan path and does not crash', async () => {
  const ledger = await readFixture('legacy-no-plan.md')
  assert.equal(ledger.planPath, null)
  assert.deepEqual(ledger.tasks['1'], { kind: 'done' })
  assert.deepEqual(ledger.tasks['2'], { kind: 'done' })
  assert.equal(ledger.unparsedLines, 1)
})

test('reads the plan path after a single hyphen in the header', () => {
  assert.equal(parseLedger('# SDD ledger - plan: x.md\n').planPath, 'x.md')
})

test('a header on a later line is not a plan path', () => {
  assert.equal(parseLedger('\n# SDD ledger — plan: x.md\n').planPath, null)
})

test('a grouped fix line sets fix on every task of the range', () => {
  const ledger = parseLedger('Tasks 2-4: fix round 1/5')
  for (const number of ['2', '3', '4']) {
    assert.deepEqual(ledger.tasks[number], { kind: 'fix', round: 1, max: 5 }, `task ${number}`)
  }
})

test('splits comma-separated numbers and lowercases lettered tasks', () => {
  const ledger = parseLedger('Tasks 1, 3A: complete')
  assert.deepEqual(ledger.tasks, { '1': { kind: 'done' }, '3a': { kind: 'done' } })
})

test('done is final: a later fix or in-progress line does not undo it', () => {
  const ledger = parseLedger('Task 2: complete (commits a..b)\nTask 2: fix round 3/5\nTask 2: review 1\n')
  assert.deepEqual(ledger.tasks['2'], { kind: 'done' })
  assert.equal(ledger.unparsedLines, 0)
})

test('the last fix line wins until the task is done', () => {
  const ledger = parseLedger('Task 1: fix round 1/5\nTask 1: review\nTask 1: fix round 2/5\n')
  assert.deepEqual(ledger.tasks['1'], { kind: 'fix', round: 2, max: 5 })
})

test('complete only counts as a whole word', () => {
  const ledger = parseLedger('Task 1: completed it\nTask 2: complete, agents closed\n')
  assert.equal(ledger.tasks['1'], undefined)
  assert.deepEqual(ledger.tasks['2'], { kind: 'done' })
  assert.equal(ledger.unparsedLines, 1)
})

test('lines that are not task lines are ignored without being counted', () => {
  const text = 'Ruling: keep it\nFinal review: clean\n| a | b |\nTask 5 AC-7a: live check\nTasks are listed below\n'
  assert.deepEqual(parseLedger(text), { planPath: null, tasks: {}, unparsedLines: 0 })
})

test('an absurd range is counted as not understood instead of expanding', () => {
  const ledger = parseLedger('Tasks 1-99999999: complete')
  assert.deepEqual(ledger.tasks, {})
  assert.equal(ledger.unparsedLines, 1)
})

test('empty text yields an empty read', () => {
  assert.deepEqual(parseLedger(''), { planPath: null, tasks: {}, unparsedLines: 0 })
})

test('text cut in the middle of a line does not crash and leaves the task not done', () => {
  const ledger = parseLedger('Task 1: compl')
  assert.equal(ledger.tasks['1'], undefined)
  assert.equal(ledger.unparsedLines, 1)
})

test('handles Windows line endings', () => {
  const ledger = parseLedger('# SDD ledger — plan: x.md\r\nTask 1: complete\r\n')
  assert.equal(ledger.planPath, 'x.md')
  assert.deepEqual(ledger.tasks['1'], { kind: 'done' })
})

test('"no named agents to release" is a known no-effect form, but other lines starting with "no" are not', () => {
  const known = parseLedger('# SDD ledger - plan: p.md\n\nTask 4: no named agents to release\nTask 5: No named agents to release.\n')
  assert.equal(known.unparsedLines, 0)
  assert.deepEqual(known.tasks, {})
  const other = parseLedger('# SDD ledger - plan: p.md\n\nTask 4: no idea what happened\nTask 5: no named agents\n')
  assert.equal(other.unparsedLines, 2)
})

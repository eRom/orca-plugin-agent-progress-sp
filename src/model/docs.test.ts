// Joue le lecteur de documents sur des fixtures de vrais en-têtes (src/fixtures/docs) et sur des cas limites écrits à la main.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { assert, test } from 'orca/testing'
import { docLabel, fileDate, parsePlanTasks, planSpecPointer, repoRootOf, specIntentPointer } from './docs'

// Les fixtures portent leur commentaire de provenance en dernière ligne : les pointeurs se lisent dans les premières lignes.
async function readFixture(name: string): Promise<string> {
  const path = fileURLToPath(new URL(`../fixtures/docs/${name}`, import.meta.url))
  return readFile(path, 'utf8')
}

test('reads plan tasks in file order', async () => {
  const tasks = parsePlanTasks(await readFixture('plan-spec-colon.md'))
  assert.deepEqual(tasks, [
    { id: '1', title: 'first step' },
    { id: '2', title: 'second step' },
    { id: '3', title: 'third step' },
  ])
})

test('returns no task for a plans/ file without task headings', async () => {
  assert.deepEqual(parsePlanTasks(await readFixture('rulings-no-task.md')), [])
})

test('lowercases task ids, ignores duplicates, accepts the title separators and heading levels', () => {
  const text = [
    '## TASK 3A - Letter id',
    '#### task 4. Dot separator',
    '### Task 5 – En dash',
    '### Task 3a: duplicate of the first id',
    '### Task 6',
    '##### Task 7: too deep',
    '# Task 8: too shallow',
  ].join('\n')
  assert.deepEqual(parsePlanTasks(text), [
    { id: '3a', title: 'Letter id' },
    { id: '4', title: 'Dot separator' },
    { id: '5', title: 'En dash' },
    { id: '6', title: '' },
  ])
})

test('reads the spec pointer after `**Spec:**`', async () => {
  assert.equal(
    planSpecPointer(await readFixture('plan-spec-colon.md')),
    'docs/superpowers/specs/2026-01-01-demo-design.md',
  )
})

test('reads the first path of a `**Spec :**` line, not the intent path that follows', async () => {
  assert.equal(
    planSpecPointer(await readFixture('plan-spec-space-colon.md')),
    'docs/superpowers/intents/2026-01-01-demo-etude.md',
  )
})

test('returns no spec pointer when the plan has no `**Spec` line', async () => {
  assert.equal(planSpecPointer(await readFixture('plan-no-spec.md')), null)
})

test('reads a spec pointer inside a Markdown link', () => {
  const text = '**Spec:** [the design](docs/superpowers/specs/2026-01-01-demo-design.md)'
  assert.equal(planSpecPointer(text), 'docs/superpowers/specs/2026-01-01-demo-design.md')
})

test('ignores a `**Spec:**` line beyond the 40th line of the plan', () => {
  const filler = Array.from({ length: 40 }, () => 'filler')
  const text = [...filler, '**Spec:** `docs/superpowers/specs/2026-01-01-demo-design.md`'].join('\n')
  assert.equal(planSpecPointer(text), null)
})

test('reads the intent pointer from an `Intent record :` first line', async () => {
  assert.equal(
    specIntentPointer(await readFixture('spec-intent-record.md')),
    'docs/superpowers/intents/2026-01-01-demo-intent.md',
  )
})

test('reads the intent pointer from an `Intention :` Markdown link, first path wins', async () => {
  assert.equal(
    specIntentPointer(await readFixture('spec-intention-link.md')),
    'docs/superpowers/intents/2026-01-01-demo-intent.md',
  )
})

test('returns no intent pointer for a spec that mentions none', async () => {
  assert.equal(specIntentPointer(await readFixture('spec-upstream.md')), null)
})

test('expands a bare intent file name into the intents folder', () => {
  assert.equal(
    specIntentPointer('Intent : 2026-01-01-demo-intent.md'),
    'docs/superpowers/intents/2026-01-01-demo-intent.md',
  )
})

test('ignores an intent mention beyond the 5th line of the spec', () => {
  const text = ['a', 'b', 'c', 'd', 'e', 'Intent record : `docs/superpowers/intents/2026-01-01-demo-intent.md`'].join('\n')
  assert.equal(specIntentPointer(text), null)
})

test('reads the date at the start of a file name', () => {
  assert.equal(fileDate('2026-11-17-suivi-superpowers-design.md'), '2026-11-17')
  assert.equal(fileDate('notes.md'), null)
  assert.equal(fileDate('12026-11-17-x.md'), null)
})

test('builds a label without date, `-design` suffix or extension', () => {
  assert.equal(docLabel('2026-11-17-suivi-superpowers-design.md'), 'suivi-superpowers')
  assert.equal(docLabel('2026-09-16-docs-site-v0.md'), 'docs-site-v0')
  assert.equal(docLabel('notes.md'), 'notes')
})

test('finds the repo root before `/docs/superpowers/` or `/.superpowers/`', () => {
  assert.equal(repoRootOf('/work/x/dev/a/docs/superpowers/plans/p.md'), '/work/x/dev/a')
  assert.equal(repoRootOf('/work/x/dev/a/.superpowers/sdd/p/progress.md'), '/work/x/dev/a')
  assert.equal(repoRootOf('/tmp/p.md'), null)
})

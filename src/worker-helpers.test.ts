// Joue la lecture de la mémoire stockée : une valeur mal formée est écartée, jamais propagée.
import { assert, test } from 'orca/testing'
import { labelOf, parseMemory } from './worker-helpers'

const valid = { projectKey: 'p1', total: 3, done: 2, lastSeenAt: 1000 }

test('parseMemory keeps well-formed entries, with or without the carrier workspace', () => {
  const memory = parseMemory({ a: valid, b: { ...valid, workspaceId: 'w2', goneAt: 5 } })
  assert.deepEqual(memory.a, valid)
  assert.deepEqual(memory.b, { ...valid, workspaceId: 'w2', goneAt: 5 })
})

test('parseMemory drops an entry whose goneAt is present but not a finite number', () => {
  const memory = parseMemory({
    nan: { ...valid, goneAt: Number.NaN },
    infinite: { ...valid, goneAt: Number.POSITIVE_INFINITY },
    text: { ...valid, goneAt: 'yesterday' },
    nothing: { ...valid, goneAt: null },
    fine: { ...valid, goneAt: 42 },
  })
  assert.deepEqual(Object.keys(memory), ['fine'])
})

test('parseMemory drops an entry with a non-finite counter, date or a malformed workspace id', () => {
  const memory = parseMemory({
    total: { ...valid, total: Number.NaN },
    done: { ...valid, done: Number.POSITIVE_INFINITY },
    seen: { ...valid, lastSeenAt: Number.NaN },
    workspace: { ...valid, workspaceId: 7 },
    project: { ...valid, projectKey: 3 },
    nullEntry: null,
    ok: valid,
  })
  assert.deepEqual(Object.keys(memory), ['ok'])
})

test('parseMemory answers an empty memory for anything that is not a plain object', () => {
  for (const value of [null, undefined, 3, 'x', [valid]]) assert.deepEqual(parseMemory(value), {})
})

test('labelOf shows the project for a checkout named after its branch, else the name', () => {
  assert.equal(labelOf({ name: 'main', project: 'acme-api' }), 'acme-api')
  assert.equal(labelOf({ name: 'feat/v1', project: 'agent-progress-sp' }), 'agent-progress-sp')
  assert.equal(labelOf({ name: 'main', project: '  ' }), 'main')
  assert.equal(labelOf({ name: 'main', project: null }), 'main')
  assert.equal(labelOf({ name: 'acme-api', project: 'acme-api' }), 'acme-api')
})

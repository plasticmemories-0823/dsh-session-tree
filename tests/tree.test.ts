import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { branchOf, canAttach, selectedAncestors } from '../src/protocol.ts'
import { removeArchivedRelations, TreeStore } from '../src/store.ts'
import { fitText, mergeBudget, sourceBudgets, textSize } from '../src/merge-budget.ts'

test('tree accepts deeper leaf copies and prevents cycles or moving a branch', () => {
  const edges = [{ id: '1', child: 'A', parent: 'B', since: 0 }]
  assert.equal(canAttach(edges, 'C', ['A']), undefined)
  assert.match(canAttach(edges, 'C', ['B']) ?? '', /已有子会话/)
  assert.equal(canAttach(edges, 'A', ['C']), undefined)
  assert.match(canAttach(edges, 'A', ['B']) ?? '', /后代/)
  assert.match(canAttach(edges, 'A', ['A']) ?? '', /自己/)
  assert.match(canAttach(edges, 'B', ['A']) ?? '', /已经挂在/)
})

test('branch selection traverses every level and selected descendants use the nearest selected ancestor', () => {
  const edges = [
    { id: '1', parent: 'root', child: 'middle', since: 0 },
    { id: '2', parent: 'middle', child: 'leaf', since: 0 },
    { id: '3', parent: 'other', child: 'untouched', since: 0 },
  ]
  assert.deepEqual(branchOf('root', edges), ['root', 'middle', 'leaf'])
  assert.deepEqual(selectedAncestors(['leaf', 'root', 'other'], edges), ['root', undefined, undefined])
  assert.deepEqual(selectedAncestors(['leaf', 'middle', 'root'], edges), ['middle', 'root', undefined])
  assert.deepEqual(selectedAncestors(['root', 'other'], edges), [undefined, undefined])
})

test('archive detaches either endpoint and preserves a waiting parent’s first message', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tree-archive-test-'))
  try {
    const path = join(root, 'state.json')
    const store = new TreeStore(path)
    await store.refresh()
    await store.update(state => {
      state.relations.push({ id: 'parent', parent: 'P', child: 'A', since: 1 },
        { id: 'child', parent: 'Q', child: 'B', since: 1 }, { id: 'other', parent: 'Q', child: 'C', since: 1 })
      state.pending.P = { first: { id: 'first', role: 'user', content: [{ type: 'text', text: 'saved' }], source: { kind: 'user' } } as NonNullable<typeof state.pending.P.first> }
      state.pending.Q = {}
      state.receipts.old = { id: 'old', parent: 'P', child: 'A', status: 'completed', turn: 1, through: 2, at: 3, text: 'history' }
    })
    await store.update(state => removeArchivedRelations(state, new Set(['P', 'B'])))
    const state = await new TreeStore(path).refresh()
    assert.deepEqual(state.relations.map(row => row.id), ['other'])
    assert.deepEqual(state.pending, { Q: {} })
    assert.deepEqual(state.savedFirst.P.content, [{ type: 'text', text: 'saved' }])
    assert.equal(state.receipts.old.text, 'history')
    assert.equal(canAttach(state.relations, 'A', ['B']), undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('merged context obeys a global cap, gives small sources a floor and weights the remainder by history size', () => {
  const sizes = [0, 92, 2000, 10000, 50000]
  const budget = mergeBudget(32000)
  const allocated = sourceBudgets(sizes, budget)
  assert.deepEqual(allocated.slice(0, 2), [0, 92])
  assert.equal(allocated.reduce((sum, size) => sum + size, 0), budget)
  assert.ok(allocated[4] > allocated[3] && allocated[3] > allocated[2] && allocated[2] >= 256)
  assert.ok(allocated.every((size, index) => size <= sizes[index]))
  assert.deepEqual(sourceBudgets([200, 500], 12000), [200, 500])
  assert.ok(sourceBudgets(Array(50).fill(30000), 5000).every(size => size === 100))
  assert.equal(mergeBudget(1000000), 12000)
  assert.equal(fitText('文🙂字', 6), '文')
  assert.equal(textSize(fitText('文🙂字', 7)), 7)
})

test('concurrent writers preserve both updates and a rejected edit makes no partial change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tree-test-'))
  try {
    const path = join(root, 'plugin', 'state.json')
    const stores = [new TreeStore(path), new TreeStore(path)]
    await Promise.all(stores.map(store => store.refresh()))
    await Promise.all(stores.map((store, i) => store.update(state => { state.pending[`key-${i}`] = {} })))
    await assert.rejects(stores[0].update(state => {
      state.pending['uncommitted'] = {}
      throw new Error('conflict')
    }), /conflict/)
    const reopened = await new TreeStore(path).refresh()
    assert.deepEqual(Object.keys(reopened.pending).sort(), ['key-0', 'key-1'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

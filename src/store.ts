import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { ancestorsOf, branchOf, sessionPalette } from './protocol.ts'
import type { ColorMark, MergedContext, Receipt, ReceiptBatch, Relation, Source, Task } from './protocol.ts'

interface PendingParent {
  first?: UserMessage
  error?: string
  goal?: string
  ready?: boolean
}

export interface State {
  version: 1
  relations: Relation[]
  colors: Record<string, ColorMark>
  pending: Record<string, PendingParent>
  savedFirst: Record<string, UserMessage>
  merged: Record<string, Source[]>
  mergedContexts: Record<string, MergedContext>
  titles: Record<string, string>
  receipts: Record<string, Receipt>
  tasks: Record<string, Task>
  batches: Record<string, ReceiptBatch>
  toolCreates: Record<string, { child: string; attached: boolean }>
  recycling: Record<string, { wasArchived: boolean }>
}

function empty(): State {
  return { version: 1, relations: [], colors: {}, pending: {}, savedFirst: {}, merged: {}, mergedContexts: {}, titles: {}, receipts: {}, tasks: {}, batches: {}, toolCreates: {}, recycling: {} }
}

export function fillTreeColors(state: State): void {
  const parents = new Map(state.relations.map(row => [row.child, row.parent]))
  const used = new Map<string, number>()
  for (const { value } of Object.values(state.colors)) used.set(value, (used.get(value) ?? 0) + 1)
  for (const { parent, child } of state.relations) {
    for (const id of [parent, child]) {
      if (state.colors[id]) continue
      const root = ancestorsOf(id, parents).at(-1) ?? id
      if (!state.colors[root]) {
        const value = sessionPalette.reduce((best, candidate) =>
          (used.get(candidate) ?? 0) < (used.get(best) ?? 0) ? candidate : best)
        state.colors[root] = { value }
        used.set(value, (used.get(value) ?? 0) + 1)
      }
      if (id !== root) {
        const { value } = state.colors[root]
        state.colors[id] = { value }
        used.set(value, (used.get(value) ?? 0) + 1)
      }
    }
  }
}

export function setTreeColor(state: State, id: string, value: string, unify: boolean, archived: ReadonlySet<string>): void {
  const relations = state.relations.filter(row => !archived.has(row.parent) && !archived.has(row.child))
  const parents = new Map(relations.map(row => [row.child, row.parent]))
  if (unify) {
    const root = ancestorsOf(id, parents).at(-1) ?? id
    for (const member of branchOf(root, relations)) state.colors[member] = { value }
    return
  }
  state.colors[id] = { value, custom: true }
  if (!parents.has(id)) {
    for (const descendant of branchOf(id, relations).slice(1)) {
      if (!state.colors[descendant]?.custom) state.colors[descendant] = { value }
    }
  }
}

export function removeArchivedRelations(state: State, archived: ReadonlySet<string>): void {
  for (const batch of Object.values(state.batches)) {
    if (archived.has(batch.parent) && batch.status !== 'delivered') batch.status = 'paused'
  }
  const touchedParents = new Set<string>()
  state.relations = state.relations.filter(row => {
    if (!archived.has(row.parent) && !archived.has(row.child)) return true
    touchedParents.add(row.parent)
    return false
  })
  for (const [id, pending] of Object.entries(state.pending)) {
    if (!archived.has(id) && (!touchedParents.has(id) || state.relations.some(row => row.parent === id))) continue
    if (pending.first) state.savedFirst[id] = pending.first
    delete state.pending[id]
  }
}

export function removeRecycledSession(state: State, id: string): void {
  removeArchivedRelations(state, new Set([id]))
  for (const records of [state.pending, state.savedFirst, state.merged, state.mergedContexts, state.titles, state.recycling, state.colors]) {
    delete records[id]
  }
  for (const records of [state.receipts, state.tasks]) {
    for (const [key, record] of Object.entries(records)) {
      if (record.parent === id || record.child === id) delete records[key]
    }
  }
  for (const batch of Object.values(state.batches)) {
    if (batch.parent === id) delete state.batches[batch.id]
  }
  for (const [key, creation] of Object.entries(state.toolCreates)) {
    if (creation.child === id) delete state.toolCreates[key]
  }
  for (const [key, sources] of Object.entries(state.merged)) {
    const remaining = sources.filter(source => source.id !== id)
    if (remaining.length === sources.length) continue
    if (remaining.length) state.merged[key] = remaining
    else delete state.merged[key]
    delete state.mergedContexts[key]
  }
}

export class TreeStore {
  current = empty()
  private readonly path: string

  constructor(path: string) {
    this.path = path
  }

  private async load(): Promise<State> {
    try {
      const state: State = JSON.parse(await readFile(this.path, 'utf8'))
      if (state.version !== 1 || !Array.isArray(state.relations)
        || !state.pending || !state.merged || !state.receipts || !state.tasks) {
        throw new Error('会话树数据格式无法读取')
      }
      state.titles ??= {}
      state.colors ??= {}
      state.mergedContexts ??= {}
      state.savedFirst ??= {}
      state.toolCreates ??= {}
      state.recycling ??= {}
      state.batches ??= {}
      return state
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty()
      throw error
    }
  }

  async refresh(): Promise<State> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    return withFileLock(this.path, async () => this.current = await this.load())
  }

  async update<T>(edit: (state: State) => T): Promise<T> {
    return withFileLock(this.path, async () => {
      const next = await this.load()
      const result = edit(next)
      await writeFileAtomic(this.path, JSON.stringify(next), { mode: 0o600, dirMode: 0o700 })
      this.current = next
      return result
    })
  }
}

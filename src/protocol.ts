export const route = '/api/session-tree'

export const sessionPalette = [
  '#ef6b73', '#f38b5e', '#e7ad47', '#d8cb56', '#9cbf55', '#5fba76', '#51bca1',
  '#4abec3', '#5bbada', '#669ff0', '#858cf4', '#a085eb', '#be82e4', '#e67bb9',
  '#bf595c', '#ae7956', '#a18b32', '#648538', '#368669', '#367d8c', '#627aa4',
  '#7656b5', '#a05689', '#b1a295', '#85929d', '#c4d0df', '#868386', '#f2e7cf',
] as const

export interface ColorMark {
  value: string
  custom?: true
}

export interface Source {
  id: string
  title: string
  through: number
  text: string
  messageId: string
}

export interface MergedContext {
  messageId: string
  text: string
}

export interface Relation {
  id: string
  parent: string
  child: string
  since: number
  role?: ChildRole
  childBusiness?: Source
  parentBusiness?: Source
  parentBusinessIsLocal?: boolean
  error?: string
}

export interface ChildRole {
  alias: string
  responsibility: string
}

export interface SessionRow {
  id: string
  title: string
  running: boolean
  archived: boolean
  blank: boolean
  cwd?: string
  workspaceId?: string
}

export interface Receipt {
  id: string
  parent: string
  child: string
  at: number
  through: number
  turn: number
  status: 'completed' | 'failed' | 'stopped' | 'summary-failed'
  text: string
  taskId?: string
  childName?: string
  output?: string
  artifacts?: string[]
  summary?: ReceiptSummary
}

export interface SummaryAttempt {
  category: 'output-limit' | 'empty' | 'context-limit' | 'stream' | 'provider' | 'cancelled'
  page: number
  attempt: number
  limit: number
  finish?: string
  outputTokens?: number
  code?: string
  message: string
}

export interface ReceiptSummary {
  status: 'pending' | 'completed' | 'failed'
  model?: { provider: string; model: string }
  offset: number
  text: string
  draft?: string
  attempts: SummaryAttempt[]
  attemptBase?: number
  legacyError?: string
}

export interface Task {
  id: string
  parent: string
  child: string
  text: string
  since: number
  status: 'waiting' | 'sending' | 'queued' | 'running' | 'review' | 'completed' | 'failed' | 'stopped'
  after?: string[]
  batch?: string
  messageId?: string
  relation?: string
  parentTitle?: string
  objective?: string
}

export interface ReceiptBatch {
  id: string
  parent: string
  through: number
  upstream?: string[]
  status: 'open' | 'ready' | 'sending' | 'delivered' | 'paused'
}

export interface TreeSnapshot {
  sessions: SessionRow[]
  relations: Relation[]
  colors: Record<string, ColorMark>
  created: string[]
  pending: { id: string; error?: string; hasPrompt: boolean }[]
  savedFirst: { id: string; text: string }[]
  merged: { id: string; sources: Source[] }[]
  receipts: Receipt[]
  tasks: Task[]
}

export type Action =
  | { type: 'attach'; parent: string; children: string[]; previous: (string | null)[]; selectedParents?: (string | null)[] }
  | { type: 'detach'; parent: string; child: string }
  | { type: 'new-child'; parent: string }
  | { type: 'merge' | 'new-parent'; anchor: string; sources: string[] }
  | { type: 'retry'; id: string }
  | { type: 'recycle'; id: string }
  | { type: 'color'; id: string; value: string; unify: boolean }

export function canAttach(relations: readonly Relation[], parent: string, children: readonly string[], copy = false): string | undefined {
  if (!children.length) return '请选择要挂载的会话'
  if (children.includes(parent)) return '不能挂到自己下面'
  const parents = new Map(relations.map(row => [row.child, row.parent]))
  if (ancestorsOf(parent, parents).some(id => children.includes(id))) return '不能挂到自己的后代下面'
  if (!copy && relations.some(row => children.includes(row.parent))) return '已有子会话的节点不能再挂到其他会话下'
  if (relations.some(row => row.parent === parent && children.includes(row.child))) return '会话已经挂在此处'
}

export function ancestorsOf(id: string, parents: ReadonlyMap<string, string>): string[] {
  const seen = new Set([id])
  const ancestors: string[] = []
  for (let parent = parents.get(id); parent !== undefined && !seen.has(parent); parent = parents.get(parent)) {
    ancestors.push(parent)
    seen.add(parent)
  }
  return ancestors
}

export function branchOf(root: string, relations: readonly Relation[]): string[] {
  const children = new Map<string, string[]>()
  for (const row of relations) {
    const siblings = children.get(row.parent) ?? []
    siblings.push(row.child)
    children.set(row.parent, siblings)
  }
  const branch = new Set([root])
  for (const id of branch) {
    for (const child of children.get(id) ?? []) branch.add(child)
  }
  return [...branch]
}

export function selectedAncestors(sources: readonly string[], relations: readonly Relation[]): (string | undefined)[] {
  const selected = new Set(sources)
  const parents = new Map(relations.map(row => [row.child, row.parent]))
  return sources.map(id => ancestorsOf(id, parents).find(ancestor => selected.has(ancestor)))
}

import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import type { DragEvent, MouseEvent, KeyboardEvent, PointerEvent } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { ancestorsOf, branchOf, canAttach, route, selectedAncestors, sessionPalette } from './protocol.ts'
import type { Action, AliasLanguage, CheckResult, RecycleResult, TaskAcceptance, TreeSnapshot } from './protocol.ts'
import { translator } from './i18n.ts'
import styles from './tree.css'

interface Row {
  id: string
  title?: string
  blank: boolean
  archived: boolean
  treeParent?: string
  treeDepth?: number
  treeRoot?: string
}

interface View {
  snapshot?: TreeSnapshot
  selected: ReadonlySet<string>
  collapsed: ReadonlySet<string>
  archived: ReadonlySet<string>
  detail?: string
  palette?: string
  settings?: boolean
  locale?: string
  confirmation?: { message: string; action: 'copy' | 'recycle'; settle(accepted: boolean): void }
}

let view: View = { selected: new Set(), collapsed: new Set(), archived: new Set() }
let dragging: string[] = []
let pointerStart: { id: string; attach: boolean } | undefined
let dropTarget: HTMLElement | undefined
let connected = false
let busy = false
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const snapshot = () => view
const t = (en: string, zh: string) => translator(view.locale ?? document.documentElement.lang)(en, zh)
const labelText = (pair: readonly [string, string]) => t(pair[0], pair[1])

function update(fields: Partial<View>): void {
  view = { ...view, ...fields }
  for (const listener of listeners) listener()
}

async function request<T>(action?: Action, signal?: AbortSignal): Promise<T> {
  const transport = (globalThis as typeof globalThis & { __DSH_TRANSPORT__?: { fetch?: typeof fetch } }).__DSH_TRANSPORT__
  const fetcher = transport?.fetch ?? globalThis.fetch
  const response = await fetcher(new URL(route.slice(1), document.baseURI).href, {
    signal, credentials: 'same-origin', cache: 'no-store',
    ...(action ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) } : {}),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok || !body) throw new Error(body?.error ?? t(`Could not connect to Session Tree (${response.status}).`, `会话树连接失败 (${response.status})`))
  return body as T
}

function applicable(id: string): boolean {
  if (view.archived.has(id)) return false
  return !!view.snapshot?.sessions.some(row => row.id === id && !row.archived
    && (!row.blank || relations().some(edge => edge.parent === id || edge.child === id)
      || view.snapshot?.merged.some(row => row.id === id)))
}

function selectable(row: Row): boolean {
  return !row.archived && (!row.blank || applicable(row.id))
}

function members(id: string): string[] {
  return view.selected.has(id) ? [...view.selected] : [id]
}

const relations = (state = view) => state.snapshot?.relations.filter(edge => !state.archived.has(edge.parent) && !state.archived.has(edge.child)) ?? []
const parentOf = (id: string) => relations().find(edge => edge.child === id)?.parent
const title = (id: string, fallback = id) => view.snapshot?.sessions.find(row => row.id === id)?.title ?? fallback

async function act(ctx: Context, action: Action): Promise<void> {
  if (busy) {
    ctx.contextMenus.notify(t('A Session Tree operation is in progress.', '正在处理会话树操作'), false)
    return
  }
  busy = true
  try {
    const result = await request<{ opened?: string; snapshot: TreeSnapshot; recycle?: RecycleResult }>(action)
    const retainSelection = action.type === 'color' || action.type === 'preferences'
    update({ snapshot: result.snapshot, ...(retainSelection ? {} : { selected: new Set(result.recycle?.failed.map(row => row.id)) }) })
    if (action.type === 'color' && view.palette === action.id) update({ palette: undefined })
    if (action.type === 'preferences') update({ settings: false })
    if (action.type === 'attach' || action.type === 'new-child') expand(action.parent)
    if (action.type === 'recycle') {
      if (view.detail === action.id) update({ detail: undefined })
      ctx.contextMenus.notify(t('Session moved to the Recycle Bin.', '会话已移到回收站'), true)
    }
    if (result.recycle) {
      const { recycled, failed } = result.recycle
      if (view.detail && recycled.includes(view.detail)) update({ detail: undefined })
      const reasons = failed.slice(0, 3).map(({ id, reason }) => `${title(id)}：${reason}`).join('；')
      const status = t(`Moved to the Recycle Bin: ${recycled.length}.`, `已移到回收站 ${recycled.length} 条。`)
      ctx.contextMenus.notify(status + (failed.length ? t(` Failed: ${failed.length}. `, `失败 ${failed.length} 条。`) + reasons : ''), !failed.length)
    }
    if (result.opened) {
      ctx.uiWorkspace.openSession(result.opened as SessionId)
      update({ detail: result.opened })
    }
  } catch (error) {
    ctx.contextMenus.notify(error instanceof Error ? error.message : String(error), false)
  } finally {
    busy = false
  }
}

let perform: (action: Action) => Promise<void> = () => Promise.resolve()
let notify: (text: string) => void = () => undefined

export function install(ctx: Context): void {
  perform = action => act(ctx, action)
  notify = text => ctx.contextMenus.notify(text, false)
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'session-tree-confirmation' }, ConfirmDialog))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'session-tree-color-palette' }, ColorPalette))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'session-tree-settings' }, SettingsDialog))
  ctx.effect(() => {
    const stop = new AbortController()
    const style = document.createElement('style')
    style.textContent = styles
    document.head.append(style)
    let timer: ReturnType<typeof setTimeout>
    let localeSync = Promise.resolve()
    let lastLocale: string | undefined
    const syncLocale = () => {
      const locale = document.documentElement.lang
      if (!locale || locale === lastLocale) return
      lastLocale = locale
      if (view.locale !== locale) update({ locale })
      localeSync = localeSync.then(async () => {
        if (stop.signal.aborted || locale !== document.documentElement.lang) return
        try {
          await request({ type: 'interface-locale', locale }, stop.signal)
        } catch (error) {
          if (!stop.signal.aborted && lastLocale === locale) {
            lastLocale = undefined
            ctx.logger.warn('session-tree: unable to sync DSH interface language', error)
          }
        }
      })
    }
    const observer = new MutationObserver(syncLocale)
    observer.observe(document.documentElement, { attributeFilter: ['lang'] })
    const refresh = async () => {
      try {
        if (!busy) {
          const before = view.snapshot
          const next = await request<TreeSnapshot>(undefined, stop.signal)
          connected = true
          if (!stop.signal.aborted && !busy && view.snapshot === before && JSON.stringify(before) !== JSON.stringify(next)) {
            update({ snapshot: next })
          }
          syncLocale()
        }
      } catch (error) {
        if (!stop.signal.aborted && !view.snapshot) ctx.logger.warn('session-tree: unable to read tree state', error)
        connected = false
      } finally {
        if (!stop.signal.aborted) timer = setTimeout(refresh, 1800)
      }
    }
    void refresh()
    return () => {
      stop.abort()
      clearTimeout(timer)
      observer.disconnect()
      view.confirmation?.settle(false)
      dragEnd()
      style.remove()
    }
  }, 'session-tree: native sidebar state')
  ctx.effect(() => ctx.contextMenus.register({ id: 'session-tree', target: 'session', order: 351,
    async resolve({ sessionId: id }, signal) {
      const ids = members(id)
      if (!applicable(id) || view.snapshot?.sessions.some(row => ids.includes(row.id) && row.running)) {
        try {
          const next = await request<TreeSnapshot>(undefined, signal)
          connected = true
          update({ snapshot: next })
        } catch { return [] }
      }
      const session = view.snapshot?.sessions.find(row => row.id === id)
      if (!connected || !session) return []
      const multi = ids.length > 1
      const recycle = { id: 'recycle', label: t('Move to Recycle Bin', '移到回收站') + (multi ? t(` (${ids.length})`, `（${ids.length}）`) : ''), danger: true, separatorBefore: true,
        disabled: ids.some(key => !view.snapshot?.sessions.some(row => row.id === key && !row.running)), run: async () => {
          const selection = multi
            ? t(`Move ${ids.length} selected sessions to the Recycle Bin?`, `将所选 ${ids.length} 条会话移到回收站？`)
              + '\n\n' + ids.slice(0, 8).map(key => title(key)).join('\n') + (ids.length > 8 ? '\n…' : '')
            : t(`Move “${title(id)}” to the Recycle Bin?`, `将「${title(id)}」移到回收站？`)
          const effect = t('DSH removes these chats and their tree links. Other sessions and workspace files are kept.',
            '聊天记录将从 DSH 移除，挂载关系会解除。未选会话和工作区文件会保留。')
          if (await confirm(`${selection}\n\n${effect}`, 'recycle')) {
            await perform(multi ? { type: 'recycle-batch', ids } : { type: 'recycle', id })
          }
        } }
      const color = { id: 'color', label: t('Session color', '会话颜色'), run: () => update({ palette: id }) }
      const recycleOptions = view.snapshot?.canRecycle ? [recycle] : []
      if (!applicable(id)) return [color, ...recycleOptions]
      const invalidSelection = ids.some(member => view.archived.has(member))
      const parent = parentOf(id)
      const pending = view.snapshot?.pending.find(row => row.id === id)
      const errors = relations().filter(row => (row.parent === id || row.child === id) && row.error)
      const subjects = view.snapshot
      const hasDetails = !!subjects?.merged.some(row => row.id === id) || !!pending
        || relations().some(edge => edge.parent === id || edge.child === id)
        || !!subjects?.savedFirst.some(item => item.id === id)
        || !!subjects?.receipts.some(row => row.parent === id)
        || !!subjects?.tasks.some(row => row.parent === id || row.child === id)
      if (ids.length > 1) return [
        { id: 'merge', label: t(`Merge into a new session (${ids.length})`, `合并到新会话（${ids.length}）`), disabled: invalidSelection, separatorBefore: true,
          run: () => perform({ type: 'merge', anchor: id, sources: ids }) },
        { id: 'new-parent', label: t('Create shared parent session', '创建共同父会话'),
          disabled: invalidSelection || relations().some(row => ids.includes(row.parent) || ids.includes(row.child)),
          run: () => perform({ type: 'new-parent', anchor: id, sources: ids }) },
        color,
        { id: 'clear', label: t('Clear selection', '清除多选'), run: () => update({ selected: new Set() }) },
        ...recycleOptions,
      ]
      return [
        { id: 'new-child', label: t('Create child session', '创建子会话'), disabled: !!pending, separatorBefore: true,
          run: () => perform({ type: 'new-child', parent: id }) },
        ...(parent ? [{ id: 'detach', label: t('Detach from parent', '解除挂载'), run: () => perform({ type: 'detach', parent, child: id }) }] : []),
        ...(hasDetails ? [{ id: 'details', label: t('Collaboration log', '会话协作记录'), run: () => update({ detail: view.detail === id ? undefined : id }) }] : []),
        ...(view.selected.has(id) ? [{ id: 'clear', label: t('Clear selection', '清除选择'), run: () => update({ selected: new Set() }) }] : []),
        ...(pending?.error && pending.hasPrompt ? [{ id: 'retry-first', label: t('Retry saved project task', '重试已发送的总任务'),
          run: () => perform({ type: 'retry', id }) }] : []),
        ...errors.map(edge => ({ id: `retry-${edge.id}`, label: t('Retry summary', '重试摘要') + ` · ${title(edge.child)}`,
          run: () => perform({ type: 'retry', id: edge.id }) })),
        color,
        ...recycleOptions,
      ]
    },
  }), 'session-tree: native session menu')
}

export function useView(): View {
  return useSyncExternalStore(subscribe, snapshot)
}

export function useArchived(archivedSessionIds: readonly string[]): void {
  useLayoutEffect(() => {
    const archived = new Set(archivedSessionIds)
    if (archived.size === view.archived.size && [...archived].every(id => view.archived.has(id))) return
    update({ archived, selected: new Set([...view.selected].filter(id => !archived.has(id))),
      snapshot: view.snapshot && { ...view.snapshot,
        relations: view.snapshot.relations.filter(row => !archived.has(row.parent) && !archived.has(row.child)) } })
  }, [archivedSessionIds])
}

function ConfirmDialog() {
  const { confirmation } = useView()
  if (!confirmation) return null
  const recycle = confirmation.action === 'recycle'
  return <Modal open title={recycle ? t('Delete sessions', '删除会话') : t('Confirm attachment', '确认挂载')} closeLabel={t('Close', '关闭')} onClose={() => confirmation.settle(false)} footer={<>
    <Button variant="outline" onClick={() => confirmation.settle(false)}>{t('Cancel', '取消')}</Button>
    <Button variant="outline" onClick={() => confirmation.settle(true)}>{recycle ? t('Move to Recycle Bin', '移到回收站') : t('Confirm attachment', '确认挂载')}</Button>
  </>}><p className="dsh-tree-copy-message">{confirmation.message}</p></Modal>
}

export function SettingsButton({ className }: { className?: string }) {
  const state = useView()
  const label = t('Session Tree settings', '会话树设置')
  return <button type="button" className={className} title={label} aria-label={label}
    disabled={!state.snapshot?.preferences} onClick={() => update({ settings: true })}>⚙</button>
}

function SettingsDialog() {
  const { settings, snapshot } = useView()
  if (!settings || !snapshot) return null
  return <NamingSettings key={snapshot.preferences.aliasLanguage} initial={snapshot.preferences.aliasLanguage} />
}

function NamingSettings({ initial }: { initial: AliasLanguage }) {
  const [value, setValue] = useState(initial)
  const close = () => update({ settings: false })
  const namingOptions = [
    ['zh', t('Chinese', '中文')], ['en', 'English'], ['follow', t('Follow DeepSeek Harness', '跟随 DeepSeek Harness')],
  ] as const
  return <Modal open title={t('Session Tree settings', '会话树设置')} closeLabel={t('Close', '关闭')} onClose={close} footer={<>
    <Button variant="outline" onClick={close}>{t('Cancel', '取消')}</Button>
    <Button variant="outline" onClick={() => void perform({ type: 'preferences', aliasLanguage: value })}>{t('Save', '保存')}</Button>
  </>}>
    <fieldset className="dsh-tree-settings">
      <legend>{t('Alias language for new child sessions', '新子会话的代号语言')}</legend>
      {namingOptions.map(([id, label]) => <label key={id}>
        <input type="radio" name="dsh-tree-alias-language" value={id} checked={value === id} onChange={() => setValue(id)} /> {label}
      </label>)}
    </fieldset>
  </Modal>
}

function ColorPalette() {
  const state = useView()
  if (!state.palette) return null
  return <ColorDialog key={state.palette} id={state.palette} state={state} />
}

function ColorDialog({ id, state }: { id: string; state: View }) {
  const [value, setValue] = useState(state.snapshot?.colors[id]?.value ?? sessionPalette[0])
  const edges = relations(state)
  const parents = new Map(edges.map(edge => [edge.child, edge.parent]))
  const root = ancestorsOf(id, parents).at(-1) ?? id
  const count = branchOf(root, edges).length
  const changesFollowers = root === id && count > 1
  const valid = /^#[0-9a-f]{6}$/i.test(value)
  const close = () => update({ palette: undefined })
  const save = (unify: boolean) => void perform({ type: 'color', id, value, unify })
  return <Modal open title={t('Session color', '会话颜色') + ` · ${title(id)}`} closeLabel={t('Close', '关闭')} onClose={close} footer={<>
    <Button variant="outline" onClick={close}>{t('Cancel', '取消')}</Button>
    {count > 1 && <Button variant="outline" disabled={!valid} onClick={() => save(true)}>{t('Apply to entire tree', '统一整棵会话树')}</Button>}
    <Button variant="outline" disabled={!valid} onClick={() => save(false)}>{changesFollowers ? t('Save root color', '保存顶层颜色') : t('Save session color', '保存此会话颜色')}</Button>
  </>}>
    <div className="dsh-tree-palette" role="group" aria-label={t('Preset colors', '预设颜色')}>
      {sessionPalette.map(color => <button key={color} type="button" className="dsh-tree-swatch"
        style={{ backgroundColor: color }} title={color} aria-label={color}
        aria-pressed={value.toLowerCase() === color} onClick={() => setValue(color)} />)}
    </div>
    <div className="dsh-tree-custom-color">
      <label>{t('Custom color', '自定义颜色')} <input type="color" value={valid ? value.toLowerCase() : sessionPalette[0]}
        onChange={event => setValue(event.target.value)} /></label>
      <input aria-label={t('Hex color value', '十六进制颜色值')} maxLength={7} value={value}
        onChange={event => setValue(event.target.value)} />
    </div>
    {changesFollowers && <p className="dsh-tree-color-hint">{t('Changes to the root color also apply to sessions that inherit it. Applying a color to the entire tree overrides individual colors.',
      '顶层颜色会同步给跟随它的节点。统一整棵树会覆盖单独设置的颜色。')}</p>}
  </Modal>
}

function confirm(message: string, action: 'copy' | 'recycle' = 'copy'): Promise<boolean> {
  view.confirmation?.settle(false)
  return new Promise(resolve => update({ confirmation: { message, action, settle(accepted) {
    update({ confirmation: undefined })
    resolve(accepted)
  } } }))
}

function expand(id: string): void {
  if (!view.collapsed.has(id)) return
  const collapsed = new Set(view.collapsed)
  collapsed.delete(id)
  update({ collapsed })
}

export function canReorder(source: string, target: string): boolean {
  return parentOf(source) === parentOf(target)
}

export function reorderRows<T extends Row>(rows: readonly T[], source: string, order: readonly string[]): T[] {
  const parent = rows.find(row => row.id === source)?.treeParent
  const members = new Set(order)
  return rows.filter(row => row.treeParent === parent && members.has(row.id))
}

export function useReveal(current?: string, reveal?: string): void {
  const parents = new Map(relations().map(edge => [edge.child, edge.parent]))
  const ancestors = ancestorsOf(reveal ?? current ?? '', parents)
  const path = JSON.stringify(ancestors)
  useEffect(() => {
    if (ancestors.some(id => view.collapsed.has(id))) {
      const collapsed = new Set(view.collapsed)
      for (const id of ancestors) collapsed.delete(id)
      update({ collapsed })
    }
  }, [current, reveal, path])
}

export function groupAnchor(id: string | undefined, list: { byId: Record<string, unknown> }, archived: readonly string[]): string | undefined {
  if (!id) return id
  const excluded = new Set(archived)
  const parents = new Map(relations().filter(edge => list.byId[edge.parent] && list.byId[edge.child]
    && !excluded.has(edge.parent) && !excluded.has(edge.child)).map(edge => [edge.child, edge.parent]))
  return ancestorsOf(id, parents).at(-1) ?? id
}

export function includeCreated<T extends { ids: readonly string[]; byId: Record<string, { blank: boolean }> }>(list: T, tree: View): T {
  // Native provisional rows are hidden when inactive. Plugin-created sessions
  // already have durable IDs and need to stay visible before their first turn.
  const stored = tree.snapshot
  if (!stored) return list
  const persistent = new Set([
    ...stored.relations.flatMap(row => [row.parent, row.child]),
    ...stored.merged.map(row => row.id),
    ...stored.created,
  ])
  const blank = [...persistent].filter(id => list.byId[id]?.blank)
  if (!blank.length) return list
  const byId = { ...list.byId }
  for (const id of blank) byId[id] = { ...byId[id], blank: false }
  return { ...list, byId }
}

interface Group<T extends Row> {
  key: string
  expanded: boolean
  containsCurrent: boolean
  sessions: readonly T[]
  sessionCount: number
}

export function arrange<T extends Row>(rows: readonly T[], state: View): (T & Row)[] {
  const buckets = new Map<string, T[]>()
  const byId = new Map(rows.map(row => [row.id, row]))
  const parents = new Map(relations(state).map(edge => [edge.child, edge.parent]))
  const moved = new Set<string>()
  for (const child of rows) {
    const parentId = parents.get(child.id)
    const parent = parentId && byId.get(parentId)
    if (!parent || parent.archived || child.archived) continue
    const bucket = buckets.get(parent.id) ?? []
    bucket.push(child)
    buckets.set(parent.id, bucket)
    moved.add(child.id)
  }
  const ordered: (T & Row)[] = []
  const seen = new Set<string>()
  function visit(root: T): void {
    const stack = [root as T & Row]
    while (stack.length) {
      const row = stack.pop()!
      if (seen.has(row.id)) continue
      seen.add(row.id)
      ordered.push(row)
      for (const child of (buckets.get(row.id) ?? []).toReversed()) {
        stack.push({ ...child, treeParent: row.id, treeRoot: root.id, treeDepth: (row.treeDepth ?? 0) + 1 })
      }
    }
  }
  for (const row of rows) if (!moved.has(row.id)) visit(row)
  for (const row of rows) if (!seen.has(row.id)) visit(row)
  return ordered
}

export function grouped<T extends Row, G extends Group<T>>(
  groups: readonly G[], expanded: readonly string[], current: string | undefined, state: View,
): G[] {
  const ordered = arrange(groups.flatMap(group => group.sessions), state)
  const owners = new Map(groups.flatMap(group => group.sessions.map(row => [row.id, group.key] as const)))
  const byGroup = new Map<string, T[]>()
  for (const row of ordered) {
    const key = owners.get(row.treeRoot ?? row.id)
    if (key === undefined) continue
    const dest = byGroup.get(key) ?? []
    dest.push(row)
    byGroup.set(key, dest)
  }
  return groups.flatMap(group => {
    const rows = byGroup.get(group.key) ?? []
    if (!rows.length && group.key === '') return []
    const open = expanded.includes(group.key)
    return [{ ...group, expanded: open, containsCurrent: rows.some(row => row.id === current),
      sessions: open ? rows : [], sessionCount: rows.length }]
  })
}

export function hideChildren<T extends Row>(rows: readonly T[], state: View): T[] {
  const visible = new Set<string>()
  return rows.filter(row => {
    if (row.treeParent && (!visible.has(row.treeParent) || state.collapsed.has(row.treeParent))) return false
    visible.add(row.id)
    return true
  })
}

export function limitRows<T extends Row>(rows: readonly T[], limit: number, state: View) {
  let count = 0
  let hiddenCount = 0
  let show = false
  const visible = rows.filter(row => {
    if (row.blank && !row.treeParent) return true
    if (!row.treeParent) {
      show = ++count <= limit
      if (!show) hiddenCount++
    }
    return show
  })
  return { rows: hideChildren(visible, state), hiddenCount }
}

export function click(row: Row, event: MouseEvent | KeyboardEvent): boolean {
  if (event.shiftKey) {
    event.preventDefault()
    if (!selectable(row)) return true
    const branch = branchOf(row.id, relations())
    if (branch.length === 1) return true
    const selected = new Set(view.selected)
    if (branch.every(id => selected.has(id))) {
      for (const id of branch) selected.delete(id)
    } else {
      for (const id of branch) selected.add(id)
    }
    update({ selected })
    return true
  }
  if (!selectable(row)) {
    if (!event.ctrlKey && !event.metaKey && view.selected.size) update({ selected: new Set() })
    return false
  }
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault()
    const selected = new Set(view.selected)
    if (selected.has(row.id)) selected.delete(row.id)
    else selected.add(row.id)
    update({ selected })
    return true
  }
  if (view.selected.size) update({ selected: new Set() })
  return false
}

export function rememberDragModifier(row: Row, event: PointerEvent): void {
  if (event.button === 0) pointerStart = { id: row.id, attach: event.ctrlKey || event.metaKey }
}

export function dragStart(row: Row, event: DragEvent): boolean {
  const attach = pointerStart?.id === row.id ? pointerStart.attach : event.ctrlKey || event.metaKey
  dragEnd()
  if (attach && selectable(row)) dragging = members(row.id)
  else if (attach) event.preventDefault()
  return attach
}

function clearTarget(): void {
  if (dropTarget) {
    delete dropTarget.dataset.sessionTreeDrop
    dropTarget.removeAttribute('data-session-tree-drop-label')
    dropTarget = undefined
  }
}

export function dragEnd(): boolean {
  const attached = dragging.length > 0
  clearTarget()
  dragging = []
  pointerStart = undefined
  return attached
}

export function dragLeave(event: DragEvent): void {
  if (dropTarget === event.currentTarget && !(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) {
    clearTarget()
  }
}

export function handleDrop(row: Row, event: DragEvent, commit: boolean): boolean {
  if (!dragging.length) return false
  const target = view.snapshot?.sessions.find(session => session.id === row.id)
  const edges = relations()
  const reason = row.archived || target?.archived ? t('Unarchive the target session first.', '请先取消归档目标会话')
    : dragging.some(id => view.archived.has(id)) ? t('Unarchive the source session first.', '请先取消归档来源会话')
    : row.blank && target && !target.cwd && !target.workspaceId ? t('Choose a workspace for the new session first.', '请先给新会话选择工作区')
    : view.snapshot?.pending.some(item => item.id === row.id) ? t('Send the project task in the shared parent session first.', '请先在共同父会话发送总任务')
    : canAttach(edges, row.id, dragging, true, view.locale ?? document.documentElement.lang)
  event.preventDefault()
  event.stopPropagation()
  event.dataTransfer.dropEffect = reason ? 'none' : 'copy'
  if (!commit) {
    if (dropTarget !== event.currentTarget) clearTarget()
    dropTarget = event.currentTarget as HTMLElement
    dropTarget.dataset.sessionTreeDrop = reason ? 'invalid' : 'valid'
    const targetTitle = title(row.id, row.title)
    dropTarget.dataset.sessionTreeDropLabel = reason ?? t(`Attach under ${targetTitle}`, `挂载到 ${targetTitle} 下`)
    return true
  }
  const children = [...dragging]
  clearTarget()
  if (reason) {
    notify(reason)
    return true
  }
  const parents = new Map(edges.map(edge => [edge.child, edge.parent]))
  const previous = children.map(id => parents.get(id) ?? null)
  const selectedParents = selectedAncestors(children, edges).map(id => id ?? null)
  const action: Action = { type: 'attach', parent: row.id, children, previous, selectedParents }
  const linked = children.flatMap(id => {
    const parent = parents.get(id)
    return parent ? [t(`“${title(id)}” is attached to “${title(parent)}”.`, `「${title(id)}」来自「${title(parent)}」`)] : []
  })
  const warnings: string[] = []
  if (edges.some(edge => children.includes(edge.parent)) && !selectedParents.some(Boolean)) {
    warnings.push(t('This attachment omits the child sessions. Hold Ctrl or Command to select the child sessions you want to include.',
      '本次迁移不携带子节点。若要带上子节点，请按 Ctrl 选择需要携带的子代理。'))
  }
  if (linked.length) {
    warnings.push(linked.join('\n') + '\n\n' + t('The copy retains earlier tasks and context recorded in its history. The original remains under its current parent.',
      '副本会携带已经写进历史的旧父会话任务及部分上下文，可能影响新项目。原会话留在原父会话下，之后各自独立。'))
  }
  const prompt = [t(`Attach under “${title(row.id)}”?`, `挂载到「${title(row.id)}」下？`), ...warnings].join('\n\n')
  void (warnings.length ? confirm(prompt) : Promise.resolve(true))
    .then(accepted => { if (accepted) return perform(action) })
  return true
}

export function rowProps(row: Row, state: View, current = false): Record<string, unknown> {
  const hasChildren = relations(state).some(edge => edge.parent === row.id
    && state.snapshot?.sessions.some(child => child.id === edge.child && !child.archived)) && !row.archived
  return { 'data-session-tree-depth': row.treeDepth,
    'aria-level': (row.treeDepth ?? 0) + 1,
    ...(row.treeDepth ? { style: { '--dsh-tree-offset': `${row.treeDepth * 17}px` } } : {}),
    'data-session-tree-current': current ? '' : undefined,
    'data-session-tree-selected': !row.archived && state.selected.has(row.id) ? '' : undefined,
    'aria-expanded': hasChildren ? !state.collapsed.has(row.id) : undefined }
}

export function RowControl({ row, state }: { row: Row; state: View }) {
  const hasChildren = rowProps(row, state)['aria-expanded'] !== undefined
  const pending = state.snapshot?.pending.find(item => item.id === row.id)
  const historicalDetails = state.snapshot?.receipts.some(item => item.parent === row.id)
    || state.snapshot?.savedFirst.some(item => item.id === row.id)
    || state.snapshot?.tasks.some(item => item.child === row.id || item.parent === row.id)
    || state.snapshot?.projects.some(item => item.parent === row.id)
  const hasDetails = historicalDetails || (!row.archived && (hasChildren || !!row.treeParent || !!pending
    || state.snapshot?.merged.some(item => item.id === row.id)))
  const closed = state.collapsed.has(row.id)
  const color = state.snapshot?.colors[row.id]
  return <>
    {hasChildren && <button type="button" className="dsh-tree-fold" aria-label={`${closed ? t('Expand', '展开') : t('Collapse', '折叠')} ${title(row.id)}`}
      onClick={event => {
        event.stopPropagation()
        if (closed) expand(row.id)
        else update({ collapsed: new Set([...view.collapsed, row.id]) })
      }}>{closed ? '▸' : '▾'}</button>}
    {pending && <span className="dsh-tree-state" title={pending.error}>{pending.error ? t('Retry needed', '待重试')
      : pending.hasPrompt ? t('Syncing', '同步中') : t('Awaiting task', '待总任务')}</span>}
    {hasDetails && <button type="button" className="dsh-tree-fold dsh-tree-record-button" aria-label={t(`Collaboration log for ${title(row.id)}`, `${title(row.id)}的会话协作记录`)}
      title={t('Collaboration log', '会话协作记录')} onClick={event => {
        event.stopPropagation()
        update({ detail: view.detail === row.id ? undefined : row.id })
      }}>≡</button>}
    {color && <button type="button" className="dsh-tree-color-mark" aria-label={t(`Session color for ${title(row.id)}`, `${title(row.id)}的会话颜色`)}
      title={t(`Session color ${color.value}`, `会话颜色 ${color.value}`)} onClick={event => {
        event.stopPropagation()
        update({ palette: row.id })
      }}><span style={{ backgroundColor: color.value }} /></button>}
  </>
}

const labels = { completed: ['Completed', '已完成'], failed: ['Failed', '失败'], stopped: ['Stopped', '已停止'],
  'summary-failed': ['Summary failed', '摘要失败'], waiting: ['Waiting for dispatch or dependencies', '等待派发或前置任务'],
  sending: ['Dispatching', '派发中'], queued: ['Queued', '已排队'], running: ['Running', '执行中'], review: ['Needs review', '待核对'] } as const
const summaryLabels = { pending: ['Summarizing', '摘要生成中'], completed: ['Summary ready', '摘要已生成'],
  failed: ['Summary failed; original reply saved', '摘要失败，已保留原文'] } as const
const summaryErrors = { 'output-limit': ['Output limit', '输出超限'], empty: ['Empty response', '无正文'],
  'context-limit': ['Context limit', '输入上下文超限'], stream: ['Stream interrupted', '流中断'],
  provider: ['Model provider error', '模型提供方错误'], cancelled: ['Canceled', '已取消'] } as const

const checkLabels = { passed: ['Passed', '通过'], failed: ['Failed', '未通过'], unverified: ['Unverified', '未验证'] } as const

function AcceptanceDetails({ acceptance }: { acceptance: TaskAcceptance }) {
  const groups: { label: string; checks: string[]; results?: CheckResult[] }[] = [
    { label: t('Task acceptance', '单项验收'), checks: acceptance.checks, results: acceptance.local },
    { label: t('Project acceptance', '整体验收'), checks: acceptance.projectChecks, results: acceptance.final },
  ]
  return <>{groups.filter(group => group.checks.length).map(({ label, checks, results }) =>
    <div key={label}><strong>{label} · {results
      ? `${results.filter(result => result.status === 'passed').length}/${checks.length} ${t('passed', '通过')}`
      : t('Awaiting results', '待提交')}</strong>
      {checks.map((check, index) => {
        const result = results?.[index]
        return <p key={check}>{index + 1}. {check}{result && ` · ${labelText(checkLabels[result.status])} · ${result.evidence}`}</p>
      })}</div>)}</>
}

export function Details({ row, state, open }: { row: Row; state: View; open: (id: string) => void }) {
  if (state.detail !== row.id || !state.snapshot) return null
  const { pending, savedFirst, merged, receipts, tasks, projects } = state.snapshot
  const initial = pending.find(item => item.id === row.id)
  const sources = merged.find(item => item.id === row.id)?.sources ?? []
  const ownRole = relations(state).find(edge => edge.child === row.id)?.role
  const roster = relations(state).filter(edge => edge.parent === row.id)
  const relatedReceipts = receipts.filter(item => item.parent === row.id)
  const relatedTasks = tasks.filter(item => item.child === row.id || (item.parent === row.id
    && !relatedReceipts.some(receipt => receipt.taskId === item.id))).toReversed()
  return <section className="dsh-tree-record" aria-label={t('Collaboration log', '会话协作记录')}>
    {ownRole && <div><strong>{ownRole.alias}</strong> · {ownRole.responsibility}</div>}
    {roster.map(edge => <div key={edge.id}>
      <button type="button" onClick={() => open(edge.child)}>{edge.role?.alias ?? title(edge.child)} ↗</button>
      {edge.role?.responsibility && <span>{edge.role.responsibility}</span>}
    </div>)}
    {initial && <div>{initial.error ?? t('Send the first project task to sync context.', '发送第一条总任务以同步上下文。')}
      {initial.error && initial.hasPrompt && <button type="button" onClick={() => void perform({ type: 'retry', id: row.id })}>{t('Retry saved project task', '重试已发送的总任务')}</button>}</div>}
    {savedFirst.filter(item => item.id === row.id).map(item => <details key={item.id}><summary>{t('Saved first project task', '已保存的首条总任务')}</summary><p>{item.text}</p></details>)}
    {sources.map(source => <button type="button" key={source.id} onClick={() => open(source.id)}>{title(source.id, source.title)} ↗</button>)}
    {projects.filter(project => project.parent === row.id).toReversed().map(project =>
      <details key={project.id}><summary>{t('Project acceptance', '项目验收')} · {project.depth === 'light' ? t('Light', '轻量') : t('Thorough', '完整')}
        {' · '}{project.acceptedBy ? t('Passed', '已通过') : project.superseded ? t('Criteria updated', '标准已更新') : t('Awaiting acceptance', '待验收')}</summary>
        <p>{project.objective}</p>
        {project.directory && <p>{t('Project directory', '项目目录')} · {project.directory}</p>}
        {project.checks.map((check, index) => <p key={check}>{index + 1}. {check}</p>)}
      </details>)}
    {relatedTasks.map(task => <details key={task.id}><summary>{task.child === row.id ? t('From', '来自') : t('Assigned to', '派发给')} {title(task.child === row.id ? task.parent : task.child)} · {labelText(labels[task.status])}</summary>
      <p>{task.text}</p>{task.acceptance && <AcceptanceDetails acceptance={task.acceptance} />}</details>)}
    {relatedReceipts.map(receipt => <details key={receipt.id}><summary>{receipt.childName ?? title(receipt.child)} · {t(`Turn ${receipt.turn}`, `第 ${receipt.turn} 轮`)} · {labelText(labels[receipt.status])}
      {receipt.summary && ` · ${labelText(summaryLabels[receipt.summary.status])}`}</summary>
      <button type="button" onClick={() => open(receipt.child)}>{t('Open child session', '打开子会话')} ↗</button>
      {!!receipt.artifacts?.length && <p>{receipt.artifacts.join('\n')}</p>}
      {receipt.acceptance && <AcceptanceDetails acceptance={receipt.acceptance} />}
      <p>{receipt.text || t('There is no saved reply for this turn.', '本轮没有已保存的对外回复。')}</p>
      {receipt.summary?.text && <p>{receipt.summary.text}</p>}
      {receipt.summary?.legacyError && <p>{t('Earlier error without details', '历史原因未记录')} · {receipt.summary.legacyError}</p>}
      {receipt.summary?.attempts.map((attempt, index) =>
        <p key={index}>{labelText(summaryErrors[attempt.category])} · {t('Offset', '位置')} {attempt.page} · {t(`Attempt ${attempt.attempt}`, `第 ${attempt.attempt} 次`)} · {attempt.finish ?? attempt.code ?? attempt.message}
          {attempt.outputTokens !== undefined && ` · ${t('Output', '输出')} ${attempt.outputTokens}/${attempt.limit} tokens`}</p>)}
      {receipt.summary?.status === 'failed' && receipt.summary.model
        && <button type="button" onClick={() => void perform({ type: 'retry', id: receipt.id })}>{t('Retry summary', '重试摘要')}</button>}</details>)}
  </section>
}

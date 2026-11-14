import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const id = '@deepseek-ai/dsh-client-ui-workspace'
const upstream = new URL(`../node_modules/${id}/`, import.meta.url)
const output = new URL('../lib/workspace/', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', upstream), 'utf8'))
const source = await readFile(new URL('lib/client.js', upstream), 'utf8')
const hash = createHash('sha256').update(source).digest('hex')
if (manifest.version !== '0.2.2-rc.3' || hash !== '3ff4116dc91b7dc5cc57e7672e0d7935f992b339be3444a7a72992df218765ba') {
  throw new Error('The bundled DSH Workspace client must match the verified 0.2.2-rc.3 artifact')
}

function replaceOnce(input, before, after) {
  if (input.split(before).length !== 2) throw new Error(`DSH Workspace hook changed: ${before}`)
  return input.replace(before, () => after)
}

function editFunction(bundle, name, changes) {
  const start = bundle.indexOf(`function ${name}(`)
  const end = bundle.indexOf('}function ', start) + 1
  if (start < 0 || end <= start) throw new Error(`Missing DSH Workspace function: ${name}`)
  let segment = bundle.slice(start, end)
  for (const [before, after] of changes) segment = replaceOnce(segment, before, after)
  return bundle.slice(0, start) + segment + bundle.slice(end)
}

// Extend the exact native artifact. Its slot, picker, search, hover cards,
// animation, context menu, access checks, and ordinary rows stay in use.
let client = source.replace(/^\/\/# sourceMappingURL=.*$/m, '')
client = editFunction(client, 'SessionNodeItem', [
  ['const row=node;', 'const treeState=sessionTree.useView();const row=node;'],
  ['"aria-selected":selected,', '"aria-selected":selected,...sessionTree.rowProps(row,treeState,selected),'],
  ['onClick:()=>{onOpen(node.id)}', 'onClick:event=>{if(!sessionTree.click(row,event))onOpen(node.id)}'],
  ['if(event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return;event.preventDefault();onOpen(node.id)', 'if(event.altKey)return;if(sessionTree.click(row,event))return;if(event.ctrlKey||event.metaKey||event.shiftKey)return;event.preventDefault();onOpen(node.id)'],
  ['draggable,onDragStart:!draggable?void 0:e=>{e.dataTransfer.effectAllowed=`move`;e.dataTransfer.setData(`text/plain`,node.id);drag.start();dragPreview.start(e)}', 'onPointerDownCapture:event=>sessionTree.rememberDragModifier(row,event),draggable,onDragStart:!draggable?void 0:e=>{const attach=sessionTree.dragStart(row,e);if(e.defaultPrevented)return;e.dataTransfer.effectAllowed=attach?`copyMove`:`move`;e.dataTransfer.setData(`text/plain`,node.id);if(!attach)drag.start();dragPreview.start(e)}'],
  ['onDragEnd:()=>{if(dragPreview.clear())drag?.end()}', 'onDragEnd:()=>{const attach=sessionTree.dragEnd();if(dragPreview.clear()&&!attach)drag?.end()}'],
  ['onDragOver:drag===void 0?void 0:e=>{if(!drag.active)return;', 'onDragLeave:sessionTree.dragLeave,onDragOver:e=>{if(sessionTree.handleDrop(row,e,false))return;if(!drag?.active)return;'],
  ['onDrop:drag===void 0?void 0:e=>{if(!drag.active)return;', 'onDrop:e=>{if(sessionTree.handleDrop(row,e,true))return;if(!drag?.active)return;'],
  ['children:[(0,react_jsx_runtime.jsx)(`span`,{className:Rows_module_css_default.slot', 'children:[(0,react_jsx_runtime.jsx)(sessionTree.RowControl,{row,state:treeState}),(0,react_jsx_runtime.jsx)(`span`,{className:Rows_module_css_default.slot'],
  ['return(0,react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.HoverCard,', 'const nativeRow=(0,react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.HoverCard,'],
  ['copiedLabel:t(`hover.copied`)})}', 'copiedLabel:t(`hover.copied`)});return(0,react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment,{children:[nativeRow,(0,react_jsx_runtime.jsx)(sessionTree.Details,{row,state:treeState,open:onOpen})]})}'],
])
client = editFunction(client, 'SessionTree', [
  ['const statuses=useSessionStatus(s=>s);', 'const statuses=useSessionStatus(s=>s);const treeState=sessionTree.useView();'],
  ['owningGroupKey(workspaces,revealSessionId);', 'owningGroupKey(workspaces,sessionTree.groupAnchor(revealSessionId,list,rowState.archivedSessionIds));sessionTree.useReveal(current,revealSessionId);'],
  ['owningGroupKey(workspaces,current);', 'owningGroupKey(workspaces,sessionTree.groupAnchor(current,list,rowState.archivedSessionIds));'],
  ['const groups=(0,react.useMemo)(()=>deriveGroups(list,workspaces,rowState,statuses,{expandedGroups,ungroupedOrder:ungroupedSessionIds}),[list,workspaces,rowState,statuses,expandedGroups,ungroupedSessionIds]);',
    'const groups=(0,react.useMemo)(()=>{const options={expandedGroups,ungroupedOrder:ungroupedSessionIds};if(!treeState.snapshot?.relations.length)return deriveGroups(list,workspaces,rowState,statuses,options);return sessionTree.grouped(deriveGroups(list,workspaces,rowState,statuses,{...options,expandedGroups:[...workspaces.map(space=>space.workspaceId),``]}),expandedGroups,current,treeState)},[list,workspaces,rowState,statuses,expandedGroups,ungroupedSessionIds,current,treeState]);'],
  ['const renderedSessions=watermarkRows(group.sessions,sessionWatermarks[group.key]??SESSION_WATERMARK_BASE).rows;', 'const renderedSessions=sessionTree.reorderRows(sessionTree.limitRows(group.sessions,sessionWatermarks[group.key]??SESSION_WATERMARK_BASE,treeState).rows,activeDrag.sessionId,accountSessionIds);'],
  ['const compatibleTarget=sameGroupDrag&&drag.pinned===node.pinned;', 'const compatibleTarget=sameGroupDrag&&drag.pinned===node.pinned&&sessionTree.canReorder(drag.sessionId,node.id);'],
  ['const collapsed=watermarkRows(group.sessions,baselines.get(group.key)??SESSION_WATERMARK_BASE);const visible=watermarkRows(group.sessions,watermark);', 'const collapsed=sessionTree.limitRows(group.sessions,baselines.get(group.key)??SESSION_WATERMARK_BASE,treeState);const visible=sessionTree.limitRows(group.sessions,watermark,treeState);'],
])
client = editFunction(client, 'FlatList', [
  ['const rows=(0,react.useMemo)(()=>deriveFlat(list,sessionIds,rowState,statuses),[list,sessionIds,rowState,statuses]);',
    'const treeState=sessionTree.useView();const rows=(0,react.useMemo)(()=>sessionTree.hideChildren(sessionTree.arrange(deriveFlat(list,sessionIds,rowState,statuses),treeState),treeState),[list,sessionIds,rowState,statuses,treeState]);'],
  ['const commitDrag=', 'sessionTree.useReveal(currentId,revealSessionId);const commitDrag='],
  ['sessionDragOrder(sessionIds,rows,activeDrag,over)', 'sessionDragOrder(sessionIds,sessionTree.reorderRows(rows,activeDrag.sessionId,sessionIds),activeDrag,over)'],
  ['const active=drag!==null&&drag.pinned===node.pinned;', 'const active=drag!==null&&drag.pinned===node.pinned&&sessionTree.canReorder(drag.sessionId,node.id);'],
])
client = editFunction(client, 'WorkspaceBrowser', [
  ['const list=useSessions(state=>state);', 'const nativeList=useSessions(state=>state);const treeState=sessionTree.useView();const list=(0,react.useMemo)(()=>sessionTree.includeCreated(nativeList,treeState),[nativeList,treeState.snapshot]);'],
  ['const archivedSessionIds=useWorkspaces(state=>state.archivedSessionIds);', 'const archivedSessionIds=useWorkspaces(state=>state.archivedSessionIds);sessionTree.useArchived(archivedSessionIds);'],
])
client = replaceOnce(client, 'function apply(ctx){', 'function apply(ctx){sessionTree.install(ctx);')

const { outputFiles: [augmentation] } = await build({
  entryPoints: ['src/native.tsx'], write: false, bundle: true, format: 'iife', globalName: 'sessionTree',
  platform: 'browser', target: 'es2022', jsx: 'automatic', loader: { '.css': 'text' },
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
})
client = replaceOnce(client, 'factory:require=>{', `factory:require=>{\n${augmentation.text}\n`)

await mkdir(output, { recursive: true })
await Promise.all([
  build({ entryPoints: ['src/host.ts'], outfile: 'lib/host.js', bundle: true,
    platform: 'node', format: 'esm', target: 'node24', packages: 'external' }),
  writeFile(new URL('client.js', output), client),
  writeFile(new URL('index.js', output), 'export function apply() {}\n'),
  writeFile(new URL('package.json', output), JSON.stringify({ name: id, version: manifest.version, type: 'module',
    main: './index.js', exports: { '.': './index.js', './client': './client.js' }, dsh: manifest.dsh }, null, 2)),
])

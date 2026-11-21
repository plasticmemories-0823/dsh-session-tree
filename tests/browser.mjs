import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { chromium } from 'playwright-core'

const home = process.env.SESSION_TREE_TEST_HOME
const executable = process.env.SESSION_TREE_DSH_EXE
if (!home || !executable) throw new Error('Set SESSION_TREE_TEST_HOME and SESSION_TREE_DSH_EXE first')

const observed = []
let failSummary = 0
let delayReceipt = false
let overflowMerge = false
let invalidRoles = false
const summaryHits = new Map()
const server = createServer(async (request, response) => {
  if (request.method === 'GET') {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ data: ['deepseek-pro', 'deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash'].map(id => ({ id, object: 'model' })) }))
    return
  }
  let raw = ''
  for await (const part of request) raw += part
  const body = JSON.parse(raw)
  const flatten = message => typeof message.content === 'string' ? message.content
    : message.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
  const system = JSON.stringify(body.system)
  const messages = body.messages ?? []
  const latest = [...messages].reverse().filter(message => message.role === 'user').slice(0, 1).map(flatten)[0] ?? ''
  const lastContent = messages.findLast(message => message.role !== 'system')?.content
  const previousTool = lastContent?.some?.(block => block.type === 'tool_result')
  const fixturePattern = /\b(?:ROSTER-FIXTURE|CREATE-STORY|RETRY-STORY|CREATE-BACKGROUND) /
  const fixture = messages.findLast(message => fixturePattern.test(JSON.stringify(message.content)))
  const action = fixture && (previousTool || messages.indexOf(fixture) >= messages.findLastIndex(message => message.role === 'assistant'))
    ? JSON.stringify(fixture.content) : ''
  const isSummary = system?.includes('Session Tree summarizer')
  const observedRequest = { body, latest, isSummary }
  observed.push(observedRequest)
  const receiptProbe = isSummary && latest.includes('Summarize this final child reply')
  const probe = receiptProbe && latest.match(/(?:RECEIPT-LIMIT|RECEIPT-EMPTY|RECEIPT-RESTART-TAIL)/)?.[0]
  const summaryHit = probe ? (summaryHits.get(probe) ?? 0) + 1 : 0
  if (probe) summaryHits.set(probe, summaryHit)
  const hitLimit = probe === 'RECEIPT-LIMIT' && summaryHit <= 2
  const empty = probe === 'RECEIPT-EMPTY'
  if (overflowMerge && isSummary && latest.includes('Compress this source independently') && latest.includes('LONG-MERGE:')) {
    overflowMerge = false
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error',
      message: 'This model maximum context length is 16000 tokens, but this request exceeds the context window.' } }))
    return
  }
  if (isSummary && delayReceipt && probe === 'RECEIPT-RESTART-TAIL') await wait(3000)
  if (isSummary && failSummary) {
    failSummary--
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'summary fixture failure' } }))
    return
  }
  if (!isSummary && latest.includes('SLOW-CHILD')) await wait(1700)
  const toolResult = lastContent?.find?.(block => block.type === 'tool_result')
  const resultText = typeof toolResult?.content === 'string' ? toolResult.content : toolResult?.content?.find?.(block => block.type === 'text')?.text
  let result
  try { result = JSON.parse(resultText) } catch {}
  let tool
  let input
  if (!isSummary && !previousTool && latest.startsWith('DISPATCH:')) {
    tool = 'session_tree_send'
    input = { child: latest.match(/DISPATCH:([\w-]+)/)?.[1], message: '请生成插图并交付 assets/sprite.png' }
  }
  if (!isSummary && !previousTool && latest.includes('NATIVE: start native subagent')) {
    tool = 'subagent'
    input = { description: 'Review fixture material', prompt: 'NATIVE-CHILD first task', name: 'native-review' }
  }
  if (!isSummary && !previousTool && latest.includes('CONTINUE-NATIVE:')) {
    tool = 'send_message'
    input = { agent: latest.match(/CONTINUE-NATIVE:([\w-]+)/)?.[1], message: 'NATIVE-CHILD follow-up' }
  }
  const priorCall = messages.findLast(message => message.role === 'assistant' && message.content?.some?.(part => part.type === 'tool_use'))
    ?.content?.find(part => part.type === 'tool_use')
  if (!isSummary && !previousTool && latest.includes('WORKER-ART')) {
    tool = 'write'
    input = { file_path: join(home, 'delegated-art.svg'), content: '<svg xmlns="http://www.w3.org/2000/svg"/>' }
  }
  if (!isSummary && !previousTool && latest.includes('EXECUTOR-WRITE:')) {
    const file = latest.match(/EXECUTOR-WRITE:([\w-]+)/)?.[1]
    if (file) {
      tool = 'write'
      input = { file_path: join(home, file + '.svg'), content: '<svg xmlns="http://www.w3.org/2000/svg"/>' }
    }
  }
  if (!isSummary && !previousTool && action) {
    if (action.includes('ROSTER-FIXTURE')) {
      tool = 'write'
      input = { file_path: join(home, 'parent-write-should-not-exist.svg'), content: '<svg/>' }
    }
    else {
      tool = 'session_tree_create'
      input = action.includes('CREATE-BACKGROUND')
        ? { alias: '背景绘制', responsibility: '制作夜景背景 assets/night.svg' }
        : { alias: '剧本一号', responsibility: '编写下一关的新剧本' }
    }
  }
  if (!isSummary && previousTool && action.includes('ROSTER-FIXTURE') && priorCall?.name === 'write') {
    tool = 'pwsh'
    input = { description: 'Attempt parent shell write', command: "Set-Content -LiteralPath 'parent-shell-should-not-exist.svg' '<svg/>'" }
  }
  if (!isSummary && previousTool && action.includes('ROSTER-FIXTURE') && priorCall?.name === 'pwsh') {
    tool = 'session_tree_list'
    input = {}
  }
  if (!isSummary && previousTool && priorCall?.name === 'session_tree_list' && action.includes('ROSTER-FIXTURE')) {
    const worker = result?.find?.(item => item.alias === '背景美术')
    if (worker) {
      tool = 'session_tree_send'
      input = { child: worker.id, message: 'WORKER-ART 新增夜景背景，交付 delegated-art.svg。沿用已完成剧本。' }
    }
  }
  if (!isSummary && previousTool && priorCall?.name === 'session_tree_create' && result?.id
    && /CREATE-STORY|CREATE-BACKGROUND/.test(action)) {
    tool = 'session_tree_send'
    input = { child: result.id, message: action.includes('CREATE-BACKGROUND') ? '绘制夜景背景 assets/night.svg LOCAL-BRIEF' : '编写下一关的新剧本' }
  }
  if (!isSummary && previousTool && priorCall?.name === 'session_tree_send' && result?.id
    && /ROSTER-FIXTURE|CREATE-STORY|CREATE-BACKGROUND/.test(action)) {
    tool = 'session_tree_result'
    input = { task: result.id, wait: true }
  }
  const tag = latest.includes('生图') ? '生图' : latest.includes('生视频') ? '生视频' : '任务'
  const roleInput = latest.includes('Assign visible child conversation roles.')
  const roleRows = roleInput ? latest.split('\n').filter(line => line.startsWith('{"index":')).flatMap(line => {
    try { return [JSON.parse(line)] } catch { return [] }
  }) : []
  let answer = roleInput ? (invalidRoles ? 'bad role output' : JSON.stringify(roleRows.filter(row => !row.role).map(row => {
    const alias = row.title?.startsWith('立绘原会话') ? '马里奥美术' : row.title?.startsWith('场景原会话') ? '背景美术'
      : row.title?.startsWith('剧本原会话') ? '剧本一号' : `岗位${row.index}`
    return { index: row.index, alias, responsibility: `负责${alias}相关产物` }
  }))) : isSummary ? `摘要 ${tag} [1]，产物 assets/sprite.png` : `完成 ${latest.slice(0, 200)}`
  const flow = messages.findLast(message => /^FLOW-FIXTURE:/m.test(flatten(message)))
  const targets = flow && flatten(flow).match(/^FLOW-FIXTURE:([\w-]+):([\w-]+)/m)
  if (!isSummary && targets && !latest.startsWith('From ') && !latest.includes('This batch of child tasks has settled')) {
    if (!previousTool && /^FLOW-FIXTURE:/m.test(latest)) {
      tool = 'session_tree_send'
      input = { child: targets[1], message: 'RECEIPT-EMPTY-FLOW Produce fixture art.' }
    } else if (previousTool && result?.child === targets[1]) {
      tool = 'session_tree_send'
      input = { child: targets[2], message: 'INTEGRATE-FIXTURE Use the upstream artifact.', after: [result.id] }
    }
  }
  if (!isSummary && latest.includes('RECEIPT-EMPTY-FLOW') && latest.startsWith('From ')) {
    answer = '绘制完成。产物 [新图](E:/fixture/scene-boss.svg)'
      + '\nRECEIPT-EMPTY'
    await wait(1000)
  }
  if (!isSummary && latest === 'CRASH-RECEIPT') {
    answer = 'CRASH-RECEIPT ' + 'continued. '.repeat(2600) + 'RECEIPT-RESTART-TAIL'
  }
  const acceptanceRequest = latest.match(/^ACCEPTANCE-TOOL:(.+)$/m)?.[1]
  if (!isSummary && !previousTool && acceptanceRequest) {
    ({ tool, input } = JSON.parse(acceptanceRequest))
  }
  if (!isSummary && /^From /m.test(latest) && latest.includes('ACCEPTANCE-CHILD-')) {
    const task = latest.match(/Task ID ([\w-]+)/)?.[1]
    const pass = { check: 1, status: 'passed', evidence: 'Verified output [fixture artifact](E:/fixture/accepted.html)' }
    const result = /ACCEPTANCE-CHILD-(?:REVIEW-)?FAIL/.test(latest)
      ? { ...pass, status: 'failed', evidence: 'Missing expected output' } : pass
    if (!previousTool && task) {
      tool = 'session_tree_report'
      input = latest.includes('ACCEPTANCE-CHILD-REVIEW') ? { task, final: [result] }
        : latest.includes('ACCEPTANCE-CHILD-LIGHT') ? { task, local: [result], final: [pass] }
          : { task, local: [result] }
    }
    answer = 'Acceptance fixture checked.'
  }
  const isolated = messages.findLast(message => /#ISOLATED-(?:WORK|BUILD|REVIEW)/.test(flatten(message))
    && /Isolated task directory: /.test(flatten(message)))
  if (!isSummary && isolated && (!previousTool ? latest.includes('#ISOLATED-') : ['write', 'session_tree_report'].includes(priorCall?.name))) {
    const relay = flatten(isolated)
    const task = relay.match(/Task ID ([\w-]+)/)?.[1]
    const folder = relay.match(/^Isolated task directory: (.+)$/m)?.[1]
    const file = relay.includes('#ISOLATED-WORK') ? 'asset.txt' : 'game.html'
    const passed = [{ check: 1, status: 'passed', evidence: 'Fixture completed with current artifacts' }]
    if (!previousTool && relay.includes('#ISOLATED-REVIEW')) {
      tool = 'session_tree_report'
      input = { task, final: passed }
    } else if (!previousTool && folder) {
      tool = 'write'
      input = { file_path: join(folder, file), content: 'new fixture deliverable' }
    } else if (priorCall?.name === 'write' && !toolResult?.is_error) {
      tool = 'session_tree_report'
      input = { task, local: passed, artifacts: [file === 'game.html' ? join(home, 'old-fixture-game.html') : file] }
    } else if (priorCall?.name === 'session_tree_report' && file === 'game.html'
      && typeof resultText === 'string' && resultText.includes('assigned isolated task directory')) {
      tool = 'session_tree_report'
      input = { task, local: passed, artifacts: ['game.html'] }
    }
    answer = 'Isolated fixture settled.'
  }
  Object.assign(observedRequest, { sent: tool, previous: priorCall?.name, action: action.slice(0, 100), result: result ?? resultText })
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const event = (type, detail = {}) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...detail })}\n\n`)
  event('message_start', { message: { id: randomUUID(), type: 'message', role: 'assistant', model: body.model,
    content: [], usage: { input_tokens: 20, output_tokens: 0 } } })
  if (tool) {
    event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_${randomUUID()}`, name: tool, input: {} } })
    event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })
  } else {
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    if (!empty) event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: hitLimit ? '可保留的草稿' : answer } })
  }
  event('content_block_stop', { index: 0 })
  event('message_delta', { delta: { stop_reason: tool ? 'tool_use' : hitLimit ? 'max_tokens' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: hitLimit ? 10000 : 12 } })
  event('message_stop')
  response.end()
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

let host
let browser
let page
let logs = ''
async function start() {
  logs = ''
  const cli = executable.replace(/DeepSeek Harness\.exe$/i, 'resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js')
  const desktop = process.env.SESSION_TREE_TEST_DESKTOP === '1'
  const bundled = executable.replace(/DeepSeek Harness\.exe$/i, 'resources\\app.asar\\dsh')
  const profile = join(home, 'profiles', 'desktop')
  const args = desktop
    ? [cli.replace(/cli\.js$/, 'index.js'), bundled, profile,
      executable.replace(/DeepSeek Harness\.exe$/i, 'resources\\runtime\\primary-runtime')]
    : [cli, '--profile', 'web', '--no-open', '--port', '0']
  host = spawn(executable, ['--expose-internals', ...args], {
    ...(desktop ? { cwd: profile, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] } : {}),
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1',
      ...(desktop ? { DSH_CLIENT_VERSION: '0.2.2-rc.5' } : {}),
      DEEPSEEK_API_KEY: 'session-tree-fixture', DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}` },
  })
  for (const pipe of [host.stdout, host.stderr]) pipe.on('data', chunk => { logs += chunk })
  if (desktop) {
    let ready
    host.on('message', message => { if (message.type === 'ready') ready = message.url })
    return eventually(() => ready, 'desktop host startup')
  }
  return eventually(() => logs.match(/dsh web: (http:\/\/127\.0\.0\.1:[0-9]+\/\?token=\S+)/)?.[1], 'host startup')
}

async function stop() {
  if (!host || host.exitCode !== null || host.signalCode !== null) return
  const done = new Promise(resolve => host.once('exit', resolve))
  host.kill()
  await done
}

async function eventually(check, label, timeout = 15000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const value = await check()
    if (value) return value
    await wait(100)
  }
  throw new Error(`Timed out: ${label}`)
}

const pageErrors = []
try {
  let url = await start()
  browser = await chromium.launch({ executablePath: process.env.SESSION_TREE_BROWSER, headless: true })
  page = await browser.newPage({ viewport: { width: 1440, height: 920 }, locale: 'en-US', reducedMotion: 'reduce', colorScheme: 'dark' })
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') pageErrors.push(message.text())
  })
  await page.goto(url)

  const post = async (path, payload) => {
    const response = await page.request.post(new URL(path, url).href, { data: payload })
    const body = await response.json()
    return { response, body }
  }
  const rpc = async (method, request) => {
    const { body } = await post(`/api/${method}`, { type: 'client-request', rpcId: randomUUID(), method, payload: { args: { request } } })
    assert.equal(body.result?.ok, true, JSON.stringify(body).slice(0, 600))
    return body.result.value
  }
  const snapshot = async () => {
    const response = await page.request.get(new URL('/api/session-tree', url).href)
    assert.equal(response.status(), 200, await response.text())
    return response.json()
  }
  const prompt = (sessionId, text) => rpc('session/prompt', { sessionId, requestId: randomUUID(), mode: 'queue',
    content: [{ type: 'text', text }] })
  const finished = (id, latest) => eventually(async () => (await snapshot()).sessions.some(row => row.id === id && !row.running)
    && observed.some(request => !request.isSummary && request.latest.includes(latest)), latest)
  async function make(title, text) {
    const sessionId = randomUUID()
    assert.equal((await rpc('session/create', { sessionId, cwd: home })).sessionId, sessionId)
    await rpc('session/rename', { sessionId, title })
    await prompt(sessionId, text)
    await finished(sessionId, text.slice(0, 80))
    return sessionId
  }

  const preview = page.getByRole('dialog', { name: 'Preview Notice' })
  if (await preview.isVisible() || await preview.waitFor({ timeout: 2000 }).then(() => true, () => false)) {
    await preview.getByRole('button', { name: 'Continue', exact: true }).click()
  }
  const welcome = page.getByRole('button', { name: 'Add API Key', exact: true })
  if (await welcome.isVisible() || await welcome.waitFor({ timeout: 1500 }).then(() => true, () => false)) {
    await welcome.click()
    await page.getByLabel('API key', { exact: true }).fill('session-tree-fixture')
    await page.getByRole('button', { name: 'Save and continue' }).click()
  }
  const tree = page.locator('[data-sidebar-list-area]').getByRole('tree')
  await tree.waitFor()
  const settingsButton = page.getByRole('button', { name: 'Session Tree settings', exact: true })
  const setNaming = async label => {
    await settingsButton.click()
    const dialog = page.getByRole('dialog', { name: 'Session Tree settings' })
    await dialog.getByRole('radio', { name: label, exact: true }).check()
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
  }
  await eventually(async () => (await snapshot()).preferences.interfaceLocale === 'en', 'initial interface language')
  await setNaming('Chinese')
  assert.equal((await snapshot()).preferences.aliasLanguage, 'zh')
  assert.equal(await page.locator('.dsh-tree-panel').count(), 0)
  const a = await make('生图', '生图：透明立绘，保存到 assets/sprite.png')
  const b = await make('生视频', '生视频：制作 4 秒片头')
  const c = await make('游戏', '把产物放进游戏场景')
  async function expandGroup(name) {
    const group = tree.locator('[data-row-key^="workspace:"]').filter({ has: page.getByText(name, { exact: true }) })
    if (await group.isVisible() && await group.getAttribute('aria-expanded') !== 'true') await group.click()
  }
  await expandGroup('Ungrouped')
  console.log('PASS real plugin loaded, three DSH conversations completed')

  const row = title => tree.locator('[data-row-key^="session:"]').filter({ has: page.getByText(title, { exact: true }) })
  const keyed = id => tree.locator('[data-row-key="session:' + id + '"]')
  const select = async (...titles) => {
    for (const [index, title] of titles.entries()) {
      await row(title).click({ modifiers: ['Control'] })
    }
    await row(titles.at(-1)).click({ button: 'right' })
  }
  const relation = (parent, child) => eventually(async () => (await snapshot()).relations.find(row => row.parent === parent && row.child === child), 'relation')
  const copiedChild = (parent, sourceTitle) => eventually(async () => {
    const state = await snapshot()
    const ids = state.sessions.filter(row => row.title === sourceTitle + ' (Copy)').map(row => row.id)
    return state.relations.find(row => row.parent === parent && ids.includes(row.child))?.child
  }, 'copied ' + sourceTitle)

  async function drag(source, target, { ctrl = false, fraction = 0.5, hint } = {}) {
    await target.scrollIntoViewIfNeeded()
    await source.hover()
    const a = await source.boundingBox()
    const b = await target.boundingBox()
    assert.ok(a && b)
    if (ctrl) await page.keyboard.down('Control')
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
    await page.mouse.down()
    await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2, { steps: 3 })
    await page.mouse.move(b.x + b.width / 2, b.y + b.height * fraction, { steps: 8 })
    await page.mouse.move(b.x + b.width / 2 + 2, b.y + b.height * fraction)
    if (hint) {
      try {
        await eventually(async () => hint.test(await target.getAttribute('data-session-tree-drop-label') ?? ''), 'attachment drop hint', 3000)
      } catch (error) {
        console.error('Drop state', await target.evaluate((element, { a, b, fraction }) => ({
          sourceAtPointer: document.elementFromPoint(a.x + a.width / 2, a.y + a.height / 2)?.closest('[data-row-key]')?.getAttribute('data-row-key'),
          targetAtPointer: document.elementFromPoint(b.x + b.width / 2 + 2, b.y + b.height * fraction)?.closest('[data-row-key]')?.getAttribute('data-row-key'),
          hint: element.getAttribute('data-session-tree-drop-label'),
        }), { a, b, fraction }))
        throw error
      }
    } else if (!ctrl) {
      assert.equal(await target.getAttribute('data-session-tree-drop'), null)
    }
    await page.mouse.up()
    if (ctrl) await page.keyboard.up('Control')
  }
  await row('游戏').click()
  await page.locator(`[data-conversation-session="${c}"]`).waitFor()
  await row('游戏').click({ modifiers: ['Control'] })
  const selected = tree.locator('[data-session-tree-selected]')
  await selected.waitFor()
  assert.equal(await selected.count(), 1)
  assert.notEqual(await row('游戏').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)')
  await row('游戏').click({ modifiers: ['Control'] })
  await selected.waitFor({ state: 'detached' })
  assert.equal(await selected.count(), 0)
  await row('生图').click({ modifiers: ['Control'] })
  await selected.waitFor()
  assert.equal(await row('游戏').getAttribute('data-session-tree-current'), '')
  await row('游戏').click()
  await selected.waitFor({ state: 'detached' })
  assert.equal(await selected.count(), 0)
  await row('游戏').click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Rename/ }).waitFor()
  await page.getByRole('menuitem', { name: 'Create child session' }).waitFor()
  await page.keyboard.press('Escape')
  await drag(row('生图'), row('游戏'), { fraction: 0.49 })
  await eventually(async () => await keyed(a).evaluate((source, targetId) => {
    const target = document.querySelector('[data-row-key="session:' + targetId + '"]')
    return target && !!(source.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING)
  }, c), 'native reorder without attachment')
  assert.equal((await snapshot()).relations.length, 0)
  await row('生图').click({ modifiers: ['Control'] })
  assert.equal(await keyed(a).getAttribute('data-session-tree-selected'), '')
  await drag(row('生图'), row('游戏'), { ctrl: true, fraction: 0.49, hint: /Attach under 游戏/ })
  const gameArt = await copiedChild(c, '生图')
  assert.ok(!(await snapshot()).relations.some(edge => edge.child === a))
  await row('生图').waitFor()
  await eventually(async () => await row('生图 (Copy)').getAttribute('data-session-tree-depth') === '1', 'nested native row')
  await row('游戏').getByRole('button', { name: 'Collapse 游戏' }).click()
  await row('生图 (Copy)').waitFor({ state: 'hidden' })
  await row('游戏').getByRole('button', { name: 'Expand 游戏' }).click()
  await row('生图 (Copy)').waitFor()
  await prompt(c, 'DISPATCH:' + gameArt)
  await eventually(async () => (await snapshot()).receipts.find(receipt => receipt.child === gameArt), 'old parent assignment')
  await page.mouse.move(850, 400)
  await drag(row('游戏'), row('生图 (Copy)'), { ctrl: true, hint: /descendant/ })
  await drag(row('生图 (Copy)'), row('游戏'), { ctrl: true, hint: /already attached/ })
  await drag(row('生图 (Copy)'), row('生视频'), { ctrl: true, hint: /Attach under 生视频/ })
  const confirmCopy = page.getByRole('dialog', { name: 'Confirm attachment' })
  await confirmCopy.getByText(/The copy retains earlier tasks and context recorded in its history/).waitFor()
  await confirmCopy.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.ok(!(await snapshot()).relations.some(edge => edge.parent === b))
  await drag(row('生图 (Copy)'), row('生视频'), { ctrl: true, hint: /Attach under 生视频/ })
  await confirmCopy.getByRole('button', { name: 'Confirm attachment', exact: true }).click()
  const copy = await eventually(async () => (await snapshot()).relations.find(edge => edge.parent === b && edge.parentBusiness), 'copied child')
  await relation(c, gameArt)
  await row('生图 (Copy) (Copy)').click()
  const copiedView = page.locator('[data-conversation-session="' + copy.child + '"]')
  await copiedView.getByText(/透明立绘/).first().waitFor()
  await copiedView.getByText(/Execution requested|请生成插图并交付/).first().waitFor()
  await prompt(b, 'DISPATCH:' + copy.child)
  const copyTask = await eventually(async () => (await snapshot()).tasks.find(task => task.parent === b && task.child === copy.child), 'dispatch to fork')
  await eventually(async () => (await snapshot()).receipts.find(receipt => receipt.taskId === copyTask.id), 'fork receipt')
  const rejected = await post('/api/session-tree', { type: 'attach', parent: gameArt, children: [c], previous: [null] })
  assert.equal(rejected.response.status(), 400)
  await row('生图 (Copy)').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Detach from parent' }).click()
  await eventually(async () => !(await snapshot()).relations.some(row => row.child === gameArt), 'detached')
  console.log('PASS Ctrl selection, native reorder, Ctrl attachment, context warning and cancellation, dispatch and cycle validation')

  await row('游戏').click()
  await select('游戏')
  await page.getByRole('menuitem', { name: 'Create child session' }).click()
  const created = await eventually(async () => (await snapshot()).relations.find(row => row.parent === c && row.parentBusiness), 'new child with summary')
  await page.locator(`[data-conversation-session="${created.child}"]`).waitFor()
  const blankCopy = await post('/api/session-tree', { type: 'attach', parent: b, children: [created.child], previous: [c] })
  assert.equal(blankCopy.response.status(), 200, JSON.stringify(blankCopy.body).slice(0, 500))
  const blankFork = blankCopy.body.snapshot.relations.find(edge => edge.parent === b && edge.child !== copy.child)
  assert.ok(blankFork && blankFork.child !== created.child)
  assert.equal(blankCopy.body.snapshot.sessions.find(row => row.id === blankFork.child).blank, true)
  for (const child of [blankFork.child, copy.child]) {
    assert.equal((await post('/api/session-tree', { type: 'detach', parent: b, child })).response.status(), 200)
  }
  await row('生图').click()
  await select('生图', '生视频')
  await page.locator('[data-session-tree-selected]').first().waitFor()
  assert.equal(await page.locator('[data-session-tree-selected]').count(), 2)
  const selectedCurrent = tree.locator('[data-session-tree-current][data-session-tree-selected]')
  assert.equal(await selectedCurrent.count(), 1)
  assert.equal(await selectedCurrent.evaluate(element => getComputedStyle(element, '::after').width), '3px')
  await page.getByRole('menuitem', { name: /Merge into a new session/ }).click()
  const merged = await eventually(async () => (await snapshot()).merged[0], 'merged sources')
  assert.deepEqual(merged.sources.map(row => row.id).sort(), [a, b].sort())
  assert.notEqual(merged.id, a)
  await page.getByRole('button', { name: '生图 ↗' }).waitFor()
  await prompt(merged.id, 'MERGED-TEST')
  await finished(merged.id, 'MERGED-TEST')
  const mergedInput = observed.find(row => !row.isSummary && row.latest.includes('MERGED-TEST'))
  assert.equal(mergedInput.latest.split('Merged context').length, 2)
  assert.doesNotMatch(mergedInput.latest, /Merge source ·/)
  assert.ok(observed.some(row => row.isSummary && row.latest.includes('Integrate and compress these separate conversation briefs')))
  assert.deepEqual((await snapshot()).sessions.filter(row => [a, b].includes(row.id)).map(row => row.id).sort(), [a, b].sort())
  console.log('PASS new child opens native conversation, merge preserves original IDs and presents sources')

  const long = await make('长会话预算', 'LONG-MERGE:' + '主题甲保留原始要求。'.repeat(2200))
  const short = await make('短会话预算', 'SHORT-MERGE: keep the 4-second intro')
  const oldCalls = observed.length
  overflowMerge = true
  const budgeted = await post('/api/session-tree', { type: 'merge', anchor: short, sources: [short, long] })
  assert.equal(budgeted.response.status(), 200, JSON.stringify(budgeted.body).slice(0, 600))
  assert.ok(!overflowMerge, 'the fixture must exercise provider context rejection')
  const mergeCalls = observed.slice(oldCalls).filter(row => row.isSummary)
  const sourceCalls = mergeCalls.filter(row => row.latest.includes('Compress this source independently'))
  assert.ok(sourceCalls.length >= 3)
  assert.ok(Buffer.byteLength(sourceCalls[1].latest) < Buffer.byteLength(sourceCalls[0].latest))
  assert.match(mergeCalls.at(-1).latest, /SHORT-MERGE/)
  assert.ok(Buffer.byteLength(mergeCalls.at(-1).latest.split('<source-data>\n')[1].split('\n</source-data>')[0]) <= 12000)
  console.log('PASS weighted source budgets, provider overflow retry, and one final merge')

  await select('生图', '生视频')
  await page.getByRole('menuitem', { name: 'Create shared parent session' }).click()
  const pending = await eventually(async () => (await snapshot()).pending[0], 'pending parent')
  await page.locator(`[data-conversation-session="${pending.id}"]`).waitFor()
  assert.equal((await snapshot()).relations.filter(row => row.parent === pending.id && row.childBusiness).length, 0)
  const parentArt = await copiedChild(pending.id, '生图')
  const parentVideo = await copiedChild(pending.id, '生视频')
  assert.deepEqual((await snapshot()).relations.filter(edge => [a, b].includes(edge.child)), [])
  const promptText = '你把他们整合进游戏 FIRST-GOAL'
  failSummary = 3
  const composer = page.locator('[data-composer-input][contenteditable="true"]').first()
  await composer.fill(promptText)
  await composer.press('Enter')
  await page.getByRole('button', { name: 'Retry saved project task' }).waitFor()
  await page.getByRole('button', { name: 'Retry saved project task' }).click()
  await finished(pending.id, 'FIRST-GOAL')
  assert.equal(observed.filter(row => !row.isSummary && row.latest.includes('FIRST-GOAL')).length, 1)
  const parentInput = observed.find(row => !row.isSummary && row.latest.includes('FIRST-GOAL'))
  assert.match(JSON.stringify(parentInput.body.messages), /生图/)
  assert.match(JSON.stringify(parentInput.body.messages), /生视频/)
  console.log('PASS shared parent defers summaries, preserves and retries first prompt exactly once')

  await prompt(parentArt, 'SLOW-CHILD：更新生图')
  await eventually(() => observed.find(row => !row.isSummary && JSON.stringify(row.body.messages).includes('SLOW-CHILD')), 'child working')
  await prompt(pending.id, `DISPATCH:${parentArt}`)
  const task = await eventually(async () => (await snapshot()).tasks.find(task => task.child === parentArt), 'task queued')
  assert.ok(['waiting', 'sending', 'queued', 'running'].includes(task.status))
  await eventually(async () => (await snapshot()).receipts.find(receipt => receipt.taskId === task.id), 'delegated receipt')
  const dispatched = observed.find(row => !row.isSummary && row.latest.includes(`From Shared Parent Session [${pending.id}]`)
    && row.latest.includes('请生成插图并交付'))
  assert.ok(dispatched)
  assert.match(dispatched.latest, /From Shared Parent Session/)
  assert.doesNotMatch(JSON.stringify(dispatched.body.messages), /生视频：制作 4 秒片头/)
  await keyed(parentArt).click()
  const childView = page.locator(`[data-conversation-session="${parentArt}"]`)
  await childView.waitFor()
  await childView.getByText(/请生成插图并交付 assets\/sprite.png/).first().waitFor()
  await keyed(parentArt).getByRole('button', { name: 'Collaboration log for 生图 (Copy)' }).click()
  const dispatchLog = page.getByRole('region', { name: 'Collaboration log' })
  await dispatchLog.getByText(/From Shared Parent Session/).click()
  await dispatchLog.getByText('请生成插图并交付 assets/sprite.png', { exact: true }).waitFor()
  await eventually(() => observed.some(row => !row.isSummary && row.latest.includes('This batch of child tasks has settled')
    && row.latest.includes(task.id)), 'one continuation after dispatch')
  await eventually(async () => !(await snapshot()).sessions.find(row => row.id === pending.id)?.running, 'parent ready after continuation')
  const calls = observed.length
  await prompt(parentVideo, 'DIRECT-VIDEO：更新片头')
  await eventually(async () => (await snapshot()).receipts.find(receipt => receipt.parent === pending.id && receipt.child === parentVideo), 'direct receipt')
  await wait(400)
  assert.equal(observed.slice(calls).filter(row => !row.isSummary).length, 1)
  await prompt(pending.id, 'READ-RECEIPTS')
  await finished(pending.id, 'READ-RECEIPTS')
  assert.match(JSON.stringify(observed.find(row => !row.isSummary && row.latest.includes('READ-RECEIPTS')).body.messages), /Child session .* · Turn/)
  console.log('PASS queued native dispatch, child isolation, one receipt and idle parent')

  await prompt(parentVideo, 'RECEIPT-LIMIT')
  const compressed = await eventually(async () => (await snapshot()).receipts.find(row =>
    row.child === parentVideo && row.output?.includes('RECEIPT-LIMIT') && row.summary?.status === 'completed'), 'recompressed raw receipt')
  assert.deepEqual(compressed.summary.attempts.map(row => row.category), ['output-limit', 'output-limit'])
  assert.ok(compressed.summary.attempts.every(row => row.limit === 10000 && row.outputTokens === 10000))
  assert.ok(observed.some(row => row.isSummary && row.latest.includes('RECEIPT-LIMIT')
    && row.latest.includes('8000 tokens') && row.body.max_tokens === 10000))
  await prompt(pending.id, 'FLOW-FIXTURE:' + parentArt + ':' + parentVideo)
  const upstream = await eventually(async () => (await snapshot()).tasks.find(row => row.text.startsWith('RECEIPT-EMPTY-FLOW')), 'upstream task')
  const downstream = await eventually(async () => (await snapshot()).tasks.find(row => row.after?.includes(upstream.id)), 'waiting dependency')
  const rawFallback = await eventually(async () => (await snapshot()).receipts.find(row => row.taskId === upstream.id
    && row.summary?.status === 'failed'), 'raw fallback after empty responses')
  assert.equal(rawFallback.status, 'completed')
  assert.ok(rawFallback.summary.attempts.length === 3 && rawFallback.summary.attempts.every(row => row.category === 'empty'))
  assert.ok(rawFallback.artifacts.includes('E:/fixture/scene-boss.svg'))
  await eventually(() => observed.some(row => !row.isSummary && row.latest.startsWith('From ')
    && row.latest.includes('INTEGRATE-FIXTURE') && row.latest.includes('E:/fixture/scene-boss.svg')), 'raw artifact sent to downstream')
  await eventually(() => observed.some(row => !row.isSummary && row.latest.includes('This batch of child tasks has settled')
    && row.latest.includes(downstream.id)), 'dependency completion wakes parent')
  assert.equal(observed.filter(row => !row.isSummary && row.latest.includes('This batch of child tasks has settled')
    && row.latest.includes(downstream.id)).length, 1)
  console.log('PASS 10000-token cap, recompression, raw fallback, dependency and automatic continuation')

  const ordinary = await make('普通 DSH 会话', 'Standalone native-agent fixture')
  await prompt(ordinary, 'NATIVE: start native subagent')
  await eventually(() => observed.some(row => !row.isSummary && row.latest.includes('NATIVE-CHILD first task')), 'native spawn')
  assert.ok(observed.find(row => !row.isSummary && row.latest.includes('NATIVE-CHILD first task')).body.tools
    .every(tool => !tool.name.startsWith('session_tree_')))
  await eventually(async () => (await snapshot()).sessions.some(row => row.id === ordinary && !row.running), 'native parent idle')
  await prompt(ordinary, 'CONTINUE-NATIVE:native-review')
  await eventually(() => observed.some(row => !row.isSummary && row.latest.includes('NATIVE-CHILD follow-up')), 'native continuation')
  console.log('PASS native subagent created and continued independently')

  delayReceipt = true
  const priorReceipts = (await snapshot()).receipts.filter(row => row.parent === pending.id && row.child === parentVideo).length
  await prompt(parentVideo, 'CRASH-RECEIPT')
  await eventually(() => observed.some(row => row.isSummary && row.latest.includes('RECEIPT-RESTART-TAIL')), 'durable turn awaiting second summary page')
  const checkpoint = (await snapshot()).receipts.find(row => row.child === parentVideo && row.output?.startsWith('CRASH-RECEIPT'))
  assert.ok(checkpoint.summary.offset > 0)
  assert.ok(checkpoint.summary.text)
  await stop()
  delayReceipt = false
  url = await start()
  await page.goto(url)
  await tree.waitFor()
  await expandGroup(home.split(/[\\/]/).at(-1))
  await relation(pending.id, parentArt)
  await eventually(async () => (await snapshot()).receipts.filter(row => row.parent === pending.id && row.child === parentVideo).length
    === priorReceipts + 1, 'durable receipt recovered')
  await eventually(async () => (await snapshot()).receipts.find(row => row.id === checkpoint.id)?.summary?.status === 'completed',
    'resume remaining summary pages')
  assert.equal((await snapshot()).receipts.filter(row => row.taskId === task.id).length, 1)
  console.log('PASS persisted originals, recovery of missing receipt and deduplication after hard restart')

  await row('Shared Parent Session').click()
  await row('Shared Parent Session').getByRole('button', { name: 'Collaboration log for Shared Parent Session' }).click()
  await page.getByRole('region', { name: 'Collaboration log' }).waitFor()
  if (process.env.SESSION_TREE_SCREENSHOT) await page.screenshot({ path: process.env.SESSION_TREE_SCREENSHOT })

  await row('Shared Parent Session').click({ button: 'right' })
  await page.getByRole('menuitem', { name: /^Archive( session)?$/ }).click()
  await eventually(async () => {
    const state = await snapshot()
    return state.sessions.some(row => row.id === pending.id && row.archived)
      && !state.relations.some(edge => edge.parent === pending.id || edge.child === pending.id)
  }, 'archive frees original child rows')
  const stateFile = join(home, 'session-tree', 'state.json')
  await eventually(async () => !(JSON.parse(await readFile(stateFile, 'utf8')).relations.some(edge => edge.parent === pending.id)), 'archive persists detach')
  const d = await make('新挂载目标', '另一个项目会话')
  await expandGroup('Ungrouped')
  const more = tree.getByRole('button', { name: /Show \d+ more sessions/ }).first()
  while (!(await keyed(a).isVisible()) && await more.isVisible()) await more.click()
  await keyed(a).click()
  await drag(row('生图'), row('新挂载目标'), { ctrl: true, hint: /Attach under 新挂载目标/ })
  const reattached = await copiedChild(d, '生图')
  await tree.locator('[data-row-key="session:' + reattached + '"]').click({ button: 'right' })
  await page.getByRole('menuitem', { name: /^Archive( session)?$/ }).click()
  await eventually(async () => !(JSON.parse(await readFile(stateFile, 'utf8')).relations.some(edge => edge.child === reattached)), 'archived child detaches')

  await stop()
  const legacy = JSON.parse(await readFile(stateFile, 'utf8'))
  delete legacy.savedFirst
  delete legacy.colors
  legacy.relations.push({ id: randomUUID(), parent: pending.id, child: b, since: 1 })
  legacy.pending[pending.id] = { first: { id: randomUUID(), role: 'user', content: [{ type: 'text', text: '旧版首条总任务' }], source: { kind: 'user' } } }
  await writeFile(stateFile, JSON.stringify(legacy))
  url = await start()
  await page.goto(url)
  await tree.waitFor()
  const restored = await snapshot()
  assert.ok(!restored.relations.some(edge => edge.parent === pending.id || edge.child === b))
  assert.match(restored.colors[b].value, /^#[0-9a-f]{6}$/)
  assert.equal(restored.colors[b].value, restored.colors[pending.id].value)
  assert.equal(restored.savedFirst.find(item => item.id === pending.id)?.text, '旧版首条总任务')
  assert.ok(!restored.pending.some(item => item.id === pending.id))
  assert.equal(restored.receipts.filter(item => item.taskId === task.id).length, 1)
  await page.getByRole('button', { name: 'View options' }).click()
  await page.getByText('All conversations (show archived)', { exact: true }).click()
  await expandGroup(home.split(/[\\/]/).at(-1))
  await row('Shared Parent Session').getByRole('button', { name: 'Session color for Shared Parent Session' }).waitFor()
  await row('Shared Parent Session').getByRole('button', { name: 'Collaboration log for Shared Parent Session' }).click()
  await page.getByText('Saved first project task', { exact: true }).click()
  await page.getByText('旧版首条总任务', { exact: true }).waitFor()
  await row('Shared Parent Session').click({ button: 'right' })
  await page.getByRole('menuitem', { name: /^Unarchive( session)?$/ }).click()
  await eventually(async () => {
    const state = await snapshot()
    return state.sessions.some(row => row.id === pending.id && !row.archived)
      && !state.relations.some(edge => edge.parent === pending.id)
  }, 'unarchive leaves old relations detached')
  console.log('PASS parent and child archive, copy after detach, startup cleanup of legacy relations and preserved receipts/draft')

  const coordinator = await make('游戏整合', 'UPSTREAM-ONLY Start with the completed story and existing artwork.')
  const artOriginal = await make('立绘原会话', '马里奥立绘与角色精灵 assets/mario.svg')
  const sceneryOriginal = await make('场景原会话', '负责背景绘制，已有白天背景 assets/day.svg')
  const storyOriginal = await make('剧本原会话', '已完成第一关剧本 assets/story.md')
  const attach = await post('/api/session-tree', { type: 'attach', parent: coordinator,
    children: [artOriginal, sceneryOriginal, storyOriginal], previous: [null, null, null] })
  assert.equal(attach.response.status(), 200)
  const art = await copiedChild(coordinator, '立绘原会话')
  const scenery = await copiedChild(coordinator, '场景原会话')
  const story = await copiedChild(coordinator, '剧本原会话')
  await eventually(async () => (await snapshot()).relations.filter(r => r.parent === coordinator && r.role).length === 3, 'named art and story roles')
  const aliases = Object.fromEntries((await snapshot()).relations.filter(r => r.parent === coordinator).map(r => [r.child, r.role.alias]))
  assert.deepEqual(aliases, { [art]: '马里奥美术', [scenery]: '背景美术', [story]: '剧本一号' })

  const callsBeforeArtwork = observed.length
  await prompt(coordinator, 'ROSTER-FIXTURE Reuse the finished character art and story. Delegate only drawing a fresh night background.')
  const artTask = await eventually(async () => (await snapshot()).tasks.find(t => t.parent === coordinator && t.child === scenery), 'route work by alias')
  await eventually(async () => (await snapshot()).receipts.find(r => r.taskId === artTask.id), 'art receipt')
  assert.deepEqual((await snapshot()).tasks.filter(t => t.parent === coordinator).map(t => t.child), [scenery])
  const rosterTurn = observed.find((r, index) => index >= callsBeforeArtwork && !r.isSummary && r.sent === 'write')
  const instructions = [rosterTurn.body.system, ...rosterTurn.body.messages.filter(m => m.role === 'system').map(m => m.content)]
  assert.ok(JSON.stringify(instructions).includes('must delegate all new production work'), 'parent receives mandatory delegation policy')
  await eventually(async () => !(await snapshot()).sessions.find(r => r.id === coordinator)?.running, 'coordinator idle')
  assert.ok(observed.some(r => r.body.messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool_use' && b.name === 'session_tree_result'))))
  const artRun = observed.slice(callsBeforeArtwork)
  for (const next of ['pwsh', 'session_tree_list']) {
    assert.match(JSON.stringify(artRun.find(r => r.sent === next)?.result), /The parent session coordinates work/)
  }
  await assert.rejects(readFile(join(home, 'parent-write-should-not-exist.svg')), { code: 'ENOENT' })
  await assert.rejects(readFile(join(home, 'parent-shell-should-not-exist.svg')), { code: 'ENOENT' })
  assert.match(await readFile(join(home, 'delegated-art.svg'), 'utf8'), /<svg/)
  console.log('PASS parent write and PowerShell blocked, existing child writes the new SVG')

  assert.equal((await post('/api/session-tree', { type: 'detach', parent: coordinator, child: story })).response.status(), 200)
  await prompt(coordinator, 'CREATE-STORY Need a fresh story for the next level.')
  const newStory = await eventually(async () => (await snapshot()).relations.find(r => r.parent === coordinator && r.role?.alias === '剧本一号'), 'created story role')
  assert.notEqual(newStory.child, story)
  const storyTask = await eventually(async () => (await snapshot()).tasks.find(t => t.child === newStory.child && t.parent === coordinator), 'dispatch new story')
  await eventually(async () => (await snapshot()).receipts.find(r => r.taskId === storyTask.id), 'new story receipt')
  await eventually(async () => !(await snapshot()).sessions.find(r => r.id === coordinator)?.running, 'story handoff idle')
  await prompt(coordinator, 'RETRY-STORY Reuse creation of the same story role.')
  await finished(coordinator, 'RETRY-STORY')
  assert.deepEqual((await snapshot()).relations.filter(r => r.parent === coordinator && r.role?.alias.startsWith('剧本一号')).map(r => r.child), [newStory.child])

  const beforeNative = observed.length
  await prompt(scenery, 'NATIVE: start native subagent')
  await finished(scenery, 'NATIVE: start native subagent')
  assert.ok(observed.slice(beforeNative).some(r => JSON.stringify(r.body.messages).includes('This session uses visible child sessions')))
  assert.ok(!observed.slice(beforeNative).some(r => !r.isSummary && r.latest.includes('NATIVE-CHILD first task')))

  const beforeAssistant = observed.find(r => !r.isSummary && r.latest.includes('WORKER-ART'))
  const systemText = (request, phrase) => [request.body.system,
    ...request.body.messages.filter(m => m.role === 'system').map(m => m.content)]
    .map(item => JSON.stringify(item)).findLast(item => item?.includes(phrase))
  const executorMarker = 'You are an executor for your direct parent.'
  assert.ok(systemText(beforeAssistant, executorMarker))
  assert.ok(JSON.stringify(beforeAssistant.body.messages).includes('Project role'))
  for (const name of ['session_tree_list', 'session_tree_send', 'session_tree_create', 'session_tree_result']) {
    assert.ok(beforeAssistant.body.tools.some(tool => tool.name === name), name)
  }

  const nestedPrompt = 'CREATE-BACKGROUND Coordinate a separate background drawing from this session.'
  await prompt(scenery, nestedPrompt)
  const painter = await eventually(async () => (await snapshot()).relations.find(r => r.parent === scenery && r.role?.alias === '背景绘制'), 'nested child created')
  const paintTask = await eventually(async () => (await snapshot()).tasks.find(t => t.parent === scenery && t.child === painter.child), 'grandchild dispatch')
  await eventually(async () => (await snapshot()).receipts.find(r => r.taskId === paintTask.id && r.parent === scenery), 'grandchild receipt')
  const leafRequest = observed.find(r => !r.isSummary && r.latest.includes('LOCAL-BRIEF') && r.latest.includes(`From 场景原会话 (Copy) [${scenery}]`))
  assert.ok(leafRequest)
  assert.doesNotMatch(JSON.stringify(leafRequest.body.messages), /UPSTREAM-ONLY|assets\/story.md|assets\/mario.svg/)
  assert.ok(!(await snapshot()).receipts.some(r => r.child === painter.child && r.parent === coordinator))
  await eventually(async () => (await snapshot()).receipts.some(r => r.child === scenery && r.parent === coordinator
    && !r.taskId && r.status === 'completed'), 'middle-layer report to root')
  await prompt(scenery, 'EXECUTOR-WRITE:middle-layer')
  await finished(scenery, 'EXECUTOR-WRITE:middle-layer')
  const afterAssistant = observed.find(r => !r.isSummary && r.latest.includes('EXECUTOR-WRITE:middle-layer'))
  assert.equal(systemText(afterAssistant, executorMarker), systemText(beforeAssistant, executorMarker))
  assert.deepEqual(afterAssistant.body.tools, beforeAssistant.body.tools)
  assert.equal((await snapshot()).relations.find(r => r.child === scenery).role.alias, '背景美术')
  assert.match(await readFile(join(home, 'middle-layer.svg'), 'utf8'), /<svg/)
  console.log('PASS stable executor role/tool schemas, onward dispatch, one-hop receipts and middle-layer write')

  const cycles = await post('/api/session-tree', { type: 'attach', parent: painter.child, children: [coordinator], previous: [null] })
  assert.equal(cycles.response.status(), 400)
  assert.match(cycles.body.error, /descendant/)
  await expandGroup('Ungrouped')
  await keyed(coordinator).click()
  await eventually(async () => await keyed(painter.child).getAttribute('data-session-tree-depth') === '2', 'grandchild indentation')
  await keyed(coordinator).getByRole('button', { name: 'Collapse 游戏整合' }).click()
  await keyed(painter.child).waitFor({ state: 'hidden' })
  await keyed(coordinator).getByRole('button', { name: 'Expand 游戏整合' }).click()
  await keyed(painter.child).click()
  await page.locator(`[data-conversation-session="${painter.child}"]`).waitFor()
  await page.locator('[data-composer-input][contenteditable="true"]').first().waitFor({ state: 'visible' })
  await keyed(coordinator).click()
  await keyed(coordinator).getByRole('button', { name: 'Collaboration log for 游戏整合' }).click()
  await page.getByRole('button', { name: '背景美术 ↗' }).waitFor()

  const dot = id => keyed(id).locator('.dsh-tree-color-mark')
  const palette = page.getByRole('dialog', { name: /Session color/ })
  const projectNodes = [coordinator, scenery, painter.child, art, newStory.child]
  const initialColor = (await snapshot()).colors[coordinator].value
  await eventually(async () => await dot(painter.child).getAttribute('title') === 'Session color ' + initialColor, 'inherited color dot')
  await dot(painter.child).click()
  assert.equal(await palette.getByRole('group', { name: 'Preset colors' }).getByRole('button').count(), 28)
  await palette.getByRole('textbox', { name: 'Hex color value' }).fill('#3b317e')
  await palette.getByRole('button', { name: 'Save session color' }).click()
  await palette.waitFor({ state: 'hidden' })
  assert.equal((await snapshot()).colors[art].value, initialColor)
  await dot(coordinator).click()
  const rootColor = initialColor === '#4abec3' ? '#f38b5e' : '#4abec3'
  await palette.getByRole('button', { name: rootColor, exact: true }).click()
  await palette.getByRole('button', { name: 'Save root color' }).click()
  await palette.waitFor({ state: 'hidden' })
  const changedColors = (await snapshot()).colors
  assert.equal(changedColors[painter.child].value, '#3b317e')
  assert.equal(changedColors[scenery].value, rootColor)
  await dot(painter.child).click()
  await palette.getByRole('button', { name: 'Apply to entire tree' }).click()
  await palette.waitFor({ state: 'hidden' })
  const unifiedColors = (await snapshot()).colors
  assert.ok(projectNodes.every(id => unifiedColors[id].value === '#3b317e' && !unifiedColors[id].custom))

  const otherParent = await make('第二个来源父会话', 'A second coordinator.')
  const copyTarget = await make('目标项目', 'Receive independent branches.')
  assert.equal((await post('/api/session-tree', { type: 'attach', parent: otherParent, children: [artOriginal], previous: [null] })).response.status(), 200)
  const otherChild = await copiedChild(otherParent, '立绘原会话')
  await expandGroup('Ungrouped')
  const showMore = tree.getByRole('button', { name: /Show \d+ more sessions/ }).last()
  while (!(await keyed(coordinator).isVisible()) && await showMore.isVisible()) await showMore.click()
  await keyed(coordinator).click()
  await keyed(otherParent).click({ modifiers: ['Control'] })
  await keyed(art).click({ modifiers: ['Control'] })
  const foldRoot = keyed(coordinator).getByRole('button', { name: 'Collapse 游戏整合' })
  await foldRoot.click()
  await keyed(coordinator).click({ modifiers: ['Shift'] })
  await keyed(coordinator).getByRole('button', { name: 'Expand 游戏整合' }).click()
  for (const id of [otherParent, coordinator, art, scenery, painter.child, newStory.child]) {
    assert.equal(await keyed(id).getAttribute('data-session-tree-selected'), '', id)
  }
  await keyed(coordinator).click({ modifiers: ['Shift'] })
  assert.equal(await keyed(otherParent).getAttribute('data-session-tree-selected'), '')
  assert.equal(await tree.locator('[data-session-tree-selected]').count(), 1)
  await keyed(copyTarget).click()
  const warning = page.getByRole('dialog', { name: 'Confirm attachment' })
  const omitted = warning.getByText(/This attachment omits the child sessions/)
  const inherited = warning.getByText(/The copy retains earlier tasks and context/)
  const cancelWarning = () => warning.getByRole('button', { name: 'Cancel', exact: true }).click()
  await drag(keyed(coordinator), keyed(copyTarget), { ctrl: true, hint: /Attach under 目标项目/ })
  await omitted.waitFor()
  assert.equal(await inherited.count(), 0)
  await cancelWarning()
  await drag(keyed(scenery), keyed(copyTarget), { ctrl: true, hint: /Attach under 目标项目/ })
  await omitted.waitFor()
  await inherited.waitFor()
  await cancelWarning()
  for (const id of [coordinator, otherParent]) await keyed(id).click({ modifiers: ['Control'] })
  await drag(keyed(coordinator), keyed(copyTarget), { ctrl: true, hint: /Attach under 目标项目/ })
  await omitted.waitFor()
  await cancelWarning()
  assert.equal((await snapshot()).relations.filter(r => r.parent === copyTarget).length, 0)
  await keyed(painter.child).click({ modifiers: ['Control'] })
  await drag(keyed(coordinator), keyed(copyTarget), { ctrl: true, hint: /Attach under 目标项目/ })
  await inherited.waitFor()
  assert.equal(await omitted.count(), 0)
  await warning.getByRole('button', { name: 'Confirm attachment', exact: true }).click()
  const rootCopy = await copiedChild(copyTarget, '游戏整合')
  const otherCopy = await copiedChild(copyTarget, '第二个来源父会话')
  const assistantCopy = await copiedChild(rootCopy, '背景绘制')
  assert.notEqual(assistantCopy, painter.child)
  const copiedColors = (await snapshot()).colors
  assert.ok([rootCopy, otherCopy, assistantCopy].every(id => copiedColors[id].value === copiedColors[copyTarget].value))
  assert.equal(copiedColors[painter.child].value, '#3b317e')
  assert.deepEqual((await snapshot()).relations.filter(r => r.parent === rootCopy).map(r => r.child), [assistantCopy])
  assert.ok(!(await snapshot()).relations.some(r => r.parent === otherCopy))
  await relation(scenery, painter.child)
  await relation(otherParent, otherChild)
  await relation(coordinator, scenery)
  await keyed(rootCopy).click()
  await page.locator('[data-conversation-session="' + rootCopy + '"]').getByText(/Start with the completed story and existing artwork/).first().waitFor()
  await prompt(rootCopy, 'EXECUTOR-WRITE:copied-root')
  await finished(rootCopy, 'EXECUTOR-WRITE:copied-root')
  const copiedRun = observed.find(r => !r.isSummary && r.latest.includes('EXECUTOR-WRITE:copied-root'))
  assert.ok(systemText(copiedRun, executorMarker))
  assert.match(await readFile(join(home, 'copied-root.svg'), 'utf8'), /<svg/)
  console.log('PASS branch selection, copy warnings, nearest selected ancestor, intact originals and copied-root execution')

  await stop()
  const oldRoster = JSON.parse(await readFile(stateFile, 'utf8'))
  delete oldRoster.relations.find(r => r.child === art).role
  await writeFile(stateFile, JSON.stringify(oldRoster))
  url = await start()
  await page.goto(url)
  await tree.waitFor()
  const restartedColors = (await snapshot()).colors
  assert.ok(projectNodes.every(id => restartedColors[id].value === '#3b317e'))
  assert.equal((await snapshot()).relations.find(r => r.child === painter.child)?.role?.alias, '背景绘制')
  invalidRoles = true
  await prompt(coordinator, 'BACKFILL-FIXTURE Resume with one legacy unnamed artist.')
  await finished(coordinator, 'BACKFILL-FIXTURE')
  invalidRoles = false
  assert.equal((await snapshot()).relations.find(r => r.child === art)?.role?.alias, '立绘原会话 (Copy)')
  await expandGroup('Ungrouped')
  await keyed(coordinator).click({ button: 'right' })
  await page.getByRole('menuitem', { name: /^Archive( session)?$/ }).click()
  await eventually(async () => {
    const state = await snapshot()
    return !state.relations.some(r => r.parent === coordinator) && state.relations.some(r => r.parent === scenery && r.child === painter.child)
  }, 'archive preserves the detached branch')
  const archivedColors = (await snapshot()).colors
  assert.ok(projectNodes.every(id => archivedColors[id].value === '#3b317e'))
  assert.equal((await post('/api/session-tree', { type: 'color', id: art, value: 'transparent', unify: false })).response.status(), 400)
  await eventually(async () => await dot(scenery).getAttribute('title') === 'Session color #3b317e', 'color dot survives branch archive')
  console.log('PASS color palette, isolated override, root propagation, branch unification, copy, migration, archive and restart')
  console.log('PASS role-based roster, create/retry, native delegation guard, three levels, one-hop context and receipts, restart, legacy fallback and branch archive')

  const recycleTitle = '回收站验收会话'
  const removed = await make(recycleTitle, 'RECYCLE-FIXTURE disposable conversation')
  const kept = await make('回收验收子会话', 'KEEP-FIXTURE keep the source')
  assert.equal((await post('/api/session-tree', { type: 'attach', parent: removed, children: [kept], previous: [null] })).response.status(), 200)
  const keptCopy = await copiedChild(removed, '回收验收子会话')
  await expandGroup('Ungrouped')
  await keyed(removed).click()
  await keyed(removed).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Move to Recycle Bin' }).click()
  const recycleDialog = page.getByRole('dialog', { name: 'Delete sessions' })
  await recycleDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.ok((await snapshot()).sessions.some(row => row.id === removed))
  await keyed(removed).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Move to Recycle Bin' }).click()
  const recycleResponse = page.waitForResponse(response => response.url().includes('/api/session-tree')
    && response.request().method() === 'POST' && response.request().postDataJSON()?.type === 'recycle')
  await recycleDialog.getByRole('button', { name: 'Move to Recycle Bin', exact: true }).click()
  const recycled = await recycleResponse
  assert.ok(recycled.ok(), await recycled.text())
  await page.getByText('Session moved to the Recycle Bin.', { exact: true }).waitFor({ timeout: 18000 })
  await keyed(removed).waitFor({ state: 'detached' })
  const afterRecycle = await snapshot()
  assert.ok(!afterRecycle.sessions.some(row => row.id === removed))
  assert.ok(!afterRecycle.relations.some(edge => edge.parent === removed || edge.child === removed))
  assert.ok([kept, keptCopy].every(id => afterRecycle.sessions.some(row => row.id === id)))
  const roots = await readdir(join(home, 'sessions'), { recursive: true })
  assert.ok(!roots.some(path => path.split(/[\\/]/).includes(removed)))
  const trash = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', [
    '$bin = (New-Object -ComObject Shell.Application).Namespace(10)',
    '$item = $bin.Items() | Where-Object Name -eq $env:DSH_RECYCLED_FIXTURE | Select-Object -First 1',
    'if ($null -eq $item) { exit 1 }',
  ].join('\n')], { windowsHide: true, env: { ...process.env, DSH_RECYCLED_FIXTURE: removed } })
  assert.ok(trash)
  await stop()
  url = await start()
  await page.goto(url)
  await tree.waitFor()
  assert.ok(!(await snapshot()).sessions.some(row => row.id === removed))
  console.log('PASS recycle dialog, live deletion, detached surviving child, disk removal and restart')

  const batchA = await make('Batch Recycle A', 'Recycle only selected fixture A')
  const batchB = await make('Batch Recycle B', 'Recycle only selected fixture B')
  await expandGroup('Ungrouped')
  for (const id of [batchA, batchB]) await keyed(id).click({ modifiers: ['Control'] })
  await keyed(batchA).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Move to Recycle Bin (2)', exact: true }).click()
  await recycleDialog.getByText(/Move 2 selected sessions to the Recycle Bin/).waitFor()
  await recycleDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.ok((await snapshot()).sessions.some(row => row.id === batchB))
  await keyed(batchA).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Move to Recycle Bin (2)', exact: true }).click()
  const batchResponse = page.waitForResponse(response => response.url().includes('/api/session-tree')
    && response.request().method() === 'POST' && response.request().postDataJSON()?.type === 'recycle-batch')
  await recycleDialog.getByRole('button', { name: 'Move to Recycle Bin', exact: true }).click()
  const batchResult = await (await batchResponse).json()
  assert.deepEqual(new Set(batchResult.recycle.recycled), new Set([batchA, batchB]))
  assert.deepEqual(batchResult.recycle.failed, [])
  assert.ok(batchResult.snapshot.sessions.some(row => row.id === kept))
  console.log('PASS multi-select Recycle Bin confirmation, cancellation and selected removal')

  const blankSource = await make('坦克绘制验收', 'Draw the tank sprite.')
  await expandGroup('Ungrouped')
  await keyed(blankSource).click()
  await page.getByRole('button', { name: /^New Session\b/i }).first().click()
  const blankTarget = await eventually(async () => {
    const current = tree.locator('[data-session-tree-current]').first()
    const rowKey = await current.getAttribute('data-row-key', { timeout: 1000 }).catch(() => null)
    const id = rowKey?.slice('session:'.length)
    return id && (await snapshot()).sessions.find(row => row.id === id && row.blank && row.cwd)
  }, 'blank conversation in a workspace')
  if (!(await keyed(blankSource).isVisible())) await expandGroup('Ungrouped')
  await drag(keyed(blankSource), keyed(blankTarget.id), { ctrl: true, hint: /Attach under/ })
  const tankCopy = await copiedChild(blankTarget.id, '坦克绘制验收')
  assert.notEqual(tankCopy, blankSource)
  assert.ok(!(await snapshot()).relations.some(row => row.child === blankSource))
  await keyed(tankCopy).waitFor()
  await keyed(blankTarget.id).click()
  await page.locator('[data-composer-input][contenteditable="true"]').first().waitFor({ state: 'visible' })
  console.log('PASS Ctrl drag to a blank conversation without sending a first prompt')

  const acceptanceParent = blankTarget.id
  const acceptanceTool = async (toolName, args) => {
    const request = 'ACCEPTANCE-TOOL:' + JSON.stringify({ tool: toolName, input: args })
    const startAt = observed.length
    await prompt(acceptanceParent, request)
    const response = await eventually(() => {
      const sent = observed.findIndex((row, index) => index >= startAt && row.sent === toolName && row.latest.includes(request))
      if (sent !== -1) return observed.slice(sent + 1).find(row => row.previous === toolName && row.result !== undefined)
    }, 'acceptance tool result: ' + toolName)
    await finished(acceptanceParent, request)
    return response.result
  }
  const light = await acceptanceTool('session_tree_plan', { workspace: 'existing', objective: 'Reuse existing art for one playable room',
    depth: 'light', checks: ['Playable room goes from start to ending'] })
  assert.ok(light.id, JSON.stringify(light))
  const lightweight = await acceptanceTool('session_tree_send', { project: light.id, child: tankCopy,
    phase: 'integration', checks: ['Existing room asset loads'], message: 'ACCEPTANCE-CHILD-LIGHT Reuse current material' })
  assert.ok(lightweight.id, JSON.stringify(lightweight))
  const receiptFor = id => eventually(async () => (await snapshot()).receipts.find(row => row.taskId === id), 'receipt ' + id)
  const lightReceipt = await receiptFor(lightweight.id)
  assert.equal(lightReceipt.acceptance?.local?.[0]?.status, 'passed')
  assert.equal(lightReceipt.acceptance?.final?.[0]?.status, 'passed')
  assert.ok(lightReceipt.artifacts.includes('E:/fixture/accepted.html'))
  const lightConfirmed = await acceptanceTool('session_tree_accept', { project: light.id, proof: lightweight.id })
  assert.equal(lightConfirmed.acceptedBy, lightweight.id)
  assert.equal((await snapshot()).tasks.filter(row => row.acceptance?.project === light.id).length, 1)
  await keyed(acceptanceParent).click()
  await keyed(acceptanceParent).getByRole('button', { name: /Collaboration log for/ }).click()
  await page.getByText('Project acceptance · Light · Passed', { exact: true }).waitFor()

  const thorough = await acceptanceTool('session_tree_plan', { workspace: 'existing', objective: 'Integrate and verify a larger release',
    depth: 'thorough', checks: ['Integrated output completes the full route'] })
  assert.ok(thorough.id, JSON.stringify(thorough))
  const artChecks = ['Visual artifact opens']
  const sendAcceptance = args => acceptanceTool('session_tree_send', { project: thorough.id, child: tankCopy, ...args })
  const defect = await sendAcceptance({ phase: 'work', checks: artChecks, message: 'ACCEPTANCE-CHILD-FAIL Check asset' })
  const defectReceipt = await receiptFor(defect.id)
  assert.equal(defectReceipt.status, 'completed')
  assert.equal(defectReceipt.acceptance?.local?.[0]?.status, 'failed')
  const localChecks = ['All handoffs are present']
  const halted = await sendAcceptance({ phase: 'integration', checks: localChecks,
    message: 'ACCEPTANCE-CHILD-BLOCKED Must wait for approved work' })
  assert.equal((await receiptFor(halted.id)).status, 'failed')
  assert.ok(!observed.some(row => row.latest.startsWith('From ') && row.latest.includes('ACCEPTANCE-CHILD-BLOCKED')))
  const repaired = await sendAcceptance({ phase: 'work', checks: artChecks, replaces: defect.id,
    message: 'ACCEPTANCE-CHILD-PASS Repair failed check only' })
  assert.equal((await receiptFor(repaired.id)).acceptance?.local?.[0]?.status, 'passed')
  const integrated = await sendAcceptance({ phase: 'integration', checks: localChecks, replaces: halted.id,
    message: 'ACCEPTANCE-CHILD-INTEGRATE Use accepted asset' })
  assert.deepEqual(integrated.after, [repaired.id])
  await receiptFor(integrated.id)
  const premature = await acceptanceTool('session_tree_accept', { project: thorough.id, proof: integrated.id })
  assert.ok(!premature?.acceptedBy)
  const failedReview = await sendAcceptance({ phase: 'review', message: 'ACCEPTANCE-CHILD-REVIEW-FAIL Detect an integration defect' })
  assert.deepEqual(failedReview.after, [integrated.id])
  assert.equal((await receiptFor(failedReview.id)).acceptance?.final?.[0]?.status, 'failed')
  assert.ok(!(await acceptanceTool('session_tree_accept', { project: thorough.id, proof: failedReview.id }))?.acceptedBy)
  const rebuilt = await sendAcceptance({ phase: 'integration', checks: localChecks, replaces: integrated.id,
    message: 'ACCEPTANCE-CHILD-INTEGRATE Repair the final output without changing the approved art' })
  assert.deepEqual(rebuilt.after, [repaired.id])
  await receiptFor(rebuilt.id)
  const review = await sendAcceptance({ phase: 'review', message: 'ACCEPTANCE-CHILD-REVIEW Verify repaired integration' })
  assert.deepEqual(review.after, [rebuilt.id])
  assert.equal((await receiptFor(review.id)).acceptance?.final?.[0]?.status, 'passed')
  const confirmed = await acceptanceTool('session_tree_accept', { project: thorough.id, proof: review.id })
  assert.equal(confirmed.acceptedBy, review.id)
  await stop()
  url = await start()
  await page.goto(url)
  assert.ok((await snapshot()).projects.some(project => project.id === thorough.id && project.acceptedBy === review.id))
  console.log('PASS light work passes both levels in one dispatch; thorough work blocks failed handoffs, repairs and verifies the final integration')

  await setNaming('English')
  assert.equal((await snapshot()).preferences.aliasLanguage, 'en')
  const namingError = await acceptanceTool('session_tree_create', { alias: '构建执行', responsibility: 'Implementation' })
  assert.match(namingError, /English/)
  await setNaming('Follow DeepSeek Harness')
  await eventually(async () => {
    const { preferences } = await snapshot()
    return preferences.aliasLanguage === 'follow' && preferences.interfaceLocale === 'en'
  }, 'settings persist desktop interface locale')
  const oldGame = join(home, 'old-fixture-game.html')
  await writeFile(oldGame, 'existing game remains independent')
  const isolatedProject = await acceptanceTool('session_tree_plan', { objective: 'Deliver a new mini-game', depth: 'thorough',
    checks: ['Final game opens'] })
  assert.ok(isolatedProject.directory?.includes(isolatedProject.id))
  const builder = await acceptanceTool('session_tree_create', { alias: 'Game Builder', responsibility: 'Integrate the new mini-game' })
  const artist = await acceptanceTool('session_tree_create', { alias: 'Game Artist', responsibility: 'Create a new art artifact' })
  assert.ok(builder.id && artist.id && builder.id !== artist.id)
  const sendIsolated = args => acceptanceTool('session_tree_send', { project: isolatedProject.id, ...args })
  const invalidTarget = await sendIsolated({ child: 'missing', phase: 'work', checks: ['Existing check'], message: 'Does not exist' })
  assert.match(invalidTarget, new RegExp(builder.id))
  const asset = await sendIsolated({ child: ' GAME ARTIST ', phase: 'work', checks: ['Asset exists'], message: '#ISOLATED-WORK' })
  assert.equal(asset.child, artist.id)
  const assetReceipt = await receiptFor(asset.id)
  const assetPath = join(isolatedProject.directory, 'workers', artist.id, 'asset.txt')
  assert.equal(await readFile(assetPath, 'utf8'), 'new fixture deliverable')
  assert.deepEqual(assetReceipt.artifacts.map(path => path.toLowerCase()), [assetPath.toLowerCase()])
  const build = await sendIsolated({ child: 'Game Builder', phase: 'integration', checks: ['Bundle loads'], message: '#ISOLATED-BUILD' })
  const buildReceipt = await receiptFor(build.id)
  const finalGame = join(isolatedProject.directory, 'workers', builder.id, 'output', 'game.html')
  assert.equal(await readFile(finalGame, 'utf8'), 'new fixture deliverable')
  assert.ok(observed.some(row => row.result?.includes?.('assigned isolated task directory') && row.previous === 'session_tree_report'))
  assert.deepEqual(buildReceipt.artifacts.map(path => path.toLowerCase()), [finalGame.toLowerCase()])
  assert.ok(observed.some(row => row.latest.includes('#ISOLATED-BUILD') && row.latest.includes(assetPath)))
  const isolatedReview = await sendIsolated({ child: 'Game Artist', phase: 'review', message: '#ISOLATED-REVIEW' })
  await receiptFor(isolatedReview.id)
  assert.ok(observed.some(row => row.latest.includes('#ISOLATED-REVIEW') && row.latest.includes(finalGame)))
  assert.equal((await acceptanceTool('session_tree_accept', { project: isolatedProject.id, proof: isolatedReview.id })).acceptedBy, isolatedReview.id)
  assert.equal(await readFile(oldGame, 'utf8'), 'existing game remains independent')
  console.log('PASS alias dispatch, language settings, per-child folders, explicit artifact handoff and old-deliverable rejection')

  const namingA = await make('English Source A', 'Locale switch fixture A')
  const namingB = await make('English Source B', 'Locale switch fixture B')
  const namingParent = await post('/api/session-tree', { type: 'new-parent', anchor: namingA, sources: [namingA, namingB] })
  assert.ok(namingParent.response.ok())
  const rootId = namingParent.body.opened
  const copyA = await copiedChild(rootId, 'English Source A')
  const copyB = await copiedChild(rootId, 'English Source B')
  await expandGroup('Ungrouped')
  await keyed(rootId).click()
  await keyed(rootId).getByText('Awaiting task', { exact: true }).waitFor()
  await keyed(copyA).click({ button: 'right' })
  const menu = page.getByRole('menu')
  for (const label of ['Create child session', 'Detach from parent', 'Collaboration log', 'Session color', 'Move to Recycle Bin']) {
    await menu.getByRole('menuitem', { name: label, exact: true }).waitFor()
  }
  assert.doesNotMatch(await menu.innerText(), /\p{Script=Han}/u)
  await page.keyboard.press('Escape')
  await keyed(rootId).getByRole('button', { name: 'Collaboration log for Shared Parent Session' }).click()
  await page.getByText('Send the first project task to sync context.', { exact: true }).waitFor()
  await page.evaluate(() => { document.documentElement.lang = 'zh-CN' })
  await eventually(async () => {
    const { sessions } = await snapshot()
    return sessions.find(row => row.id === rootId)?.title === '共同父会话'
      && sessions.find(row => row.id === copyB)?.title === 'English Source B（副本）'
  }, 'Chinese generated titles')
  await keyed(rootId).getByText('待总任务', { exact: true }).waitFor()
  await rpc('session/rename', { sessionId: copyA, title: 'Hand-edited title（副本）' })
  await page.evaluate(() => { document.documentElement.lang = 'en' })
  await eventually(async () => {
    const { sessions } = await snapshot()
    return sessions.find(row => row.id === rootId)?.title === 'Shared Parent Session'
      && sessions.find(row => row.id === copyB)?.title === 'English Source B (Copy)'
  }, 'legacy generated titles switch to English')
  assert.equal((await snapshot()).sessions.find(row => row.id === copyA)?.title, 'Hand-edited title（副本）')
  await keyed(rootId).getByText('Awaiting task', { exact: true }).waitFor()
  console.log('PASS English menu and pending labels, live bilingual switch, legacy title migration and manual-title preservation')
} catch (error) {
  console.error(logs.replace(/token=\S+/g, 'token=[redacted]'))
  console.error(pageErrors.slice(-20))
  console.error(observed.slice(-6).map(row => ({ latest: row.latest.slice(0, 180), sent: row.sent, action: row.action,
    tools: row.body.tools?.filter(tool => /subagent|session_tree/.test(tool.name)).map(tool => tool.name),
    toolResult: JSON.stringify(row.result)?.slice(0, 900),
  })))
  if (page) console.error((await page.locator('body').innerText()).slice(0, 1300))
  throw error
} finally {
  await browser?.close()
  await stop()
  await new Promise(resolve => server.close(resolve))
}

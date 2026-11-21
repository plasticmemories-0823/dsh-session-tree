import { constants } from 'node:fs'
import { access, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const folder = dirname(fileURLToPath(import.meta.url))
const supportedVersion = '0.2.2-rc.5'
const plugin = 'dsh-session-tree'
const platform = process.platform
const mac = platform === 'darwin'
const profile = mac ? 'desktop' : 'web'
const override = process.env.DSH_HOME
const home = !override?.trim() ? join(homedir(), '.dsh')
  : resolve(/^~(?:$|[/\\])/.test(override) ? homedir() + override.slice(1) : override)
const profileFolder = join(home, 'profiles', profile)
const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 24 || (major === 24 && minor < 9)) throw new Error('需要 Node.js 24.9 或更高版本。')
if (!mac && platform !== 'linux') throw new Error('此安装包适用于 macOS 或 Linux。')

const args = process.argv.slice(2)
let explicitCli
let openBrowser = true
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--no-open') openBrowser = false
  else if (args[i] === '--dsh' && args[i + 1]) explicitCli = resolve(args[++i])
  else throw new Error('用法：manage.sh [--dsh /path/to/dsh] [--no-open]')
}

const assets = await Promise.all(['index.html', 'manager.css', 'ui.js'].map(name => readFile(join(folder, name))))
const packages = (await readdir(folder)).filter(name => /^dsh-session-tree-\d+\.\d+\.\d+\.tgz$/.test(name))
if (packages.length !== 1) throw new Error('请完整解压安装包，并保留同目录下的 .tgz 文件。')
const archiveName = packages[0]
const release = archiveName.slice(plugin.length + 1, -4)
const cliSuffix = 'Contents/Resources/runtime/cli/bin/dsh'
const macPaths = ['/Applications/DeepSeek Harness.app', join(homedir(), 'Applications', 'DeepSeek Harness.app')]
const env = { ...process.env, DSH_HOME: home }
let busy = false

async function json(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function findCli() {
  const candidates = explicitCli ? [explicitCli] : [
    ...(mac ? macPaths.map(path => join(path, cliSuffix)) : []),
    ...(process.env.PATH ?? '').split(':').filter(isAbsolute).map(path => join(path, 'dsh')),
  ]
  for (const path of candidates) {
    try {
      await access(path, constants.X_OK)
      const actual = await realpath(path)
      if (!mac || actual.endsWith('/' + cliSuffix)) return actual
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error
    }
  }
  return null
}

async function running() {
  const { stdout } = await run('ps', ['-axww', '-o', 'args='])
  return stdout.split('\n').some(line => mac
    ? /\.app\/Contents\/MacOS\/DeepSeek Harness(?:\s|$)/.test(line) && !line.includes('/dsh-desktop-host/lib/cli.js')
    : /^\s*(?:(?:.*\/)?dsh|(?:.*\/)?node\s+.*\/(?:dsh\/lib\/bin\.js|(?:\.bin|bin)\/dsh))\s+(?:web|--profile[=\s]+web)(?:\s|$)/.test(line))
}

async function state() {
  const [cli, config, installed, active] = await Promise.all([
    findCli(), json(join(profileFolder, 'package.json')),
    json(join(profileFolder, 'node_modules', plugin, 'package.json')), running(),
  ])
  let version = null
  let cliError = null
  if (cli) {
    try { version = (await run(cli, ['--version'], { env, timeout: 10000 })).stdout.trim() }
    catch (error) { cliError = error.stderr?.trim() || error.message }
  }
  const registered = Object.hasOwn(config?.dependencies ?? {}, plugin)
    || config?.dsh?.profile?.bundles?.includes(plugin) === true
  const configured = !mac || !!config
  return { cli, cliError, version, compatible: version === supportedVersion, supportedVersion, configured,
    registered, installed: installed?.version ?? null, active, busy, profile, release, mac }
}

async function change(install) {
  if (busy) throw new Error('已有操作正在执行。')
  busy = true
  try {
    const current = await state()
    if (!current.cli) throw new Error('找不到可用的 dsh 命令。')
    if (install && !current.compatible) throw new Error(`此安装包需要 DSH ${supportedVersion}。`)
    if (!current.configured) throw new Error('请先打开 DSH 桌面版以初始化配置。')
    if (!install && !current.registered && !current.installed) throw new Error('当前配置尚未安装此插件。')
    if (current.active) throw new Error(`请先退出 ${mac ? 'DeepSeek Harness 桌面版' : 'dsh web'}。`)
    let operand = plugin
    if (install) {
      const bundle = await readFile(join(folder, archiveName))
      const digest = createHash('sha256').update(bundle).digest('hex')
      const targetDir = join(home, 'session-tree', 'packages', profile, digest)
      await mkdir(targetDir, { recursive: true, mode: 0o700 })
      const target = join(targetDir, archiveName)
      const staged = target + '.' + randomBytes(8).toString('hex') + '.tmp'
      try {
        await writeFile(staged, bundle, { flag: 'wx', mode: 0o600 })
        await rename(staged, target)
      } finally { await rm(staged, { force: true }) }
      operand = 'file:' + target
    }
    if (await running()) throw new Error('DSH 已启动，请退出后重试。')
    const { stdout, stderr } = await run(current.cli, ['plugin', '--profile', profile, install ? 'add' : 'remove', operand],
      { env, maxBuffer: 8 * 1024 * 1024 })
    const updated = await state()
    if (install ? !updated.registered || updated.installed !== release : updated.registered || updated.installed) {
      throw new Error('DSH 命令执行完毕，配置中的插件状态与预期不符。')
    }
    return { output: [stdout.trim(), stderr.trim()].filter(Boolean).join('\n'), state: { ...updated, busy: false } }
  } finally { busy = false }
}

const key = randomBytes(24).toString('hex')
const base = '/' + key + '/'
let origin
const headers = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
}
const routes = new Map([
  [base, ['text/html; charset=utf-8', assets[0]]],
  [base + 'manager.css', ['text/css; charset=utf-8', assets[1]]],
  [base + 'ui.js', ['text/javascript; charset=utf-8', assets[2]]],
])
const server = createServer(async (request, response) => {
  const reply = (code, data) => {
    response.writeHead(code, { ...headers, 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(data))
  }
  if ('http://' + request.headers.host !== origin) return reply(403, { error: '请求来源无效。' })
  const route = request.url
  const method = request.method
  if (method === 'GET' && routes.has(route)) {
    const [type, value] = routes.get(route)
    response.writeHead(200, { ...headers, 'Content-Type': type })
    response.end(value)
    return
  }
  try {
    if (method === 'GET' && route === base + 'state') return reply(200, await state())
    if (method === 'POST' && route === base + 'close') {
      if (request.headers.origin !== origin || request.headers['x-dsh-manager'] !== '1') {
        return reply(403, { error: '请求来源无效。' })
      }
      if (busy) return reply(409, { error: '请等待当前操作结束。' })
      reply(200, {})
      server.close()
      return
    }
    const action = route === base + 'install' ? 'install' : route === base + 'uninstall' ? 'uninstall' : null
    if (method === 'POST' && action) {
      if (request.headers.origin !== origin || request.headers['x-dsh-manager'] !== '1') {
        return reply(403, { error: '请求来源无效。' })
      }
      return reply(200, await change(action === 'install'))
    }
    return reply(404, { error: '未找到页面。' })
  } catch (error) {
    return reply(400, { error: [error.message, error.stderr, error.stdout].filter(Boolean).join('\n') })
  }
})
server.listen(0, '127.0.0.1', () => {
  origin = `http://127.0.0.1:${server.address().port}`
  const url = origin + base
  console.log(`DSH 会话树管理器 · ${url}\n按 Ctrl+C 关闭管理器。`)
  if (openBrowser) {
    const browser = spawn(mac ? 'open' : 'xdg-open', [url], { stdio: 'ignore' })
    browser.on('error', () => console.error('请在浏览器中手动打开上面的地址。'))
    browser.on('exit', code => {
      if (code) console.error('请在浏览器中手动打开上面的地址。')
    })
    browser.unref()
  }
})

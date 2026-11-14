const fields = Object.fromEntries(Array.from(document.querySelectorAll('[id]'), element => [element.id, element]))
let snapshot
let pending = false
let closed = false

function updateButtons() {
  const disabled = pending || closed
  const ready = snapshot?.cli && snapshot.configured && !snapshot.active && !snapshot.busy
  fields.install.disabled = disabled || !ready || !snapshot.compatible
  fields.uninstall.disabled = disabled || !ready || !(snapshot.installed || snapshot.registered)
  fields.refresh.disabled = disabled
  fields.close.disabled = disabled
}

function showState(state) {
  snapshot = state
  fields.profile.textContent = state.mac ? 'macOS · DSH 桌面配置' : 'Linux · DSH Web 配置'
  fields.version.textContent = state.version || '未检测到'
  fields.installed.textContent = state.installed || (state.registered ? '已登记，文件缺失' : '未安装')
  fields.release.textContent = state.release
  fields.install.textContent = state.installed ? '安装此版本' : '安装插件'
  if (state.busy) fields.status.textContent = '正在处理插件…'
  else if (!state.cli) fields.status.textContent = state.mac
    ? '未找到 DeepSeek Harness 桌面版。自定义安装位置可用 --dsh 指定桌面版命令。'
    : '未找到 dsh 命令。请安装 DSH 并将 dsh 加入 PATH，或使用 --dsh 指定路径。'
  else if (state.cliError) fields.status.textContent = '无法读取 DSH 版本。请查看操作日志。'
  else if (!state.configured) fields.status.textContent = '请先启动一次 DeepSeek Harness 桌面版，退出后刷新状态。'
  else if (state.active) fields.status.textContent = state.mac ? '请先退出 DeepSeek Harness 桌面版，再刷新状态。' : '请先停止 dsh web，再刷新状态。'
  else if (!state.compatible) fields.status.textContent = `此安装包适用于 DSH ${state.supportedVersion}。`
  else fields.status.textContent = state.installed ? '插件已安装。' : '可以安装插件。'
}

function showLog(message, open = false) {
  fields.log.textContent = message
  fields.details.hidden = !message
  fields.details.open = open
}

async function request(action) {
  if (pending || closed) return
  pending = true
  updateButtons()
  const read = action === 'state'
  if (!read && action !== 'close') fields.status.textContent = action === 'install'
    ? '正在安装。首次安装可能需要下载 DSH 依赖…' : '正在卸载…'
  try {
    const response = await fetch(action, read ? {} : { method: 'POST', headers: { 'X-DSH-Manager': '1' } })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error)
    if (action === 'close') {
      closed = true
      fields.status.textContent = '管理器已关闭，可以关闭此页面。'
    } else if (read) {
      showState(data)
      if (data.cliError) showLog(data.cliError, true)
    } else {
      showState(data.state)
      showLog(data.output)
      const launch = data.state.mac ? '打开 DeepSeek Harness 桌面版' : '运行 dsh web'
      fields.status.textContent = action === 'install' ? `插件已安装。现在可以${launch}。` : `插件已卸载。${launch}后即可使用原生侧栏。`
    }
  } catch (error) {
    if (read) snapshot = undefined
    fields.status.textContent = '操作失败。请查看日志，必要时刷新状态后重试。'
    showLog(error.message, true)
  } finally {
    pending = false
    updateButtons()
  }
}

fields.refresh.addEventListener('click', () => request('state'))
fields.install.addEventListener('click', () => request('install'))
fields.uninstall.addEventListener('click', () => {
  if (confirm('卸载 DSH 会话树插件？本地会话和会话树数据将保留。')) request('uninstall')
})
fields.close.addEventListener('click', () => request('close'))
request('state')

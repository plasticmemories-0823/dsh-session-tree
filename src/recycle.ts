import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

const run = promisify(execFile)

export async function sessionTrashPath(log: string): Promise<string> {
  const root = resolve(dshHomePath('sessions'))
  const path = resolve(log)
  const parts = relative(root, path).split(sep)
  if (parts.length !== 3 || parts[0] === '..' || isAbsolute(relative(root, path))
    || !/^session\.v\d+\.jsonl(?:\.zstd)?$/.test(parts[2])) {
    throw new Error('此会话不在 DSH 的本地日志目录中')
  }
  const folder = dirname(path)
  for (const candidate of [root, dirname(folder), folder, path]) {
    const resolved = await realpath(candidate)
    if (resolved.toLowerCase() !== candidate.toLowerCase()
      || (await lstat(candidate)).isSymbolicLink()) throw new Error('会话存储路径指向了其他位置')
  }
  return folder
}

export async function recycleSessionDirectory(folder: string): Promise<void> {
  const script = `
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName Microsoft.VisualBasic
    $target = $env:DSH_SESSION_TREE_RECYCLE_PATH
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(
      $target,
      [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
      [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,
      [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException
    )
  `
  const executable = resolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  await run(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { env: { ...process.env, DSH_SESSION_TREE_RECYCLE_PATH: folder }, windowsHide: true, timeout: 30000 })
}

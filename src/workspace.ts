import { lstat, mkdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { translator } from './i18n.ts'

function inFolder(folder: string, file: string): boolean {
  const name = relative(folder, file)
  return !!name && !isAbsolute(name) && name !== '..' && !name.startsWith('..' + sep)
}

export async function openWorkDirectory(project: string, directory: string, t = translator()): Promise<void> {
  if (!inFolder(project, directory)) throw new Error(t('Invalid project working directory.', '无效的项目工作目录'))
  const base = dirname(dirname(project))
  let current = base
  for (const name of relative(base, directory).split(sep)) {
    current = resolve(current, name)
    await mkdir(current).catch(error => {
      if (error.code !== 'EEXIST') throw error
    })
    const entry = await lstat(current)
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(t('The isolated directory contains a symlink or redirect. Check the directory and retry.', '独立目录存在符号链接或重定向，请检查后重试'))
  }
}

export async function validatedArtifacts(directory: string | undefined, paths: string[], t = translator()): Promise<string[]> {
  if (paths.length > 25 || paths.some(file => !file.trim() || file.length > 1600 || /[\u0000-\u001f]/u.test(file))) {
    throw new Error(t('Provide up to 25 valid artifact paths.', '产物路径需为有效文件路径，最多 25 条'))
  }
  const files = paths.map(file => {
    if (!directory && !isAbsolute(file)) throw new Error(t('Use absolute artifact paths when no isolated directory is assigned.', '没有独立目录时，产物路径需要是绝对路径'))
    const absolute = directory ? resolve(directory, file) : resolve(file)
    if (directory && !inFolder(directory, absolute)) throw new Error(t('Save the artifact in the assigned isolated task directory.', '请把本次产物保存到派发指定的独立工作目录'))
    return absolute
  })
  return [...new Set(await Promise.all(files.map(async file => {
    const stat = await lstat(file).catch(() => undefined)
    if (!stat?.isFile()) throw new Error(t(`Artifact file not found: ${file}`, `未找到产物文件：${file}`))
    const canonical = await realpath(file)
    if (directory && !inFolder(await realpath(directory), canonical)) throw new Error(t('The artifact resolves outside the isolated task directory.', '产物指向独立工作目录外部'))
    return canonical
  })))]
}

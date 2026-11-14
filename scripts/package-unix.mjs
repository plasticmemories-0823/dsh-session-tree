import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { create } from 'tar'

const root = fileURLToPath(new URL('../', import.meta.url))
const { name, version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const dist = join(root, 'dist')
const bundle = `${name}-${version}.tgz`
const npm = process.env.npm_execpath
if (!npm) throw new Error('Run with npm run package:unix.')

await mkdir(dist, { recursive: true })
execFileSync(process.execPath, [npm, 'pack', '--pack-destination', dist], { cwd: root, stdio: 'inherit' })

const files = ['manage.sh', 'manager.mjs', 'index.html', 'manager.css', 'ui.js']
const archives = []
for (const platform of ['linux', 'macos']) {
  const base = `${name}-${version}-${platform}`
  const staging = join(dist, base)
  const entry = platform === 'macos' ? 'Manage.command' : 'manage.sh'
  await mkdir(staging, { recursive: true })
  await Promise.all(files.map(file => copyFile(join(root, 'installer', 'unix', file),
    join(staging, file === 'manage.sh' ? entry : file))))
  await copyFile(join(dist, bundle), join(staging, bundle))
  const archive = base + '.tar.gz'
  await create({ cwd: staging, file: join(dist, archive), prefix: base, gzip: true, portable: true,
    onWriteEntry(item) { item.stat.mode = item.path === entry ? 0o755 : 0o644 },
  }, [...files.map(file => file === 'manage.sh' ? entry : file), bundle])
  archives.push(archive)
}

const checksums = await Promise.all(archives.map(async archive => {
  const digest = createHash('sha256').update(await readFile(join(dist, archive))).digest('hex')
  console.log(join(dist, archive))
  return `${digest}  ${archive}`
}))
await writeFile(join(dist, 'SHA256SUMS-unix.txt'), checksums.join('\n') + '\n')

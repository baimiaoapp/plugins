import { readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const roots = [
  path.join(projectRoot, 'mcp'),
  path.join(projectRoot, 'scripts'),
  path.join(projectRoot, 'skills/baimiao-local-media/scripts'),
]
const files = (await Promise.all(roots.map(walk))).flat().filter((filename) => filename.endsWith('.mjs'))

for (const filename of files) {
  const result = spawnSync(process.execPath, ['--check', filename], { encoding: 'utf8' })
  if (result.status !== 0) {
    process.stderr.write(result.stderr)
    process.exitCode = 1
  }
}

if (!process.exitCode) console.log(JSON.stringify({ ok: true, checkedFiles: files.length }))

async function walk(directory) {
  const output = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) output.push(...await walk(filename))
    else if (entry.isFile()) output.push(filename)
  }
  return output
}

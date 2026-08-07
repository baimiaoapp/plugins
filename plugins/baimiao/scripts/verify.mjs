import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { RUNTIME_ASSETS } from '../skills/baimiao-local-media/scripts/runtime-assets.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const commands = [
  ['build', ['build']],
  ['lint', ['lint']],
  ['test', ['test']],
]
const yarnExecutable = process.platform === 'win32' ? 'yarn.cmd' : 'yarn'
for (const [label, args] of commands) {
  const result = spawnSync(yarnExecutable, args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  })
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}.`)
}

const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const manifest = JSON.parse(await readFile(path.join(root, '.codex-plugin/plugin.json'), 'utf8'))
const server = await readFile(path.join(root, 'mcp/baimiao-server.mjs'), 'utf8')
const expectedVersion = packageJson.version
if (manifest.version !== expectedVersion) throw new Error('Plugin and package versions differ.')
const serverVersion = server.match(/serverInfo:\s*\{\s*name:\s*'baimiao',\s*version:\s*'([^']+)'/s)?.[1]
if (serverVersion !== expectedVersion) throw new Error('MCP server and package versions differ.')

for (const [filename, asset] of Object.entries(RUNTIME_ASSETS)) {
  if (!/^https:\/\//.test(asset.url) || !Number.isSafeInteger(asset.size) || asset.size <= 0 || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
    throw new Error(`Invalid runtime metadata: ${filename}`)
  }
}
for (const notice of ['THIRD_PARTY_NOTICES.md', 'third-party/IMAGEMAGICK-LICENSE.txt', 'third-party/PDFIUM-LICENSE.txt']) {
  if (!(await readFile(path.join(root, notice), 'utf8')).trim()) throw new Error(`Empty license notice: ${notice}`)
}
for (const skill of ['skills/baimiao-local-media/SKILL.md', 'skills/baimiao-document-services/SKILL.md']) {
  const text = await readFile(path.join(root, skill), 'utf8')
  if (!text.startsWith('---') || !text.includes('name:') || !text.includes('description:')) throw new Error(`Invalid Skill metadata: ${skill}`)
}
console.log(JSON.stringify({ ok: true, version: expectedVersion, runtimeFiles: Object.keys(RUNTIME_ASSETS).length }))

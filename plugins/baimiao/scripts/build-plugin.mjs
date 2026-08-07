import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { RUNTIME_ASSETS, RUNTIME_BUNDLES } from '../skills/baimiao-local-media/scripts/runtime-assets.mjs'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const requiredFiles = [
  '.codex-plugin/plugin.json',
  '.mcp.json',
  'THIRD_PARTY_NOTICES.md',
  'mcp/baimiao-mcp.mjs',
  'mcp/json-rpc.mjs',
  'mcp/baimiao-server.mjs',
  'mcp/baimiao-http-adapter.mjs',
  'mcp/baimiao-oauth.mjs',
  'skills/baimiao-local-media/SKILL.md',
  'skills/baimiao-local-media/agents/openai.yaml',
  'skills/baimiao-local-media/references/operations.md',
  'skills/baimiao-document-services/SKILL.md',
  'skills/baimiao-document-services/agents/openai.yaml',
  'skills/baimiao-document-services/references/service-capabilities.md',
  'skills/baimiao-local-media/scripts/baimiao.mjs',
  'skills/baimiao-local-media/scripts/operation-handlers.mjs',
  'skills/baimiao-local-media/scripts/local-artifact-transaction.mjs',
  'skills/baimiao-local-media/scripts/ocr-input-preparation.mjs',
  'skills/baimiao-local-media/scripts/operation-catalog.mjs',
  'skills/baimiao-local-media/scripts/runtime-assets.mjs',
  'skills/baimiao-local-media/scripts/runtime-cache.mjs',
  'skills/baimiao-local-media/assets/qpdf/qpdf.mjs',
  'skills/baimiao-local-media/assets/qpdf/qpdf.wasm',
  'skills/baimiao-local-media/assets/pdf-lib/pdf-lib.mjs',
]
const maxBundledFileSize = 5 * 1024 * 1024
const forbiddenBundledPaths = [
  'skills/baimiao-local-media/assets/media-runtime',
]

await Promise.all(requiredFiles.map(async (filename) => {
  const contents = await readFile(path.join(projectRoot, filename))
  if (!contents.length) throw new Error(`Required Plugin file is empty: ${filename}`)
}))

const manifest = JSON.parse(await readFile(path.join(projectRoot, '.codex-plugin/plugin.json'), 'utf8'))
if (manifest.name !== 'baimiao') throw new Error('Plugin manifest name must remain baimiao.')
if (manifest.mcpServers !== './.mcp.json') throw new Error('Plugin manifest must reference .mcp.json.')

for (const filename of forbiddenBundledPaths) {
  const info = await stat(path.join(projectRoot, filename)).catch(() => null)
  if (info) throw new Error(`Downloaded runtime directory must not be bundled: ${filename}`)
}

for (const [filename, asset] of Object.entries(RUNTIME_ASSETS)) {
  if (path.basename(filename) !== filename) throw new Error(`Unsafe runtime filename: ${filename}`)
  const sources = asset.sources || { international: asset.url }
  for (const [source, url] of Object.entries(sources)) {
    if (!url.startsWith('https://')) throw new Error(`Runtime ${source} URL must use HTTPS: ${filename}`)
  }
  if (!sources.international) throw new Error(`Runtime must define an international URL: ${filename}`)
  if (!/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error(`Invalid runtime SHA-256: ${filename}`)
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0) throw new Error(`Invalid runtime size: ${filename}`)
}
for (const [bundle, filenames] of Object.entries(RUNTIME_BUNDLES)) {
  if (!filenames.length) throw new Error(`Runtime bundle is empty: ${bundle}`)
  for (const filename of filenames) {
    if (!RUNTIME_ASSETS[filename]) throw new Error(`Runtime bundle references an unknown asset: ${filename}`)
  }
}

const files = await walk(projectRoot)
let packagedBytes = 0
for (const filename of files) {
  const info = await stat(filename)
  packagedBytes += info.size
  if (info.size > maxBundledFileSize) {
    throw new Error(`Large runtime must be downloaded on demand, not bundled: ${path.relative(projectRoot, filename)}`)
  }
}

console.log(JSON.stringify({
  ok: true,
  pluginRoot: projectRoot,
  packagedBytes,
  remoteRuntimeBytes: Object.values(RUNTIME_ASSETS).reduce((total, asset) => total + asset.size, 0),
  remoteRuntimeFiles: Object.keys(RUNTIME_ASSETS).length,
}))

async function walk(directory) {
  const output = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.yarn') continue
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) output.push(...await walk(filename))
    else if (entry.isFile()) output.push(filename)
  }
  return output
}

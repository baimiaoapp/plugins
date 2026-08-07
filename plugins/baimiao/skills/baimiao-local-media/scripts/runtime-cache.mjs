import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { link, mkdir, open, stat, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { CliError } from './cli-options.mjs'
import { RUNTIME_ASSETS, RUNTIME_BUNDLES, RUNTIME_CACHE_VERSION } from './runtime-assets.mjs'

const pendingFiles = new Map()
const RUNTIME_REGION_URL = 'https://pdf.baimiaoapp.com/api/web/auth/region'
let runtimeSourcePromise

export const ensureRuntimeBundle = async (name) => {
  const filenames = RUNTIME_BUNDLES[name]
  if (!filenames) throw new CliError('RUNTIME_NOT_FOUND', `Unknown runtime bundle: ${name}`)
  const entries = await Promise.all(filenames.map(async (filename) => [filename, await ensureRuntimeFile(filename)]))
  return Object.fromEntries(entries)
}

export const ensureRuntimeFile = async (filename) => {
  const asset = RUNTIME_ASSETS[filename]
  if (!asset) throw new CliError('RUNTIME_NOT_FOUND', `Unknown runtime asset: ${filename}`)
  if (!pendingFiles.has(filename)) {
    pendingFiles.set(filename, materializeRuntimeFile(filename, asset).catch((error) => {
      pendingFiles.delete(filename)
      throw error
    }))
  }
  return pendingFiles.get(filename)
}

export const getRuntimeCacheDirectory = () => {
  const configured = process.env.BAIMIAO_PDF_RUNTIME_CACHE
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new CliError('INVALID_CACHE_PATH', 'BAIMIAO_PDF_RUNTIME_CACHE must be an absolute path.')
    }
    return path.join(configured, RUNTIME_CACHE_VERSION)
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'baimiao', 'runtime', RUNTIME_CACHE_VERSION)
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    return path.join(localAppData, 'Baimiao PDF', 'Cache', 'runtime', RUNTIME_CACHE_VERSION)
  }
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'baimiao', 'runtime', RUNTIME_CACHE_VERSION)
}

const materializeRuntimeFile = async (filename, asset) => {
  const destination = path.join(getRuntimeCacheDirectory(), asset.sha256.slice(0, 16), filename)
  const existing = await readValidFile(destination, asset)
  if (existing) return destination

  await mkdir(path.dirname(destination), { recursive: true })
  const temporary = await downloadAsset(filename, asset, destination)
  try {
    try {
      await link(temporary, destination)
    } catch (error) {
      if (error?.code !== 'EEXIST' || !(await readValidFile(destination, asset))) {
        throw new CliError(
          'RUNTIME_CACHE_CONFLICT',
          `The runtime cache contains an invalid file for ${filename}.`,
          { path: destination },
        )
      }
    }
  } finally {
    await unlink(temporary).catch(() => {})
  }
  return destination
}

const readValidFile = async (filename, asset) => {
  try {
    return await verifyFile(filename, asset)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

const downloadAsset = async (filename, asset, destination) => {
  let lastError
  let integrityFailed = false
  for (const url of await getRuntimeUrls(asset)) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const temporary = `${destination}.${randomUUID()}.download`
      try {
        const response = await fetch(url, {
          redirect: 'follow',
          signal: AbortSignal.timeout(120_000),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        if (!response.url.startsWith('https://')) throw new Error('Runtime download redirected to a non-HTTPS URL.')
        const contentLength = Number(response.headers.get('content-length'))
        if (Number.isSafeInteger(contentLength) && contentLength > asset.size) {
          throw new Error(`Runtime response exceeds the declared size for ${filename}`)
        }
        const digest = await writeAndDigest(response.body, temporary, asset.size)
        if (digest.size !== asset.size || digest.sha256 !== asset.sha256) {
          integrityFailed = true
          lastError = new Error(`Integrity mismatch from ${url}`)
          await unlink(temporary).catch(() => {})
          break
        }
        return temporary
      } catch (error) {
        lastError = error
        if (error instanceof CliError) throw error
        await unlink(temporary).catch(() => {})
      }
    }
  }
  if (integrityFailed) {
    throw new CliError(
      'RUNTIME_INTEGRITY_FAILED',
      `The downloaded runtime failed integrity verification: ${filename}`,
    )
  }
  throw new CliError(
    'RUNTIME_DOWNLOAD_FAILED',
    `This operation needs a one-time runtime download that failed: ${filename}`,
    { cause: String(lastError?.message || lastError) },
  )
}

const getRuntimeUrls = async (asset) => {
  const source = process.env.BAIMIAO_PDF_RUNTIME_SOURCE || 'auto'
  const sources = asset.sources || { international: asset.url }
  if (!['auto', 'china', 'international'].includes(source)) {
    throw new CliError(
      'INVALID_RUNTIME_SOURCE',
      'BAIMIAO_PDF_RUNTIME_SOURCE must be auto, china, or international.',
    )
  }
  const preferredSource = source === 'auto' ? await detectRuntimeSource() : source
  if (preferredSource === 'international') {
    return uniqueUrls([sources.international, sources.china])
  }
  return uniqueUrls([sources.china, sources.international])
}

const uniqueUrls = (urls) => [...new Set(urls.filter(Boolean))]

const detectRuntimeSource = async () => {
  if (!runtimeSourcePromise) {
    runtimeSourcePromise = fetch(RUNTIME_REGION_URL, {
      headers: { accept: 'application/json' },
      redirect: 'follow',
      signal: AbortSignal.timeout(3_000),
    }).then(async (response) => {
      if (!response.ok || !response.url.startsWith('https://')) throw new Error('Region lookup failed.')
      const result = await response.json()
      return result?.code === 200 && result?.data?.region === 'global' ? 'international' : 'china'
    }).catch(() => 'china')
  }
  return runtimeSourcePromise
}

const writeAndDigest = async (body, filename, maximumBytes) => {
  if (!body) throw new Error('Runtime response did not contain a body.')
  const handle = await open(filename, 'wx', 0o600)
  const hash = createHash('sha256')
  let size = 0
  try {
    for await (const chunk of body) {
      const bytes = Buffer.from(chunk)
      size += bytes.byteLength
      if (size > maximumBytes) throw new Error('Runtime response exceeds the declared size.')
      hash.update(bytes)
      await handle.write(bytes)
    }
    await handle.sync()
    return { size, sha256: hash.digest('hex') }
  } finally {
    await handle.close().catch(() => {})
  }
}

const verifyFile = async (filename, asset) => {
  const info = await stat(filename)
  if (!info.isFile() || info.size !== asset.size) return false
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(filename)) {
    const bytes = Buffer.from(chunk)
    size += bytes.byteLength
    hash.update(bytes)
  }
  return size === asset.size && hash.digest('hex') === asset.sha256
}

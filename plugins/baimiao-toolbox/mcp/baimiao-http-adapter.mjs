import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'

import { createOAuthClient } from './baimiao-oauth.mjs'

const DEFAULT_API_BASE_URL = 'https://pdf.baimiaoapp.com/api/web/'
const LOGIN_URL = 'https://pdf.baimiaoapp.com/'
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_UPLOAD_TIMEOUT_MS = 120_000
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000
const DEFAULT_MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024
const MAX_JSON_BYTES = 10 * 1024 * 1024

export function createAdapter({
  fetch_impl = globalThis.fetch,
  oauth_client = createOAuthClient({ fetch_impl }),
  request_timeout_ms = DEFAULT_REQUEST_TIMEOUT_MS,
  upload_timeout_ms = DEFAULT_UPLOAD_TIMEOUT_MS,
  download_timeout_ms = DEFAULT_DOWNLOAD_TIMEOUT_MS,
  max_download_bytes = DEFAULT_MAX_DOWNLOAD_BYTES,
} = {}) {
  if (typeof fetch_impl !== 'function') throw new Error('This MCP server requires a Fetch-compatible Node.js runtime.')
  const api_base_url = parseApiBaseUrl(process.env.BAIMIAO_MCP_API_BASE_URL || DEFAULT_API_BASE_URL)
  const oauth_recovery = process.env.BAIMIAO_MCP_AUTH_ADAPTER_MODULE ? undefined : oauth_client
  const tasks = new Map()

  return {
    async login() { return oauth_client.login() },
    async authStatus() { return oauth_client.status() },
    async logout() { return oauth_client.logout() },
    async submit({ operation, input, options }) {
      const auth_headers = await getAuthHeaders(oauth_client)
      const sign_url = new URL('aliyun/oss/sign', api_base_url)
      sign_url.searchParams.set('mime_type', input.mimeType)
      const sign = await requestData(fetch_impl, sign_url, { headers: auth_headers }, request_timeout_ms, oauth_recovery)
      validateUploadSign(sign)
      await uploadFile(fetch_impl, sign, input, upload_timeout_ms)
      const current_auth_headers = await getAuthHeaders(oauth_client)

      if (operation === 'ocr') {
        const payload = await requestData(fetch_impl, new URL(`ocr/${options.kind}`, api_base_url), {
          method: 'POST', headers: jsonHeaders(current_auth_headers),
          body: JSON.stringify({ file_key: sign.file_key, name: input.name }),
        }, upload_timeout_ms, oauth_recovery)
        const task_id = `ocr-${randomUUID()}`
        const task = normalizeOcrTask(task_id, options.kind, payload)
        tasks.set(task_id, task)
        return omitBytes(task)
      }

      const translation = operation === 'pdf-translate'
      const endpoint = translation ? 'pdf/translate' : 'pdf/convert'
      const body = translation
        ? { file_key: sign.file_key, translate_to: options.target_language, output_format: options.output_format || 'word', mode: options.mode, num_pages: input.num_pages, name: input.name }
        : { file_key: sign.file_key, convert_to: options.format, num_pages: input.num_pages, name: input.name }
      const submitted = await requestData(fetch_impl, new URL(endpoint, api_base_url), {
        method: 'POST', headers: jsonHeaders(current_auth_headers), body: JSON.stringify(body),
      }, request_timeout_ms, oauth_recovery)
      if (typeof submitted.task_id !== 'string') throw new Error('The Baimiao API returned an invalid task submission.')
      return {
        task_id: submitted.task_id, status: 'queued', stage: 'queued', progress: 0,
        message: 'Task queued.',
      }
    },

    async getTask({ task_id }) {
      const local = tasks.get(task_id)
      if (local) return omitBytes(local)
      const task_url = new URL(`pdf/tasks/${encodeURIComponent(task_id)}`, api_base_url)
      const remote = await requestData(fetch_impl, task_url, { headers: await getAuthHeaders(oauth_client) }, request_timeout_ms, oauth_recovery)
      return normalizeRemoteTask(remote, task_id)
    },

    async download({ task_id }) {
      const local = tasks.get(task_id)
      if (local?.bytes) return Readable.from([local.bytes])
      const task = await this.getTask({ task_id })
      if (task.status !== 'completed' || !task.result?.download_url) {
        throw publicError('RESULT_NOT_READY', 'The Baimiao task result is not ready to download.')
      }
      const download_url = secureDownloadUrl(task.result.download_url)
      const response = await fetchWithTimeout(fetch_impl, download_url, {
        redirect: 'error',
      }, download_timeout_ms)
      if (!response.ok || !response.body) throw remoteError(response.status)
      const content_length = Number(response.headers.get('content-length'))
      if (Number.isFinite(content_length) && content_length > max_download_bytes) throw publicError('RESULT_TOO_LARGE', 'The Baimiao result exceeds the download limit.')
      return Readable.from(limitBody(response.body, max_download_bytes))
    },
  }
}

async function getAuthHeaders(oauth_client) {
  const module_path = process.env.BAIMIAO_MCP_AUTH_ADAPTER_MODULE
  let headers
  if (module_path) {
    if (!path.isAbsolute(module_path)) throw new Error('BAIMIAO_MCP_AUTH_ADAPTER_MODULE must be an absolute path.')
    const loaded = await import(pathToFileURL(module_path))
    headers = await loaded.getAuthorizationHeaders()
  } else {
    headers = await oauth_client.getAuthorizationHeaders()
  }
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) throw new Error('The authentication adapter returned invalid headers.')
  return headers
}

async function uploadFile(fetch_impl, sign, input, timeout_ms) {
  const url = new URL(sign.host)
  if (url.protocol !== 'https:') throw new Error('The upload endpoint must use HTTPS.')
  const boundary = `----baimiao-${randomUUID()}`
  const fields = [
    ['success_action_status', '200'], ['policy', sign.policy], ['x-oss-signature', sign.signature],
    ['x-oss-signature-version', 'OSS4-HMAC-SHA256'], ['x-oss-credential', sign.x_oss_credential],
    ['x-oss-date', sign.x_oss_date], ['key', sign.file_key], ['x-oss-security-token', sign.security_token],
  ]
  const body = Readable.from(multipartBody(boundary, fields, input))
  const response = await fetchWithTimeout(fetch_impl, url, {
    method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body, duplex: 'half', redirect: 'error',
  }, timeout_ms)
  if (!response.ok) throw remoteError(response.status)
}

async function* multipartBody(boundary, fields, input) {
  for (const [name, value] of fields) {
    yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
  }
  const safe_name = input.name.replace(/["\r\n]/g, '_')
  yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safe_name}"\r\nContent-Type: ${input.mimeType}\r\n\r\n`)
  if (input.data instanceof Uint8Array) yield input.data
  else for await (const chunk of createReadStream(input.path)) yield chunk
  yield Buffer.from(`\r\n--${boundary}--\r\n`)
}

async function requestData(fetch_impl, url, init, timeout_ms, oauth_client) {
  let response = await fetchWithTimeout(fetch_impl, url, { ...init, redirect: 'error' }, timeout_ms)
  if (response.status === 401 && typeof oauth_client?.refreshAfterUnauthorized === 'function') {
    await oauth_client.refreshAfterUnauthorized()
    response = await fetchWithTimeout(fetch_impl, url, {
      ...init, headers: { ...init.headers, ...await getAuthHeaders(oauth_client), }, redirect: 'error',
    }, timeout_ms)
  }
  if (!response.ok) throw remoteError(response.status)
  const content_type = response.headers.get('content-type') || ''
  if (!content_type.includes('application/json')) throw new Error('The Baimiao API returned an invalid response.')
  const envelope = JSON.parse((await readLimitedBody(response.body, MAX_JSON_BYTES)).toString('utf8'))
  if (envelope?.code !== 200 || !envelope.data || typeof envelope.data !== 'object') {
    throw publicError('REMOTE_TASK_REJECTED', safeMessage(envelope?.message, 'The Baimiao service rejected the request.'))
  }
  return envelope.data
}

function normalizeOcrTask(task_id, kind, payload) {
  const data = payload?.result ?? payload
  const vendor = safeText(payload?.vendor, 64)
  let result
  let bytes
  if (kind === 'table' && typeof data?.download_url === 'string') {
    result = {
      format: 'xlsx',
      download_url: data.download_url,
      preview_url: data.preview_url,
      vendor,
    }
  } else {
    const text = extractOcrText(data, kind)
    if (text) {
      result = { format: 'text', text, data, vendor }
      bytes = Buffer.from(text, 'utf8')
    } else {
      const json = `${JSON.stringify(data, null, 2)}\n`
      result = { format: 'json', data, vendor }
      bytes = Buffer.from(json, 'utf8')
    }
  }
  return {
    task_id, status: 'completed', stage: 'completed', progress: 100,
    message: 'OCR completed.', result, bytes,
  }
}

function extractOcrText(value, kind) {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  const preferred = kind === 'latex' ? ['latex', 'text', 'content'] : ['text', 'content', 'words']
  for (const key of preferred) {
    if (typeof value[key] === 'string' && value[key]) return value[key]
  }
  if (Array.isArray(value)) return value.map((item) => extractOcrText(item, kind)).filter(Boolean).join('\n')
  for (const key of ['pages', 'paragraphs', 'blocks', 'lines', 'words_result', 'result']) {
    const text = extractOcrText(value[key], kind)
    if (text) return text
  }
  return ''
}

async function fetchWithTimeout(fetch_impl, url, init, timeout_ms) {
  try {
    return await fetch_impl(url, { ...init, signal: AbortSignal.timeout(timeout_ms) })
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw publicError('REMOTE_TIMEOUT', 'The Baimiao request timed out.')
    }
    throw error
  }
}

async function readLimitedBody(body, max_bytes) {
  if (!body) throw new Error('The Baimiao API returned an empty response.')
  const chunks = []
  let total = 0
  for await (const chunk of Readable.fromWeb(body)) {
    const bytes = Buffer.from(chunk)
    total += bytes.length
    if (total > max_bytes) throw publicError('REMOTE_RESPONSE_TOO_LARGE', 'The Baimiao response exceeds the size limit.')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

async function* limitBody(body, max_bytes) {
  let total = 0
  for await (const chunk of Readable.fromWeb(body)) {
    const bytes = Buffer.from(chunk)
    total += bytes.length
    if (total > max_bytes) throw publicError('RESULT_TOO_LARGE', 'The Baimiao result exceeds the download limit.')
    yield bytes
  }
}

function validateUploadSign(value) {
  const required = ['host', 'file_key', 'policy', 'signature', 'x_oss_credential', 'x_oss_date', 'security_token']
  if (!value || required.some((key) => typeof value[key] !== 'string' || !value[key])) {
    throw new Error('The Baimiao API returned an invalid upload signature.')
  }
}

function normalizeRemoteTask(value, task_id) {
  const status = value.status === 'cancelled' ? 'canceled' : value.status
  return {
    task_id: value.task_id || task_id,
    status,
    stage: value.stage,
    progress: value.progress,
    message: value.message,
    result: value.result,
    error: value.error,
  }
}

function omitBytes(value) { const { bytes, ...rest } = value; return rest }
function parseApiBaseUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname))) {
    throw new Error('BAIMIAO_MCP_API_BASE_URL must use HTTPS except on loopback.')
  }
  return url.href.endsWith('/') ? url : new URL(`${url.href}/`)
}
function secureDownloadUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw publicError('INVALID_REMOTE_RESPONSE', 'The Baimiao service returned an invalid result URL.')
  }
  return url
}
function jsonHeaders(headers) { return { ...headers, 'content-type': 'application/json' } }
function safeMessage(value, fallback) { return typeof value === 'string' && value ? value.slice(0, 500) : fallback }
function safeText(value, max_length) { return typeof value === 'string' && value ? value.slice(0, max_length) : undefined }
function remoteError(status) {
  if (status === 401 || status === 403) return publicError('AUTH_REQUIRED', 'Baimiao authorization is required or has expired. Run login_baimiao and retry.', { login_url: LOGIN_URL })
  if (status === 402) return publicError('INSUFFICIENT_CREDITS', 'The Baimiao account does not have enough credits for this task.')
  if (status === 413) return publicError('FILE_TOO_LARGE', 'The input file exceeds the remote service limit.')
  if (status === 404) return publicError('TASK_NOT_FOUND', 'The Baimiao task was not found.')
  return publicError('REMOTE_SERVICE_ERROR', `The Baimiao service returned HTTP ${status}.`)
}
function publicError(code, message, details) { return Object.assign(new Error(message), { code, publicMessage: message, details }) }

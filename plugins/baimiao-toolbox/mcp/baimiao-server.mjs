import { lstat, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'

import { PDFDocument } from '../skills/baimiao-local-media/assets/pdf-lib/pdf-lib.mjs'
import { createLocalArtifactTransactions } from '../skills/baimiao-local-media/scripts/local-artifact-transaction.mjs'
import { createOcrInputPreparer } from '../skills/baimiao-local-media/scripts/ocr-input-preparation.mjs'
import { LOCAL_OPERATION_CATALOG } from '../skills/baimiao-local-media/scripts/operation-catalog.mjs'

const BASE_URL = 'https://pdf.baimiaoapp.com'
const LOCALE_SLUGS = Object.freeze({
  'zh-CN': '', 'zh-TW': 'zh-hant', en: 'en', ja: 'ja', ko: 'ko', es: 'es', pt: 'pt',
  de: 'de', fr: 'fr', it: 'it', ru: 'ru', id: 'id',
})
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const PDF_EXTENSIONS = new Set(['.pdf'])
const OCR_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.heic', '.heif', '.tif', '.tiff'])
const TRANSLATION_LANGUAGES = Object.freeze([
  'zh', 'cht', 'en', 'jp', 'kor', 'spa', 'ru', 'yue', 'th', 'pt', 'el', 'bul', 'fin',
  'slo', 'wyw', 'fra', 'ara', 'de', 'nl', 'est', 'cs', 'swe', 'vie', 'it', 'pl', 'dan',
  'rom', 'hu',
])
const DEFAULT_MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2024-11-05'])
export const LATEST_SUPPORTED_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS.at(-1)
const CAPABILITIES = Object.freeze([
  ...LOCAL_OPERATION_CATALOG.map((item) => capability(
    item.name,
    item.route,
    'local-cli',
    false,
    false,
    item.category,
  )),
  capability('pdf-to-word', '/pdf-to-word', 'mcp-remote', true, true, 'remote'),
  capability('pdf-to-markdown', '/pdf-to-markdown', 'mcp-remote', true, true, 'remote'),
  capability('pdf-to-ppt', '/pdf-to-ppt', 'mcp-remote', true, true, 'remote'),
  capability('pdf-to-excel', '/pdf-to-excel', 'mcp-remote', true, true, 'remote'),
  capability('pdf-translate', '/pdf-to-word-translation', 'mcp-remote', true, true, 'remote'),
  capability('ocr-text', '/image-ocr', 'mcp-remote', true, true, 'remote'),
  capability('ocr-latex', '/image-to-latex', 'mcp-remote', true, true, 'remote'),
  capability('ocr-table', '/image-to-excel', 'mcp-remote', true, true, 'remote'),
  capability('account-info', '/pdf-tools', 'browser-account', false, true, 'account'),
  capability('pricing', '/pricing', 'browser-account', false, false, 'account'),
])
const CAPABILITY_MAP = new Map(CAPABILITIES.map((item) => [item.name, item]))

const mutationAnnotations = Object.freeze({ readOnlyHint: false, destructiveHint: false, openWorldHint: true })
const readAnnotations = Object.freeze({ readOnlyHint: true, destructiveHint: false, openWorldHint: true })
const tools = [
  {
    name: 'login_baimiao',
    description: 'Authorize this local Baimiao MCP through the system browser using OAuth 2.1 Authorization Code with PKCE.',
    inputSchema: objectSchema({}),
    annotations: mutationAnnotations,
  },
  {
    name: 'get_baimiao_auth_status',
    description: 'Check whether this local Baimiao MCP has a current OAuth credential without exposing it.',
    inputSchema: objectSchema({}),
    annotations: { ...readAnnotations, openWorldHint: false },
  },
  {
    name: 'logout_baimiao',
    description: 'Remove the locally stored Baimiao OAuth credential.',
    inputSchema: objectSchema({}),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: 'list_baimiao_capabilities',
    description: 'List Baimiao PDF and image capabilities with their local or remote execution boundary.',
    inputSchema: objectSchema({ category: { type: 'string', enum: ['all', 'pdf', 'image', 'remote', 'account'] } }),
    annotations: { ...readAnnotations, openWorldHint: false },
  },
  {
    name: 'get_baimiao_execution_plan',
    description: 'Resolve one Baimiao capability to its execution channel and consent requirements.',
    inputSchema: objectSchema({
      operation: { type: 'string', enum: CAPABILITIES.map((item) => item.name) },
      locale: { type: 'string', enum: Object.keys(LOCALE_SLUGS) },
    }, ['operation']),
    annotations: { ...readAnnotations, openWorldHint: false },
  },
  {
    name: 'start_baimiao_conversion',
    description: 'Upload a local PDF under the Baimiao OAuth grant and submit an asynchronous Word, Markdown, PowerPoint, or Excel conversion.',
    inputSchema: objectSchema({
      input_path: absolutePathSchema('Existing local PDF to upload.'),
      format: { type: 'string', enum: ['docx', 'markdown', 'ppt', 'excel'] },
    }, ['input_path', 'format']),
    annotations: mutationAnnotations,
  },
  {
    name: 'start_baimiao_translation',
    description: 'Upload a local PDF under the Baimiao OAuth grant and submit an asynchronous translation.',
    inputSchema: objectSchema({
      input_path: absolutePathSchema('Existing local PDF to upload.'),
      target_language: { type: 'string', enum: TRANSLATION_LANGUAGES },
      mode: { type: 'string', enum: ['normal', 'compare'] },
    }, ['input_path', 'target_language', 'mode']),
    annotations: mutationAnnotations,
  },
  {
    name: 'start_baimiao_ocr',
    description: 'Upload a local image under the Baimiao OAuth grant and return completed text, formula, or table OCR.',
    inputSchema: objectSchema({
      input_path: absolutePathSchema('Existing local image to upload.'),
      kind: { type: 'string', enum: ['text', 'latex', 'table'] },
    }, ['input_path', 'kind']),
    annotations: mutationAnnotations,
  },
  {
    name: 'get_baimiao_task',
    description: 'Read the normalized status and result metadata for a previously submitted Baimiao task.',
    inputSchema: objectSchema({ task_id: taskIdSchema() }, ['task_id']),
    annotations: readAnnotations,
  },
  {
    name: 'save_baimiao_result',
    description: 'Download a completed task result to a new absolute local path. Existing files are never overwritten.',
    inputSchema: objectSchema({
      task_id: taskIdSchema(),
      output_path: absolutePathSchema('New local result path; its parent directory must exist.'),
    }, ['task_id', 'output_path']),
    annotations: mutationAnnotations,
  },
]

export async function createBaimiaoServer({
  adapter,
  max_download_bytes = DEFAULT_MAX_DOWNLOAD_BYTES,
  ocr_image_converter,
} = {}) {
  const remote = adapter || await loadAdapter()
  return {
    async handleRequest(request) {
      if (request.method === 'initialize') {
        return result(request.id, {
          protocolVersion: negotiateProtocolVersion(request.params?.protocolVersion),
          capabilities: { tools: {} },
          serverInfo: { name: 'baimiao-toolbox', version: '0.5.0' },
        })
      }
      if (request.method === 'notifications/initialized') return null
      if (request.method === 'ping') return result(request.id, {})
      if (request.method === 'tools/list') return result(request.id, { tools })
      if (request.method === 'tools/call') {
        return result(request.id, await callTool(
          remote,
          request.params,
          max_download_bytes,
          ocr_image_converter,
        ))
      }
      if (request.id === undefined) return null
      return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found.' } }
    },
  }
}

function negotiateProtocolVersion(requestedVersion) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)
    ? requestedVersion
    : LATEST_SUPPORTED_PROTOCOL_VERSION
}

async function callTool(adapter, { name, arguments: args = {} } = {}, max_download_bytes, ocr_image_converter) {
  try {
    if (name === 'login_baimiao') return toolResult(await requireAdapterMethod(adapter, 'login')())
    if (name === 'get_baimiao_auth_status') return toolResult(await requireAdapterMethod(adapter, 'authStatus')())
    if (name === 'logout_baimiao') return toolResult(await requireAdapterMethod(adapter, 'logout')())
    if (name === 'list_baimiao_capabilities') {
      const category = args.category || 'all'
      return toolResult({ capabilities: category === 'all' ? CAPABILITIES : CAPABILITIES.filter((item) => item.category === category) })
    }
    if (name === 'get_baimiao_execution_plan') return executionPlan(args)
    if (name === 'start_baimiao_conversion') {
      const format = requireEnum(args.format, ['docx', 'markdown', 'ppt', 'excel'], 'format')
      const input = await inspectInput(args.input_path, PDF_EXTENSIONS)
      return toolResult(normalizeSubmission(await adapter.submit({
        operation: 'conversion', input, options: { format },
      })))
    }
    if (name === 'start_baimiao_translation') {
      const mode = requireEnum(args.mode, ['normal', 'compare'], 'mode')
      const input = await inspectInput(args.input_path, PDF_EXTENSIONS)
      return toolResult(normalizeSubmission(await adapter.submit({
        operation: 'pdf-translate', input,
        options: { target_language: requireEnum(args.target_language, TRANSLATION_LANGUAGES, 'target_language'), mode },
      })))
    }
    if (name === 'start_baimiao_ocr') {
      const kind = requireEnum(args.kind, ['text', 'latex', 'table'], 'kind')
      const input = await createOcrInputPreparer(ocr_image_converter ? { convert: ocr_image_converter } : undefined)(
        await inspectInput(args.input_path, OCR_EXTENSIONS),
        ocr_image_converter,
      )
      return toolResult(normalizeSubmission(await adapter.submit({
        operation: 'ocr', input, options: { kind },
      })))
    }
    if (name === 'get_baimiao_task') {
      const task_id = validateTaskId(args.task_id)
      return toolResult(normalizeTask(await adapter.getTask({ task_id })))
    }
    if (name === 'save_baimiao_result') return toolResult(await saveResult(adapter, args, max_download_bytes))
    return toolError('Unknown tool.')
  } catch (error) {
    return toolError(error?.publicMessage || error?.message || 'Baimiao tool failed.', error?.code, error?.details)
  }
}

function requireAdapterMethod(adapter, name) {
  if (typeof adapter?.[name] !== 'function') throw publicError('AUTH_ADAPTER_UNAVAILABLE', 'The configured adapter does not support Baimiao OAuth management.')
  return adapter[name].bind(adapter)
}

function executionPlan(args) {
  const item = CAPABILITY_MAP.get(args.operation)
  if (!item) return toolError('Unknown Baimiao operation.')
  const locale = args.locale || 'zh-CN'
  const slug = LOCALE_SLUGS[locale]
  const localizedPrefix = slug ? `/${slug}` : ''
  return toolResult({
    ...item,
    url: `${BASE_URL}${localizedPrefix}${item.route}`,
    instructions: getInstructions(item),
  })
}

async function saveResult(adapter, args, max_download_bytes) {
  const task_id = validateTaskId(args.task_id)
  const outputPath = requireAbsolutePath(args.output_path, 'output_path')
  const parent = path.dirname(outputPath)
  const parentInfo = await stat(parent).catch(() => null)
  if (!parentInfo?.isDirectory()) throw publicError('OUTPUT_PARENT_MISSING', 'The output parent directory does not exist.')
  const task = normalizeTask(await adapter.getTask({ task_id }))
  if (task.status !== 'completed') throw publicError('RESULT_NOT_READY', 'The Baimiao task result is not ready to download.')
  let committed
  try {
    committed = await createLocalArtifactTransactions().commitStream({
      path: outputPath,
      stream: toNodeStream(await adapter.download({ task_id })),
      maxBytes: max_download_bytes,
    })
  } catch (error) {
    if (error?.code === 'ARTIFACT_TOO_LARGE') {
      throw publicError('RESULT_TOO_LARGE', 'The Baimiao result exceeds the local download limit.')
    }
    throw error
  }
  return {
      task_id,
      status: 'completed',
      output: { path: outputPath, bytes: committed.bytes, format: task.result?.format },
    }
}

function toNodeStream(value) {
  if (value instanceof Uint8Array) return Readable.from([value])
  if (value?.pipe) return value
  if (value?.getReader) return Readable.fromWeb(value)
  throw publicError('INVALID_REMOTE_RESPONSE', 'The remote service returned an invalid download stream.')
}

async function inspectInput(value, extensions) {
  const inputPath = requireAbsolutePath(value, 'input_path')
  const extension = path.extname(inputPath).toLowerCase()
  if (!extensions.has(extension)) throw publicError('UNSUPPORTED_INPUT', 'The input file type is not supported for this remote operation.')
  const info = await lstat(inputPath).catch(() => null)
  if (!info?.isFile()) throw publicError('INPUT_NOT_FILE', 'The input path must be an existing regular file.')
  const input = { path: inputPath, name: path.basename(inputPath), size: info.size, mimeType: mimeTypeFor(extension) }
  if (extension === '.pdf') {
    try {
      const pdf = await PDFDocument.load(await readFile(inputPath), { updateMetadata: false })
      input.num_pages = pdf.getPageCount()
    } catch {
      throw publicError('INVALID_PDF', 'The input PDF could not be read.')
    }
    if (input.num_pages <= 0) throw publicError('INVALID_PDF', 'The input PDF has no pages.')
  }
  return input
}

function normalizeSubmission(value) {
  const normalized = {
    task_id: validateTaskId(value?.task_id),
    status: normalizeStatus(value?.status || 'queued'),
    stage: safeShortText(value?.stage, 64),
    progress: Number.isFinite(value?.progress) ? Math.max(0, Math.min(100, Math.round(value.progress))) : undefined,
    message: safeShortText(value?.message, 500),
  }
  if (normalized.status === 'completed' && value?.result) normalized.result = normalizeResult(value.result)
  return stripUndefined(normalized)
}

function normalizeTask(value) {
  const status = normalizeStatus(value?.status)
  const normalized = {
    task_id: validateTaskId(value?.task_id), status,
    stage: safeShortText(value?.stage, 64),
    message: safeShortText(value?.message, 500),
  }
  if (Number.isFinite(value?.progress)) normalized.progress = Math.max(0, Math.min(100, Math.round(value.progress)))
  if (value?.error?.code) normalized.error = {
    code: safeShortText(value.error.code, 64), message: safeShortText(value.error.message, 500),
  }
  if (status === 'completed' && value?.result) normalized.result = normalizeResult(value.result)
  return stripUndefined(normalized)
}

function normalizeResult(value) {
  const result = {
    format: safeShortText(value.format, 32),
    vendor: safeShortText(value.vendor, 64),
    text: typeof value.text === 'string' ? value.text.slice(0, 200_000) : undefined,
  }
  if (value.data !== undefined) {
    const serialized = JSON.stringify(value.data)
    if (serialized.length <= 1_000_000) result.data = JSON.parse(serialized)
  }
  return stripUndefined(result)
}

function normalizeStatus(value) {
  if (!['queued', 'processing', 'completed', 'failed', 'canceled'].includes(value)) {
    throw publicError('INVALID_REMOTE_RESPONSE', 'The remote service returned an invalid task status.')
  }
  return value
}

async function loadAdapter() {
  const modulePath = process.env.BAIMIAO_MCP_ADAPTER_MODULE
  if (modulePath) {
    if (!path.isAbsolute(modulePath)) throw new Error('BAIMIAO_MCP_ADAPTER_MODULE must be an absolute path.')
    const loaded = await import(pathToFileURL(modulePath))
    return loaded.createAdapter()
  }
  const { createAdapter } = await import('./baimiao-http-adapter.mjs')
  return createAdapter()
}

function validateTaskId(value) {
  if (typeof value !== 'string' || !TASK_ID_PATTERN.test(value)) throw publicError('INVALID_TASK_ID', 'The task ID is invalid.')
  return value
}

function requireEnum(value, allowed, name) {
  if (!allowed.includes(value)) throw publicError('INVALID_ARGUMENT', `${name} is invalid.`)
  return value
}

function requireAbsolutePath(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value) {
    throw publicError('ABSOLUTE_PATH_REQUIRED', `${name} must be a normalized absolute path.`)
  }
  return value
}

function safeShortText(value, length) {
  return typeof value === 'string' && value ? value.slice(0, length) : undefined
}

function mimeTypeFor(extension) {
  return ({
    '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.bmp': 'image/bmp', '.heic': 'image/heic', '.heif': 'image/heif',
    '.tif': 'image/tiff', '.tiff': 'image/tiff',
  })[extension] || 'application/octet-stream'
}

function capability(name, route, channel, uploads_file, requires_auth, category) {
  return Object.freeze({
    name, route, channel, uploads_file, requires_auth,
    requires_user_confirmation: false,
    consent_via_oauth: uploads_file,
    category,
  })
}

function getInstructions(item) {
  if (item.channel === 'local-cli') return 'Use the bundled local CLI and preserve all inputs.'
  if (item.channel === 'mcp-remote') return 'State which local file will be uploaded and that credits may be used, then call the matching start tool under the existing OAuth grant.'
  return 'Open the Baimiao account page and require explicit confirmation before purchases or account changes.'
}

function objectSchema(properties, required = []) {
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false }
}

function absolutePathSchema(description) { return { type: 'string', minLength: 1, description } }
function taskIdSchema() { return { type: 'string', pattern: TASK_ID_PATTERN.source } }
function stripUndefined(value) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) }
function publicError(code, message) { return Object.assign(new Error(message), { code, publicMessage: message }) }
function toolResult(structuredContent) { return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent } }
function toolError(message, code = 'TOOL_ERROR', details = {}) {
  const structuredContent = { error: { code, message, ...details } }
  return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent, isError: true }
}
function result(id, value) { return { jsonrpc: '2.0', id, result: value } }

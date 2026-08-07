#!/usr/bin/env node

import { realpathSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { CliError, parseCliArguments } from './cli-options.mjs'
import { PdfLibError, createPdfLibNodeAdapter } from './pdf-lib-node-adapter.mjs'
import { QpdfError, createQpdfNodeAdapter } from './qpdf-node-adapter.mjs'
import { MEDIA_OPERATIONS, runMediaOperation } from './media-node-adapter.mjs'
import { createLocalArtifactTransactions } from './local-artifact-transaction.mjs'
import { QPDF_OPERATION_NAMES } from './operation-catalog.mjs'
import { createLocalOperationHandlers } from './operation-handlers.mjs'

const transactions = createLocalArtifactTransactions()
const operationHandlers = createLocalOperationHandlers({ transactions, runMediaOperation })

export const executeLocalOperation = async (
  argv,
  { readSecret = readSecretFromStdin } = {},
) => {
  const { operation, options } = parseCliArguments(argv)
  const handler = operationHandlers[operation]
  if (!handler) throw new CliError('INVALID_ARGUMENT', `Operation ${operation} is not supported.`)
  if (MEDIA_OPERATIONS.has(operation)) return handler({ operation, options })
  const imageOperation = operation === 'images-to-pdf'
  const inputs = await Promise.all(
    options.inputs.map(imageOperation ? resolveImageInput : resolvePdfInput),
  )
  if (!imageOperation) rejectDuplicateInputs(inputs)

  const qpdfOperation = QPDF_OPERATION_NAMES.includes(operation)
  const adapter = qpdfOperation
    ? await createQpdfNodeAdapter()
    : createPdfLibNodeAdapter()
  let backend = qpdfOperation ? 'qpdf.wasm' : 'pdf-lib'
  const result = await handler({
    operation,
    options,
    inputs,
    adapter,
    backend,
    readSecret,
    resolveImageInput,
  })
  return result?.ok ? { ...result, backend } : result
}

const resolvePdfInput = async (inputPath) => {
  if (!path.isAbsolute(inputPath)) {
    throw new CliError('INVALID_ARGUMENT', 'Input paths must be absolute.')
  }

  let resolved
  let inputStat
  try {
    resolved = await realpath(inputPath)
    inputStat = await stat(resolved)
  } catch {
    throw new CliError('INPUT_NOT_FOUND', 'An input file does not exist or cannot be read.')
  }

  if (!inputStat.isFile()) {
    throw new CliError('INPUT_NOT_PDF', 'Every input must be a regular PDF file.')
  }
  if (inputStat.size === 0) {
    throw new CliError('INPUT_NOT_PDF', 'An input PDF is empty.')
  }

  let data
  try {
    data = await readFile(resolved)
  } catch {
    throw new CliError('INPUT_NOT_FOUND', 'An input file cannot be read.')
  }

  if (!data.subarray(0, Math.min(data.length, 1024)).includes('%PDF-')) {
    throw new CliError('INPUT_NOT_PDF', 'An input file does not contain a PDF header.')
  }
  return { path: resolved, data }
}

const resolveImageInput = async (inputPath) => {
  const input = await resolveRegularFile(inputPath, 'image')
  const png = input.data.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  )
  const jpeg = input.data[0] === 0xff && input.data[1] === 0xd8 && input.data[2] === 0xff
  if (!png && !jpeg) {
    throw new CliError('INPUT_NOT_IMAGE', 'Images to PDF accepts only readable PNG and JPEG files.')
  }
  return { ...input, type: png ? 'image/png' : 'image/jpeg' }
}

const resolveRegularFile = async (inputPath, label) => {
  if (!path.isAbsolute(inputPath)) {
    throw new CliError('INVALID_ARGUMENT', 'Input paths must be absolute.')
  }
  let resolved
  let inputStat
  try {
    resolved = await realpath(inputPath)
    inputStat = await stat(resolved)
  } catch {
    throw new CliError('INPUT_NOT_FOUND', 'An input file does not exist or cannot be read.')
  }
  if (!inputStat.isFile() || inputStat.size === 0) {
    throw new CliError(
      label === 'image' ? 'INPUT_NOT_IMAGE' : 'INPUT_NOT_PDF',
      `Every input must be a non-empty ${label} file.`,
    )
  }
  try {
    return { path: resolved, data: await readFile(resolved) }
  } catch {
    throw new CliError('INPUT_NOT_FOUND', 'An input file cannot be read.')
  }
}

const readSecretFromStdin = async (operation) => {
  if (process.stdin.isTTY) {
    throw new CliError(
      'PASSWORD_REQUIRED',
      'Provide the password as one JSON object on stdin; never use arguments or environment variables.',
    )
  }
  const chunks = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += chunk.byteLength
    if (size > 4096) throw new CliError('INVALID_SECRET_INPUT', 'Secret input exceeds 4 KiB.')
    chunks.push(chunk)
  }
  let secret
  try {
    secret = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new CliError('INVALID_SECRET_INPUT', 'Secret input must be one valid JSON object.')
  }
  const password = operation === 'encrypt' ? secret?.userPassword : secret?.password
  if (typeof password !== 'string' || password.length < 1 || password.length > 127) {
    throw new CliError('INVALID_SECRET_INPUT', 'A password from 1 to 127 characters is required.')
  }
  if (password.includes('\0')) {
    throw new CliError('INVALID_SECRET_INPUT', 'Passwords cannot contain NUL characters.')
  }
  if (operation === 'encrypt') {
    const ownerPassword = secret.ownerPassword ?? password
    if (typeof ownerPassword !== 'string' || ownerPassword.length < 1 || ownerPassword.length > 127
      || ownerPassword.includes('\0')) {
      throw new CliError('INVALID_SECRET_INPUT', 'ownerPassword must contain 1 to 127 characters.')
    }
    return { userPassword: password, ownerPassword }
  }
  return { password }
}

const rejectDuplicateInputs = (inputs) => {
  const paths = inputs.map((input) => input.path)
  if (new Set(paths).size !== paths.length) {
    throw new CliError('INVALID_ARGUMENT', 'Duplicate input files are not allowed.')
  }
}

const isDirectInvocation = process.argv[1]
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))

if (isDirectInvocation) {
  try {
    const result = await executeLocalOperation(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    const normalized = normalizeError(error)
    process.stderr.write(`[baimiao] ${normalized.code}: ${normalized.message}\n`)
    process.stdout.write(`${JSON.stringify({ ok: false, error: normalized })}\n`)
    process.exitCode = 1
  }
}

function normalizeError(error) {
  if (error instanceof CliError || error instanceof QpdfError || error instanceof PdfLibError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    }
  }
  return { code: 'PROCESSING_FAILED', message: 'The PDF could not be processed.' }
}

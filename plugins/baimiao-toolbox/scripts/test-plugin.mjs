import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { PDFDocument } from '../skills/baimiao-local-media/assets/pdf-lib/pdf-lib.mjs'
import { LOCAL_OPERATION_NAMES } from '../skills/baimiao-local-media/scripts/operation-catalog.mjs'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const sourcePlugin = process.env.BAIMIAO_PDF_PLUGIN_PATH
  ? path.resolve(process.env.BAIMIAO_PDF_PLUGIN_PATH)
  : projectRoot
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'baimiao-toolbox-plugin-test-'))
const runtimeCache = process.env.BAIMIAO_TEST_RUNTIME_CACHE || path.join(temporaryRoot, 'runtime-cache')
process.env.BAIMIAO_PDF_RUNTIME_CACHE = runtimeCache
let testMagickPromise

try {
  const isolatedPlugin = path.join(temporaryRoot, 'plugin')
  const workDir = path.join(temporaryRoot, 'work')
  await cp(sourcePlugin, isolatedPlugin, { recursive: true })
  await mkdir(workDir)

  const noticeFiles = [
    'THIRD_PARTY_NOTICES.md',
    'third-party/EMSCRIPTEN-LICENSE.txt',
    'third-party/FFMPEG-GPL-2.0.txt',
    'third-party/IMAGEMAGICK-LICENSE.txt',
    'third-party/IMAGEMAGICK-NOTICE.txt',
    'third-party/LIBJPEG-README.txt',
    'third-party/MUSL-COPYRIGHT.txt',
    'third-party/NOTO-SANS-CJK-OFL.txt',
    'third-party/ONNXRUNTIME-LICENSE.txt',
    'third-party/PDF-LIB-LICENSE.txt',
    'third-party/PDFIUM-LICENSE.txt',
    'third-party/PDFIUM-WRAPPER-LICENSE.txt',
    'third-party/QPDF-LICENSE.txt',
    'third-party/QPDF-NOTICE.md',
    'third-party/RMBG-1.4-LICENSE.txt',
    'third-party/ZLIB-LICENSE.txt',
  ]
  for (const file of noticeFiles) {
    assert((await readFile(path.join(isolatedPlugin, file), 'utf8')).trim(), `${file} is empty`)
  }
  assert((await readFile(path.join(isolatedPlugin, '.mcp.json'), 'utf8')).includes('baimiao-mcp.mjs'))

  const cli = path.join(isolatedPlugin, 'skills/baimiao-local-media/scripts/baimiao.mjs')
  const mcp = path.join(isolatedPlugin, 'mcp/baimiao-mcp.mjs')
  const firstPdf = path.join(workDir, 'first.pdf')
  const secondPdf = path.join(workDir, 'second.pdf')
  await createPdf(firstPdf, 2, 200, { title: 'Private title', author: 'Baimiao test' })
  await createPdf(secondPdf, 1, 300)

  const mergedPdf = path.join(workDir, 'merged.pdf')
  const mergeResult = runCli(cli, [
    'merge',
    '--input',
    firstPdf,
    '--input',
    secondPdf,
    '--output',
    mergedPdf,
  ])
  assert.equal(mergeResult.status, 0, mergeResult.stderr)
  assert.equal(mergeResult.json.ok, true)
  assert.equal(await getPageCount(mergedPdf), 3)

  const splitDir = path.join(workDir, 'split')
  await mkdir(splitDir)
  const splitResult = runCli(cli, [
    'split',
    '--input',
    mergedPdf,
    '--ranges',
    '1,2-3',
    '--output-dir',
    splitDir,
  ])
  assert.equal(splitResult.status, 0, splitResult.stderr)
  assert.equal(splitResult.json.outputs.length, 2)
  assert.equal(await getPageCount(path.join(splitDir, 'split-1.pdf')), 1)
  assert.equal(await getPageCount(path.join(splitDir, 'split-2-3.pdf')), 2)

  const extractedPdf = path.join(workDir, 'extracted.pdf')
  const extractResult = runCli(cli, [
    'extract',
    '--input',
    mergedPdf,
    '--pages',
    '1,3',
    '--output',
    extractedPdf,
  ])
  assert.equal(extractResult.status, 0, extractResult.stderr)
  assert.equal(await getPageCount(extractedPdf), 2)

  const optimizedPdf = path.join(workDir, 'optimized.pdf')
  const optimizeResult = runCli(cli, ['optimize', '--input', mergedPdf, '--output', optimizedPdf])
  assert.equal(optimizeResult.status, 0, optimizeResult.stderr)
  assert.equal(await getPageCount(optimizedPdf), 3)

  const rotatedPdf = path.join(workDir, 'rotated.pdf')
  const rotateResult = runCli(cli, [
    'rotate',
    '--input',
    mergedPdf,
    '--pages',
    '1,3',
    '--angle',
    '90',
    '--output',
    rotatedPdf,
  ])
  assert.equal(rotateResult.status, 0, rotateResult.stderr)
  assert.deepEqual(await getPageRotations(rotatedPdf), [90, 0, 90])

  const deletedPdf = path.join(workDir, 'deleted.pdf')
  const deleteResult = runCli(cli, [
    'delete',
    '--input',
    mergedPdf,
    '--pages',
    '2',
    '--output',
    deletedPdf,
  ])
  assert.equal(deleteResult.status, 0, deleteResult.stderr)
  assert.deepEqual(await getPageWidths(deletedPdf), [200, 300])

  const reorderedPdf = path.join(workDir, 'reordered.pdf')
  const reorderResult = runCli(cli, [
    'reorder',
    '--input',
    mergedPdf,
    '--order',
    '3,1-2',
    '--output',
    reorderedPdf,
  ])
  assert.equal(reorderResult.status, 0, reorderResult.stderr)
  assert.deepEqual(await getPageWidths(reorderedPdf), [300, 200, 201])

  const reorderPlan = path.join(workDir, 'reorder-plan.json')
  await writeFile(reorderPlan, JSON.stringify({
    pages: [{ page: 2, rotation: 90 }, { type: 'blank' }, 1],
  }))
  const plannedReorderPdf = path.join(workDir, 'planned-reorder.pdf')
  const plannedReorderResult = runCli(cli, [
    'reorder-plan',
    '--input',
    firstPdf,
    '--plan',
    reorderPlan,
    '--output',
    plannedReorderPdf,
  ])
  assert.equal(plannedReorderResult.status, 0, plannedReorderResult.stderr)
  assert.deepEqual(await getPageWidths(plannedReorderPdf), [201, 201, 200])
  assert.deepEqual(await getPageRotations(plannedReorderPdf), [90, 0, 0])

  const arrayReorderPlan = path.join(workDir, 'array-reorder-plan.json')
  await writeFile(arrayReorderPlan, JSON.stringify([2, 1]))
  const arrayReorderResult = runCli(cli, [
    'reorder-plan',
    '--input',
    firstPdf,
    '--plan',
    arrayReorderPlan,
    '--output',
    path.join(workDir, 'array-reorder.pdf'),
  ])
  assert.notEqual(arrayReorderResult.status, 0)
  assert.equal(arrayReorderResult.json.error.code, 'INVALID_PLAN')

  const pageNumberPlan = path.join(workDir, 'page-number-plan.json')
  await writeFile(pageNumberPlan, JSON.stringify({
    startNumber: 7,
    position: 'bottom-right',
    format: 'page-of-total',
    style: { fontSize: 12, color: '#202020', bold: true, underline: true },
  }))
  const numberedPdf = path.join(workDir, 'numbered.pdf')
  const pageNumberResult = runCli(cli, [
    'page-numbers',
    '--input',
    firstPdf,
    '--pages',
    '2',
    '--plan',
    pageNumberPlan,
    '--output',
    numberedPdf,
  ])
  assert.equal(pageNumberResult.status, 0, pageNumberResult.stderr)
  assert.equal(pageNumberResult.json.backend, 'pdf-lib')
  assert.equal(await getPageCount(numberedPdf), 2)
  assert((await readFile(numberedPdf)).byteLength > (await readFile(firstPdf)).byteLength)

  const cleanedPdf = path.join(workDir, 'metadata-cleaned.pdf')
  const cleanupResult = runCli(cli, [
    'metadata-cleanup',
    '--input',
    firstPdf,
    '--output',
    cleanedPdf,
  ])
  assert.equal(cleanupResult.status, 0, cleanupResult.stderr)
  assert.deepEqual(
    cleanupResult.json.outputs[0].metadataCleanup.detectedFields.slice(0, 2),
    ['title', 'author'],
  )
  assert.deepEqual(await getMetadata(cleanedPdf), { title: '', author: '' })

  const imageFile = path.join(workDir, 'pixel.png')
  const secondImageFile = path.join(workDir, 'pixel-copy.png')
  const portraitImageFile = path.join(workDir, 'portrait.png')
  const pluginIcon = await readFile(path.join(isolatedPlugin, 'assets/icon.png'))
  await writeFile(imageFile, pluginIcon)
  await writeFile(secondImageFile, pluginIcon)
  await createPortraitImageFixture(isolatedPlugin, imageFile, portraitImageFile)

  const { createBaimiaoServer } = await import(pathToFileURL(path.join(isolatedPlugin, 'mcp/baimiao-server.mjs')))
  const capturedSubmissions = []
  const convertedOcrInputs = []
  const convertedJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
  const contractServer = await createBaimiaoServer({
    adapter: {
      async submit(request) {
        capturedSubmissions.push(request)
        return { task_id: `contract-${capturedSubmissions.length}`, status: 'queued' }
      },
      async getTask({ task_id }) {
        return {
          task_id, status: 'completed',
          result: {
            format: 'text', text: 'readable OCR',
            download_url: 'https://files.example/private-result',
            preview_url: 'https://files.example/private-preview',
          },
        }
      },
      async download() { return Buffer.from('123456') },
    },
    max_download_bytes: 5,
    ocr_image_converter: async (input) => {
      convertedOcrInputs.push(input)
      return convertedJpeg
    },
  })
  const initializedContract = await contractServer.handleRequest({ jsonrpc: '2.0', id: 100, method: 'initialize' })
  assert.equal(initializedContract.result.serverInfo.version, '0.6.0')
  const contractTools = await contractServer.handleRequest({ jsonrpc: '2.0', id: 101, method: 'tools/list' })
  const translationTool = contractTools.result.tools.find((tool) => tool.name === 'start_baimiao_translation')
  assert.deepEqual(translationTool.inputSchema.properties.target_language.enum, [
    'zh', 'cht', 'en', 'jp', 'kor', 'spa', 'ru', 'yue', 'th', 'pt', 'el', 'bul', 'fin',
    'slo', 'wyw', 'fra', 'ara', 'de', 'nl', 'est', 'cs', 'swe', 'vie', 'it', 'pl', 'dan',
    'rom', 'hu',
  ])
  const contractConversion = await contractServer.handleRequest({
    jsonrpc: '2.0', id: 102, method: 'tools/call',
    params: { name: 'start_baimiao_conversion', arguments: { input_path: firstPdf, format: 'docx' } },
  })
  assert.equal(contractConversion.result.structuredContent.task_id, 'contract-1')
  assert.equal(capturedSubmissions[0].input.num_pages, 2)
  const contractTranslation = await contractServer.handleRequest({
    jsonrpc: '2.0', id: 106, method: 'tools/call',
    params: { name: 'start_baimiao_translation', arguments: { input_path: firstPdf, target_language: 'en', mode: 'normal' } },
  })
  assert.equal(contractTranslation.result.structuredContent.task_id, 'contract-2')
  assert.equal(capturedSubmissions[1].input.num_pages, 2)
  assert.equal(capturedSubmissions[1].options.output_format, 'word')
  const invalidTranslationFormat = await contractServer.handleRequest({
    jsonrpc: '2.0', id: 108, method: 'tools/call',
    params: { name: 'start_baimiao_translation', arguments: { input_path: firstPdf, target_language: 'en', mode: 'normal', output_format: 'xlsx' } },
  })
  assert.equal(invalidTranslationFormat.result.structuredContent.error.code, 'INVALID_ARGUMENT')
  assert.equal(capturedSubmissions.length, 2)
  const invalidLanguage = await contractServer.handleRequest({
    jsonrpc: '2.0', id: 103, method: 'tools/call',
    params: { name: 'start_baimiao_translation', arguments: { input_path: firstPdf, target_language: 'ja', mode: 'normal' } },
  })
  assert.equal(invalidLanguage.result.structuredContent.error.code, 'INVALID_ARGUMENT')
  const pdfOcr = await contractServer.handleRequest({
    jsonrpc: '2.0', id: 107, method: 'tools/call',
    params: { name: 'start_baimiao_ocr', arguments: { input_path: firstPdf, kind: 'text' } },
  })
  assert.equal(pdfOcr.result.structuredContent.error.code, 'UNSUPPORTED_INPUT')
  for (const extension of ['heic', 'heif', 'tiff']) {
    const source = path.join(workDir, `ocr-source.${extension}`)
    await writeFile(source, Buffer.from(`source-${extension}`))
    const convertedOcr = await contractServer.handleRequest({
      jsonrpc: '2.0', id: `ocr-${extension}`, method: 'tools/call',
      params: { name: 'start_baimiao_ocr', arguments: { input_path: source, kind: 'text' } },
    })
    assert.equal(convertedOcr.result.structuredContent.status, 'queued')
    const submitted = capturedSubmissions.at(-1).input
    assert.equal(submitted.name, 'ocr-source.jpg')
    assert.equal(submitted.mimeType, 'image/jpeg')
    assert.deepEqual(submitted.data, convertedJpeg)
    assert.equal(await fileExists(source), true)
  }
  assert.equal(convertedOcrInputs.length, 3)
  const pngOcr = await contractServer.handleRequest({
    jsonrpc: '2.0', id: 'ocr-png', method: 'tools/call',
    params: { name: 'start_baimiao_ocr', arguments: { input_path: imageFile, kind: 'text' } },
  })
  assert.equal(pngOcr.result.structuredContent.status, 'queued')
  assert.equal(capturedSubmissions.at(-1).input.mimeType, 'image/png')
  assert.equal(capturedSubmissions.at(-1).input.data, undefined)
  assert.equal(convertedOcrInputs.length, 3)
  const contractOcr = await contractServer.handleRequest({
    jsonrpc: '2.0', id: 104, method: 'tools/call',
    params: { name: 'get_baimiao_task', arguments: { task_id: 'contract-ocr' } },
  })
  assert.equal(contractOcr.result.structuredContent.result.text, 'readable OCR')
  assert.equal(contractOcr.result.structuredContent.result.download_url, undefined)
  assert.equal(contractOcr.result.structuredContent.result.preview_url, undefined)
  const oversizedOutput = path.join(workDir, 'oversized-result.txt')
  const oversizedSave = await contractServer.handleRequest({
    jsonrpc: '2.0', id: 105, method: 'tools/call',
    params: { name: 'save_baimiao_result', arguments: { task_id: 'contract-ocr', output_path: oversizedOutput } },
  })
  assert.equal(oversizedSave.result.structuredContent.error.code, 'RESULT_TOO_LARGE')
  assert.equal(await fileExists(oversizedOutput), false)

  const { createAdapter: createHttpAdapter } = await import(pathToFileURL(path.join(isolatedPlugin, 'mcp/baimiao-http-adapter.mjs')))
  const requestBodies = []
  const tableBytes = Buffer.from('real-table-file')
  let ocrKind = 'text'
  const httpAdapter = createHttpAdapter({
    oauth_client: {
      async getAuthorizationHeaders() { return { authorization: `Bearer ${randomBytes(24).toString('base64url')}` } },
      async login() {}, async status() {}, async logout() {},
    },
    request_timeout_ms: 1_000,
    max_download_bytes: 1024,
    fetch_impl: async (url, init = {}) => {
      assert(init.signal instanceof AbortSignal, `Missing timeout signal for ${url}`)
      const requestUrl = String(url)
      if (requestUrl.includes('/aliyun/oss/sign')) {
        return apiResponse(makeUploadSession())
      }
      if (requestUrl.startsWith('https://upload.example/')) {
        for await (const _chunk of init.body) { /* drain the upload */ }
        return new Response('', { status: 200 })
      }
      if (requestUrl.endsWith('/pdf/convert')) {
        requestBodies.push(JSON.parse(init.body))
        return apiResponse({ task_id: 'remote-conversion' })
      }
      if (requestUrl.endsWith('/pdf/translate')) {
        requestBodies.push(JSON.parse(init.body))
        return apiResponse({ task_id: 'remote-translation' })
      }
      if (requestUrl.includes('/ocr/')) {
        if (ocrKind === 'text') return apiResponse({ vendor: 'mock', result: { pages: [{ content: 'Hello OCR' }] } })
        if (ocrKind === 'latex') return apiResponse({ vendor: 'mock', result: { latex: 'x^2' } })
        if (ocrKind === 'table') return apiResponse({ vendor: 'mock', result: { download_url: 'https://files.example/table.xlsx' } })
        return apiResponse({ vendor: 'mock', result: { confidence: 0.95 } })
      }
      if (requestUrl === 'https://files.example/table.xlsx') return new Response(tableBytes, { status: 200, headers: { 'content-length': String(tableBytes.length) } })
      throw new Error(`Unexpected adapter URL: ${requestUrl}`)
    },
  })
  await httpAdapter.submit({
    operation: 'conversion',
    input: { path: firstPdf, name: 'first.pdf', size: (await stat(firstPdf)).size, mimeType: 'application/pdf', num_pages: 2 },
    options: { format: 'docx' },
  })
  assert.equal(requestBodies[0].num_pages, 2)
  await httpAdapter.submit({
    operation: 'pdf-translate',
    input: { path: firstPdf, name: 'first.pdf', size: (await stat(firstPdf)).size, mimeType: 'application/pdf', num_pages: 2 },
    options: { target_language: 'en', mode: 'normal', output_format: 'pdf' },
  })
  assert.equal(requestBodies[1].num_pages, 2)
  assert.equal(requestBodies[1].output_format, 'pdf')
  const textOcr = await httpAdapter.submit({
    operation: 'ocr', input: { path: imageFile, name: 'pixel.png', size: pluginIcon.length, mimeType: 'image/png' }, options: { kind: 'text' },
  })
  assert.equal(textOcr.result.text, 'Hello OCR')
  assert.equal((await httpAdapter.getTask({ task_id: textOcr.task_id })).result.text, 'Hello OCR')
  ocrKind = 'latex'
  const latexOcr = await httpAdapter.submit({
    operation: 'ocr', input: { path: imageFile, name: 'pixel.png', size: pluginIcon.length, mimeType: 'image/png' }, options: { kind: 'latex' },
  })
  assert.equal(latexOcr.result.text, 'x^2')
  ocrKind = 'table'
  const tableOcr = await httpAdapter.submit({
    operation: 'ocr', input: { path: imageFile, name: 'pixel.png', size: pluginIcon.length, mimeType: 'image/png' }, options: { kind: 'table' },
  })
  assert.equal(tableOcr.result.format, 'xlsx')
  assert.deepEqual(Buffer.from(await streamBytes(await httpAdapter.download({ task_id: tableOcr.task_id }))), tableBytes)
  ocrKind = 'json'
  const jsonOcr = await httpAdapter.submit({
    operation: 'ocr', input: { path: imageFile, name: 'pixel.png', size: pluginIcon.length, mimeType: 'image/png' }, options: { kind: 'text' },
  })
  assert.equal(jsonOcr.result.format, 'json')
  assert.equal(jsonOcr.result.text, undefined)
  assert.equal(Buffer.from(await streamBytes(await httpAdapter.download({ task_id: jsonOcr.task_id }))).toString('utf8'), '{\n  "confidence": 0.95\n}\n')
  const insecureAdapter = createHttpAdapter({
    oauth_client: {
      async getAuthorizationHeaders() { return { authorization: `Bearer ${randomBytes(24).toString('base64url')}` } },
      async login() {}, async status() {}, async logout() {},
    },
    fetch_impl: async (url, init = {}) => {
      assert(init.signal instanceof AbortSignal)
      const requestUrl = String(url)
      if (requestUrl.includes('/pdf/tasks/')) {
        return apiResponse({ task_id: 'insecure-result', status: 'completed', result: { download_url: 'http://files.example/result.pdf' } })
      }
      throw new Error(`Unexpected insecure adapter URL: ${requestUrl}`)
    },
  })
  await assert.rejects(insecureAdapter.download({ task_id: 'insecure-result' }), (error) => error.code === 'INVALID_REMOTE_RESPONSE')
  const imagePlan = path.join(workDir, 'image-plan.json')
  await writeFile(imagePlan, JSON.stringify({ pageSize: 'a4', orientation: 'portrait', margin: 24 }))
  const imagePdf = path.join(workDir, 'images.pdf')
  const imageResult = runCli(cli, [
    'images-to-pdf',
    '--input',
    imageFile,
    '--input',
    imageFile,
    '--plan',
    imagePlan,
    '--output',
    imagePdf,
  ])
  assert.equal(imageResult.status, 0, imageResult.stderr)
  assert.equal(await getPageCount(imagePdf), 2)
  assert.deepEqual((await getPageWidths(imagePdf)).map(Math.round), [595, 595])

  const mediaCases = [
    ['image-convert', { format: 'jpeg', quality: 0.82 }, 'image/jpeg'],
    ['image-compress', { format: 'webp', quality: 0.7, maxEdge: 240 }, 'image/webp'],
    ['image-resize', { mode: 'percent', value: 50, format: 'png' }, 'image/png'],
    ['image-crop', { crop: { x: 0, y: 0, width: 32, height: 24 }, format: 'png' }, 'image/png'],
    ['image-privacy-mask', { mode: 'pixelate', selection: { x: 8, y: 8, width: 24, height: 24 } }, 'image/png'],
    ['image-watermark', { text: '白描 PDF', textSize: 14, opacity: 0.3 }, 'image/png'],
    ['image-border-radius', { borderRadius: 12, borderWidth: 2, borderColor: '#22c55e' }, 'image/png'],
    ['image-rotate-flip', { rotation: 90, flipHorizontal: true }, 'image/png'],
  ]
  for (const [operation, plan, expectedType] of mediaCases) {
    const outputDir = path.join(workDir, operation)
    await mkdir(outputDir)
    const planFile = path.join(workDir, `${operation}.json`)
    await writeFile(planFile, JSON.stringify(plan))
    const result = runCli(cli, [
      operation, '--input', imageFile, '--plan', planFile, '--output-dir', outputDir,
    ])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.json.outputs.length, 1)
    assert.equal(result.json.outputs[0].type, expectedType)
    assertImageMagic(await readFile(result.json.outputs[0].path), expectedType)
  }

  const heicFile = path.join(workDir, 'pixel.heic')
  await writeFile(heicFile, Buffer.from(getHeicFixture(), 'base64'))
  const heicDir = path.join(workDir, 'heic-convert')
  await mkdir(heicDir)
  const heicResult = runCli(cli, [
    'heic-convert', '--input', heicFile, '--output-dir', heicDir,
  ])
  assert.equal(heicResult.status, 0, heicResult.stderr)
  assertImageMagic(await readFile(heicResult.json.outputs[0].path), 'image/png')
  const { convertImageForOcr } = await import(pathToFileURL(path.join(
    isolatedPlugin,
    'skills/baimiao-local-media/scripts/media-node-adapter.mjs',
  )))
  assertImageMagic(await convertImageForOcr(heicFile), 'image/jpeg')

  const renderedDir = path.join(workDir, 'pdf-to-images')
  await mkdir(renderedDir)
  const renderPlan = path.join(workDir, 'pdf-to-images.json')
  await writeFile(renderPlan, JSON.stringify({ dpi: 72, pages: [1, 2], format: 'png' }))
  const renderResult = runCli(cli, [
    'pdf-to-images', '--input', firstPdf, '--plan', renderPlan, '--output-dir', renderedDir,
  ])
  assert.equal(renderResult.status, 0, renderResult.stderr)
  assert.equal(renderResult.json.outputs.length, 2)
  for (const output of renderResult.json.outputs) {
    assertImageMagic(await readFile(output.path), 'image/png')
  }

  const lossyPdf = path.join(workDir, 'lossy.pdf')
  const lossyResult = runCli(cli, [
    'compress-lossy', '--input', imagePdf, '--output', lossyPdf,
  ])
  assert.equal(lossyResult.status, 0, lossyResult.stderr)
  assert.equal(await getPageCount(lossyPdf), 2)

  const gifFile = path.join(workDir, 'images.gif')
  const gifPlan = path.join(workDir, 'image-to-gif.json')
  await writeFile(gifPlan, JSON.stringify({ maxEdge: 64, delayMs: 100, repeat: 0 }))
  const gifResult = runCli(cli, [
    'image-to-gif', '--input', imageFile, '--input', secondImageFile,
    '--plan', gifPlan, '--output', gifFile,
  ])
  assert.equal(gifResult.status, 0, gifResult.stderr)
  assertImageMagic(await readFile(gifFile), 'image/gif')

  const gifFramesDir = path.join(workDir, 'gif-frames')
  await mkdir(gifFramesDir)
  const gifFramesResult = runCli(cli, [
    'gif-to-images', '--input', gifFile, '--output-dir', gifFramesDir,
  ])
  assert.equal(gifFramesResult.status, 0, gifFramesResult.stderr)
  assert.equal(gifFramesResult.json.outputs.length, 2)

  const videoFile = path.join(workDir, 'sample.mp4')
  await createVideoFixture(isolatedPlugin, imageFile, videoFile)
  const videoGif = path.join(workDir, 'video.gif')
  const videoPlan = path.join(workDir, 'video-to-gif.json')
  await writeFile(videoPlan, JSON.stringify({ fps: 5, maxEdge: 720, endSeconds: 0.5 }))
  const videoResult = runCli(cli, [
    'video-to-gif', '--input', videoFile, '--plan', videoPlan, '--output', videoGif,
  ])
  assert.equal(videoResult.status, 0, videoResult.stderr)
  const videoGifData = await readFile(videoGif)
  assertImageMagic(videoGifData, 'image/gif')
  assert.deepEqual(readGifDimensions(videoGifData), { width: 64, height: 64 })

  const rembgDir = path.join(workDir, 'image-rembg')
  await mkdir(rembgDir)
  const rembgResult = runCli(cli, [
    'image-rembg', '--input', portraitImageFile, '--output-dir', rembgDir,
  ])
  assert.equal(rembgResult.status, 0, rembgResult.stderr)
  assert.equal(rembgResult.json.backend, 'onnxruntime.wasm+rmbg-1.4-fp32+imagemagick.wasm')
  const rembgOutput = rembgResult.json.outputs[0].path
  assertImageMagic(await readFile(rembgOutput), 'image/png')
  const alphaCentroid = await getAlphaCentroid(isolatedPlugin, rembgOutput)
  assert(Math.abs(alphaCentroid.x - 48) < 8, `Unexpected rembg alpha x centroid: ${alphaCentroid.x}`)
  assert(Math.abs(alphaCentroid.y - 64) < 8, `Unexpected rembg alpha y centroid: ${alphaCentroid.y}`)

  const quantizedRembgDir = path.join(workDir, 'image-rembg-quint8')
  await mkdir(quantizedRembgDir)
  const quantizedRembgPlan = path.join(workDir, 'image-rembg-quint8.json')
  await writeFile(quantizedRembgPlan, JSON.stringify({ precision: 'quint8' }))
  const quantizedRembgResult = runCli(cli, [
    'image-rembg', '--input', portraitImageFile, '--plan', quantizedRembgPlan,
    '--output-dir', quantizedRembgDir,
  ])
  assert.equal(quantizedRembgResult.status, 0, quantizedRembgResult.stderr)
  assert.equal(
    quantizedRembgResult.json.backend,
    'onnxruntime.wasm+rmbg-1.4-quint8+imagemagick.wasm',
  )
  assertImageMagic(await readFile(quantizedRembgResult.json.outputs[0].path), 'image/png')

  const invalidRembgPlan = path.join(workDir, 'image-rembg-invalid.json')
  await writeFile(invalidRembgPlan, JSON.stringify({ precision: 'fp16' }))
  const invalidRembgResult = runCli(cli, [
    'image-rembg', '--input', portraitImageFile, '--plan', invalidRembgPlan,
    '--output-dir', quantizedRembgDir,
  ])
  assert.equal(invalidRembgResult.status, 1)
  assert.equal(invalidRembgResult.json.error.code, 'INVALID_PLAN')

  const watermarkPlan = path.join(workDir, 'watermark-plan.json')
  await writeFile(watermarkPlan, JSON.stringify({
    mode: 'text',
    text: 'Baimiao PDF',
    ranges: [{ start: 1, end: 1 }],
    opacity: 0.2,
    angle: 45,
    pattern: 'mosaic',
    bold: true,
    underline: true,
  }))
  const watermarkedPdf = path.join(workDir, 'watermarked.pdf')
  const watermarkResult = runCli(cli, [
    'watermark', '--input', firstPdf, '--plan', watermarkPlan, '--output', watermarkedPdf,
  ])
  assert.equal(watermarkResult.status, 0, watermarkResult.stderr)
  assert.equal(await getPageCount(watermarkedPdf), 2)
  assert((await readFile(watermarkedPdf)).byteLength > (await readFile(firstPdf)).byteLength)

  const imageWatermarkPlan = path.join(workDir, 'image-watermark-plan.json')
  await writeFile(imageWatermarkPlan, JSON.stringify({
    mode: 'image', imagePath: imageFile, imageScale: 0.2, opacity: 0.5, position: 'top-right',
  }))
  const imageWatermarkedPdf = path.join(workDir, 'image-watermarked.pdf')
  const imageWatermarkResult = runCli(cli, [
    'watermark',
    '--input',
    firstPdf,
    '--plan',
    imageWatermarkPlan,
    '--output',
    imageWatermarkedPdf,
  ])
  assert.equal(imageWatermarkResult.status, 0, imageWatermarkResult.stderr)
  assert.equal(await getPageCount(imageWatermarkedPdf), 2)

  const checkResult = runCli(cli, ['check', '--input', firstPdf])
  assert.equal(checkResult.status, 0, checkResult.stderr)
  assert.equal(checkResult.json.report.valid, true)
  assert.equal(checkResult.json.outputs.length, 0)

  const repairedPdf = path.join(workDir, 'repaired.pdf')
  const repairResult = runCli(cli, [
    'repair', '--input', firstPdf, '--output', repairedPdf,
  ])
  assert.equal(repairResult.status, 0, repairResult.stderr)
  assert.equal(await getPageCount(repairedPdf), 2)

  const linearizedPdf = path.join(workDir, 'linearized.pdf')
  const linearizeResult = runCli(cli, [
    'linearize', '--input', firstPdf, '--output', linearizedPdf,
  ])
  assert.equal(linearizeResult.status, 0, linearizeResult.stderr)
  assert((await readFile(linearizedPdf, 'latin1')).includes('/Linearized'))

  const password = 'not-in-cli-or-logs'
  const encryptedPdf = path.join(workDir, 'encrypted.pdf')
  const encryptResult = runCli(
    cli,
    ['encrypt', '--input', firstPdf, '--output', encryptedPdf],
    JSON.stringify({ userPassword: password, ownerPassword: `${password}-owner` }),
  )
  assert.equal(encryptResult.status, 0, encryptResult.stderr)
  assert(!encryptResult.stderr.includes(password))
  assert(!encryptResult.stdout.includes(password))

  const decryptedPdf = path.join(workDir, 'decrypted.pdf')
  const decryptResult = runCli(
    cli,
    ['decrypt', '--input', encryptedPdf, '--output', decryptedPdf],
    JSON.stringify({ password }),
  )
  assert.equal(decryptResult.status, 0, decryptResult.stderr)
  assert(!decryptResult.stderr.includes(password))
  assert(!decryptResult.stdout.includes(password))
  assert.equal(await getPageCount(decryptedPdf), 2)

  const mcpResponses = runMcp(mcp, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'get_baimiao_execution_plan',
        arguments: { operation: 'ocr-text', locale: 'zh-CN' },
      },
    },
  ])
  assert.equal(mcpResponses[0].result.serverInfo.name, 'baimiao-toolbox')
  assert.deepEqual(
    mcpResponses[1].result.tools.map((tool) => tool.name),
    [
      'login_baimiao', 'get_baimiao_auth_status', 'logout_baimiao',
      'list_baimiao_capabilities', 'get_baimiao_execution_plan',
      'start_baimiao_conversion', 'start_baimiao_translation', 'start_baimiao_ocr',
      'get_baimiao_task', 'save_baimiao_result',
    ],
  )
  assert.equal(mcpResponses[2].result.structuredContent.requires_user_confirmation, false)
  assert.equal(mcpResponses[2].result.structuredContent.consent_via_oauth, true)
  assert.equal(mcpResponses[2].result.structuredContent.url, 'https://pdf.baimiaoapp.com/image-ocr')

  const localCapabilityResponses = runMcp(mcp, [{
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'list_baimiao_capabilities', arguments: { category: 'all' } },
  }])
  const expectedLocalOperations = LOCAL_OPERATION_NAMES
  const declaredLocalOperations = localCapabilityResponses[0].result.structuredContent.capabilities
    .filter((capability) => capability.channel === 'local-cli')
    .map((capability) => capability.name)
  assert.deepEqual(declaredLocalOperations.toSorted(), expectedLocalOperations.toSorted())

  const mockAdapter = path.join(isolatedPlugin, 'scripts/fixtures/mock-mcp-adapter.mjs')
  const remoteOutput = path.join(workDir, 'remote-result.pdf')
  const remoteOcrOutput = path.join(workDir, 'remote-ocr-result.txt')
  const remoteResponses = runMcp(mcp, [
    {
      jsonrpc: '2.0', id: 50, method: 'tools/call',
      params: { name: 'login_baimiao', arguments: {} },
    },
    {
      jsonrpc: '2.0', id: 51, method: 'tools/call',
      params: { name: 'get_baimiao_auth_status', arguments: {} },
    },
    {
      jsonrpc: '2.0', id: 52, method: 'tools/call',
      params: { name: 'logout_baimiao', arguments: {} },
    },
    {
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'start_baimiao_conversion', arguments: { input_path: firstPdf, format: 'docx' } },
    },
    {
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'get_baimiao_task', arguments: { task_id: 'mock-task-1' } },
    },
    {
      jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: { name: 'save_baimiao_result', arguments: { task_id: 'mock-task-1', output_path: remoteOutput } },
    },
    {
      jsonrpc: '2.0', id: 9, method: 'tools/call',
      params: { name: 'save_baimiao_result', arguments: { task_id: 'mock-task-1', output_path: remoteOutput } },
    },
    {
      jsonrpc: '2.0', id: 10, method: 'tools/call',
      params: { name: 'start_baimiao_ocr', arguments: { input_path: 'relative.png', kind: 'text' } },
    },
    {
      jsonrpc: '2.0', id: 12, method: 'tools/call',
      params: { name: 'start_baimiao_ocr', arguments: { input_path: imageFile, kind: 'text' } },
    },
    {
      jsonrpc: '2.0', id: 13, method: 'tools/call',
      params: { name: 'get_baimiao_task', arguments: { task_id: 'mock-task-2' } },
    },
    {
      jsonrpc: '2.0', id: 14, method: 'tools/call',
      params: { name: 'save_baimiao_result', arguments: { task_id: 'mock-task-2', output_path: remoteOcrOutput } },
    },
  ], { BAIMIAO_MCP_ADAPTER_MODULE: mockAdapter })
  assert.equal(remoteResponses[0].result.structuredContent.authenticated, true)
  assert.equal(remoteResponses[1].result.structuredContent.authenticated, true)
  assert.deepEqual(remoteResponses[2].result.structuredContent, { authenticated: false, credentials_removed: true })
  assert.equal(remoteResponses[3].result.structuredContent.task_id, 'mock-task-1')
  assert.equal(remoteResponses[3].result.structuredContent.status, 'queued')
  assert.equal(remoteResponses[4].result.structuredContent.status, 'completed')
  assert.deepEqual(remoteResponses[4].result.structuredContent.result, { format: 'docx' })
  assert.equal(remoteResponses[5].result.structuredContent.output.path, remoteOutput)
  assert.deepEqual(await readFile(remoteOutput), await readFile(firstPdf))
  assert.equal(remoteResponses[6].result.structuredContent.error.code, 'OUTPUT_EXISTS')
  assert.equal(remoteResponses[7].result.structuredContent.error.code, 'ABSOLUTE_PATH_REQUIRED')
  assert.equal(remoteResponses[8].result.structuredContent.task_id, 'mock-task-2')
  assert.equal(remoteResponses[9].result.structuredContent.status, 'completed')
  assert.deepEqual(remoteResponses[9].result.structuredContent.result, {
    format: 'text', text: 'Readable mock OCR text.',
  })
  assert.equal(remoteResponses[10].result.structuredContent.output.path, remoteOcrOutput)
  assert.equal(remoteResponses[10].result.structuredContent.output.format, 'text')
  assert.equal(await readFile(remoteOcrOutput, 'utf8'), 'Readable mock OCR text.')
  assert(!JSON.stringify(remoteResponses).includes('ignoredSignedMaterial'))
  assert(!JSON.stringify(remoteResponses).includes('ignoredDownloadUrl'))

  const authRequired = runMcp(mcp, [{
    jsonrpc: '2.0', id: 11, method: 'tools/call',
    params: { name: 'start_baimiao_translation', arguments: {
      input_path: firstPdf, target_language: 'en', mode: 'normal',
    } },
  }], {
    BAIMIAO_MCP_ADAPTER_MODULE: mockAdapter,
    BAIMIAO_MCP_MOCK_AUTH_REQUIRED: '1',
  })[0]
  assert.equal(authRequired.result.structuredContent.error.code, 'AUTH_REQUIRED')
  assert.match(authRequired.result.structuredContent.error.message, /login_baimiao/)

  const overwriteResult = runCli(cli, ['optimize', '--input', mergedPdf, '--output', optimizedPdf])
  assert.notEqual(overwriteResult.status, 0)
  assert.equal(overwriteResult.json.error.code, 'OUTPUT_EXISTS')

  const invalidRangeResult = runCli(cli, [
    'extract',
    '--input',
    mergedPdf,
    '--pages',
    '4',
    '--output',
    path.join(workDir, 'invalid.pdf'),
  ])
  assert.notEqual(invalidRangeResult.status, 0)
  assert.equal(invalidRangeResult.json.error.code, 'INVALID_PAGE_RANGE')
  assert.equal(invalidRangeResult.json.error.details.pageCount, 3)

  const deleteAllResult = runCli(cli, [
    'delete',
    '--input',
    mergedPdf,
    '--pages',
    '1-3',
    '--output',
    path.join(workDir, 'empty.pdf'),
  ])
  assert.notEqual(deleteAllResult.status, 0)
  assert.equal(deleteAllResult.json.error.code, 'DELETE_ALL_PAGES')

  const invalidRotationResult = runCli(cli, [
    'rotate',
    '--input',
    mergedPdf,
    '--pages',
    '1',
    '--angle',
    '45',
    '--output',
    path.join(workDir, 'invalid-rotation.pdf'),
  ])
  assert.notEqual(invalidRotationResult.status, 0)
  assert.equal(invalidRotationResult.json.error.code, 'INVALID_ARGUMENT')

  const invalidOrderResult = runCli(cli, [
    'reorder',
    '--input',
    mergedPdf,
    '--order',
    '3,4,1',
    '--output',
    path.join(workDir, 'invalid-order.pdf'),
  ])
  assert.notEqual(invalidOrderResult.status, 0)
  assert.equal(invalidOrderResult.json.error.code, 'INVALID_PAGE_ORDER')
  assert.equal(invalidOrderResult.json.error.details.pageCount, 3)

  console.log(
    JSON.stringify({
      ok: true,
      operations: LOCAL_OPERATION_NAMES,
      safetyChecks: [
        'no-overwrite',
        'range-bounds',
        'delete-all-pages',
        'rotation-angle',
        'page-order-bounds',
        'password-stdin',
        'password-redaction',
      ],
      isolatedPlugin: true,
      thirdPartyNotices: true,
      mcpServer: true,
      sourcePlugin,
    }),
  )
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}

function runMcp(server, requests, env = {}) {
  const result = spawnSync(process.execPath, [server], {
    cwd: path.dirname(server),
    encoding: 'utf8',
    env: { ...process.env, ...env },
    input: `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`,
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim().split('\n').map((line) => JSON.parse(line))
}

function apiResponse(data) {
  return new Response(JSON.stringify({ code: 200, message: 'success', data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function makeUploadSession() {
  const opaque = () => randomBytes(24).toString('base64url')
  return {
    host: 'https://upload.example/',
    file_key: `uploads/${opaque()}`,
    policy: opaque(),
    signature: opaque(),
    x_oss_credential: opaque(),
    x_oss_date: '20260805T000000Z',
    security_token: opaque(),
  }
}

async function streamBytes(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function fileExists(filename) {
  return stat(filename).then(() => true, () => false)
}

function runCli(cli, args, input = undefined) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: path.dirname(cli),
    encoding: 'utf8',
    env: {
      ...process.env,
      BAIMIAO_PDF_RUNTIME_CACHE: runtimeCache,
    },
    input,
  })
  const stdout = result.stdout.trim()
  let json
  try {
    json = JSON.parse(stdout)
  } catch {
    assert.fail(`CLI stdout was not one JSON object:\n${stdout}\n${result.stderr}`)
  }
  return { status: result.status, stdout, stderr: result.stderr, json }
}

async function createPdf(filePath, pageCount, baseWidth, metadata = {}) {
  const pdf = await PDFDocument.create()
  for (let page = 0; page < pageCount; page += 1) pdf.addPage([baseWidth + page, 400])
  if (metadata.title) pdf.setTitle(metadata.title)
  if (metadata.author) pdf.setAuthor(metadata.author)
  await writeFile(filePath, await pdf.save())
}

async function getPageCount(filePath) {
  const pdf = await PDFDocument.load(await readFile(filePath))
  return pdf.getPageCount()
}

async function getPageRotations(filePath) {
  const pdf = await PDFDocument.load(await readFile(filePath))
  return pdf.getPages().map((page) => page.getRotation().angle)
}

async function getPageWidths(filePath) {
  const pdf = await PDFDocument.load(await readFile(filePath))
  return pdf.getPages().map((page) => page.getWidth())
}

async function getMetadata(filePath) {
  const pdf = await PDFDocument.load(await readFile(filePath), { updateMetadata: false })
  return { title: pdf.getTitle() || '', author: pdf.getAuthor() || '' }
}

function assertImageMagic(data, type) {
  if (type === 'image/png') assert.deepEqual([...data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  else if (type === 'image/jpeg') assert.deepEqual([...data.subarray(0, 3)], [255, 216, 255])
  else if (type === 'image/webp') {
    assert.equal(data.subarray(0, 4).toString('ascii'), 'RIFF')
    assert.equal(data.subarray(8, 12).toString('ascii'), 'WEBP')
  } else if (type === 'image/gif') assert.match(data.subarray(0, 6).toString('ascii'), /^GIF8[79]a$/)
  else assert.fail(`Unsupported image type assertion: ${type}`)
}

function readGifDimensions(data) {
  return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) }
}

async function createVideoFixture(pluginRoot, imagePath, outputPath) {
  const runtime = await loadRuntimeBundle(pluginRoot, 'ffmpeg')
  globalThis.self ||= { location: { href: import.meta.url } }
  globalThis.self.location ||= { href: import.meta.url }
  const { default: createFfmpegCore } = await import(pathToFileURL(runtime['ffmpeg-core.mjs']))
  const ffmpeg = await createFfmpegCore({ wasmBinary: await readFile(runtime['ffmpeg-core.wasm']) })
  ffmpeg.FS.writeFile('fixture.png', await readFile(imagePath))
  ffmpeg.reset()
  const exitCode = ffmpeg.exec(
    '-loop', '1', '-i', 'fixture.png', '-t', '0.6', '-r', '5',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', 'fixture.mp4',
  )
  assert.equal(exitCode, 0, 'Bundled FFmpeg could not generate the isolated video fixture.')
  await writeFile(outputPath, new Uint8Array(ffmpeg.FS.readFile('fixture.mp4')))
}

async function createPortraitImageFixture(pluginRoot, imagePath, outputPath) {
  const magick = await loadTestMagick(pluginRoot)
  const image = magick.MagickImage.create(await readFile(imagePath))
  const canvas = magick.MagickImage.create(magick.MagickColors.White, 96, 128)
  try {
    canvas.composite(image, new magick.Point(16, 32), magick.CompositeOperator.Over)
    await writeFile(outputPath, canvas.write(magick.MagickFormat.Png, (bytes) => new Uint8Array(bytes)))
  } finally {
    image.dispose()
    canvas.dispose()
  }
}

async function getAlphaCentroid(pluginRoot, imagePath) {
  const magick = await loadTestMagick(pluginRoot)
  const image = magick.MagickImage.create(await readFile(imagePath))
  try {
    const rgba = image.getPixels((pixels) => (
      pixels.toByteArray(0, 0, image.width, image.height, 'RGBA')
    ))
    let xTotal = 0
    let yTotal = 0
    let alphaTotal = 0
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const alpha = rgba[(y * image.width + x) * 4 + 3]
        xTotal += x * alpha
        yTotal += y * alpha
        alphaTotal += alpha
      }
    }
    assert(alphaTotal > 0, 'The rembg output must contain visible pixels.')
    return { x: xTotal / alphaTotal, y: yTotal / alphaTotal }
  } finally {
    image.dispose()
  }
}

function loadTestMagick(pluginRoot) {
  if (!testMagickPromise) {
    testMagickPromise = (async () => {
      const runtime = await loadRuntimeBundle(pluginRoot, 'magick')
      const magick = await import(pathToFileURL(runtime['magick.mjs']))
      await magick.initializeImageMagick(await readFile(runtime['magick.wasm']))
      return magick
    })()
  }
  return testMagickPromise
}

async function loadRuntimeBundle(pluginRoot, name) {
  const runtimeModule = path.join(pluginRoot, 'skills/baimiao-local-media/scripts/runtime-cache.mjs')
  const { ensureRuntimeBundle } = await import(pathToFileURL(runtimeModule))
  return ensureRuntimeBundle(name)
}

function getHeicFixture() {
  return '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'
}

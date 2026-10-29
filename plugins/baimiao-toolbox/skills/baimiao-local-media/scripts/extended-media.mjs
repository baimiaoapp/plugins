import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { PDFDocument } from '../assets/pdf-lib/pdf-lib.mjs'
import { CliError } from './cli-options.mjs'
import { ensureRuntimeFile } from './runtime-cache.mjs'
import { loadMagick, loadOrt, loadPdfium, openPdfiumDocument, closePdfiumDocument,
  renderPdfiumPage, normalizePageSelection, createResult, integerInRange, numberInRange, enumValue } from './media-node-adapter.mjs'
import { applyDocumentScanFilter, DOCUMENT_SCAN_MODES } from './ported/documentScanFilters.mjs'
import { rectifyDocument, validDocumentCorners, fullDocumentCorners } from './ported/documentGeometry.mjs'
import { documentCornerTensor, documentCornersFromHeatmap } from './ported/documentCornerHeatmap.mjs'
import { analyzeWatermarkCandidates, removeSelectedWatermarks } from './ported/pdfWatermarkRemoval.mjs'

const operations = new Set(['word-to-pdf', 'pptx-to-pdf', 'pdf-to-scanned', 'pdf-analyze-watermarks',
  'pdf-remove-watermark', 'document-scan', 'document-scan-pdf', 'image-upscale', 'image-smart-cutout', 'cutout-motion'])
export const isExtendedOperation = name => operations.has(name)

export const runExtendedOperation = async ({ operation, inputs, options, plan, transactions }) => {
  // Reserve/check destinations before downloading models or starting expensive work.
  const outputPath = options.output ? await transactions.resolveOutputPath(options.output) : null
  const outputDir = options.outputDir ? await transactions.resolveOutputDirectory(options.outputDir) : null
  let results, backend
  if (operation === 'word-to-pdf' || operation === 'pptx-to-pdf') {
    const expected = operation === 'word-to-pdf' ? '.docx' : '.pptx'
    if (path.extname(inputs[0].path).toLowerCase() !== expected) throw new CliError('INVALID_ARGUMENT', `This operation accepts ${expected} files only.`)
    const result = await convertOffice(inputs[0].data, operation === 'word-to-pdf' ? 'wordcraft' : 'deckcraft')
    results = [{ ...result, path: outputPath, type: 'application/pdf' }]
    backend = 'office.wasm'
  } else if (operation.startsWith('pdf-') && operation.includes('watermark')) {
    const doc = await loadPdf(inputs[0].data)
    const mode = enumValue(plan.mode, ['structured', 'advanced'], 'structured', 'mode')
    const candidates = analyzeWatermarkCandidates(doc, plan)
    if (operation === 'pdf-analyze-watermarks') return { ok: true, operation, backend: 'pdf-lib', candidates, outputs: [] }
    if (mode === 'advanced' && (!Array.isArray(plan.candidateIds) || !plan.candidateIds.length || plan.candidateIds.some(id => !candidates.some(c => c.id === id)))) {
      throw new CliError('INVALID_PLAN', 'Advanced removal requires candidateIds from pdf-analyze-watermarks for this input.')
    }
    const metadata = removeSelectedWatermarks(doc, { ...plan, mode })
    results = [{ data: await doc.save(), metadata, path: outputPath, type: 'application/pdf' }]
    backend = 'pdf-lib'
  } else if (operation === 'pdf-to-scanned') {
    results = [{ data: await rasterizePdf(inputs[0].data, plan), path: outputPath, type: 'application/pdf', metadata: { rasterized: true, searchableText: false } }]
    backend = 'pdfium.wasm+pdf-lib'
  } else if (operation.startsWith('document-scan')) {
    results = await scanDocuments(inputs, plan)
    if (operation === 'document-scan-pdf') {
      const doc = await PDFDocument.create()
      const dpi = integerInRange(plan.dpi, 72, 600, 144, 'dpi')
      for (const result of results) {
        const img = await doc.embedPng(result.data)
        const page = doc.addPage([img.width * 72 / dpi, img.height * 72 / dpi])
        page.drawImage(img, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() })
      }
      results = [{ data: await doc.save(), path: outputPath, type: 'application/pdf', metadata: { pages: results.map(x => x.metadata) } }]
    } else {
      for (let i = 0; i < results.length; i++) results[i].path = await transactions.resolveOutputPath(path.join(outputDir, `${String(i + 1).padStart(4, '0')}-${path.parse(inputs[i].path).name}-scan.png`))
    }
    backend = 'docaligner+imagemagick.wasm'
  } else {
    const { runAiImageOperation } = await import('./ai-image-operations.mjs')
    return runAiImageOperation({ operation, inputs, plan, outputPath, outputDir, transactions })
  }
  await transactions.commitOutputs(results)
  return createResult(operation, backend, results)
}

export const loadPdf = async data => {
  try { return await PDFDocument.load(data) } catch (error) {
    throw new CliError(/encrypt/i.test(error.message) ? 'PASSWORD_REQUIRED' : 'INPUT_NOT_PDF', 'The PDF could not be opened.')
  }
}

const convertOffice = (data, kind) => new Promise((resolve, reject) => {
  if (data.length > 100 * 1024 * 1024) return reject(new CliError('OFFICE_RESOURCE_LIMIT', 'Office inputs must be at most 100 MiB.'))
  const worker = new Worker(new URL('./office-worker.mjs', import.meta.url), { workerData: { data, kind }, stdout: true, stderr: true, execArgv: [] })
  worker.stdout.resume()
  worker.stderr.resume()
  const finish = (error, result) => {
    clearTimeout(timer)
    worker.removeAllListeners()
    worker.terminate().catch(() => {})
    if (error) reject(error); else resolve(result)
  }
  const timer = setTimeout(() => finish(new CliError('OFFICE_CONVERSION_TIMEOUT', 'Office conversion exceeded five minutes, including runtime downloads.')), 300000)
  worker.once('message', result => result.error ? finish(new CliError(result.error.code, result.error.message)) : finish(null, result))
  worker.once('error', () => finish(new CliError('OFFICE_CONVERSION_FAILED', 'The Office worker failed.')))
  worker.once('exit', () => finish(new CliError('OFFICE_CONVERSION_FAILED', 'The Office worker exited without a result.')))
})

export const decodeRgba = async data => {
  const magick = await loadMagick()
  let image
  try {
    image = magick.MagickImage.create(data)
    image.autoOrient()
    if (image.width * image.height > 16_000_000) throw new CliError('IMAGE_RESOURCE_LIMIT', 'Input exceeds 16 megapixels; resize it first.')
    const pixels = image.getPixels(p => p.toByteArray(0, 0, image.width, image.height, 'RGBA'))
    return { data: new Uint8ClampedArray(pixels), width: image.width, height: image.height }
  } catch (error) {
    if (error instanceof CliError) throw error
    throw new CliError('INPUT_NOT_IMAGE', 'The input is not a readable image.')
  } finally { image?.dispose() }
}
export const encodeRgba = async pixels => {
  const magick = await loadMagick()
  const image = magick.MagickImage.create(new Uint8Array(pixels.data), new magick.MagickReadSettings({ depth: 8, format: magick.MagickFormat.Rgba, width: pixels.width, height: pixels.height }))
  try { image.strip(); return image.write(magick.MagickFormat.Png, b => new Uint8Array(b)) } finally { image.dispose() }
}

const scanDocuments = async (inputs, plan) => {
  const mode = enumValue(plan.mode, DOCUMENT_SCAN_MODES, 'colourSharp', 'mode')
  const detector = enumValue(plan.detector, ['model', 'none'], 'model', 'detector')
  if (plan.pages !== undefined && (!Array.isArray(plan.pages) || plan.pages.length !== inputs.length)) throw new CliError('INVALID_PLAN', 'pages must contain one settings object per input.')
  let session, ort
  const results = []
  try {
    for (let i = 0; i < inputs.length; i++) {
      const pagePlan = plan.pages?.[i] || {}
      const pixels = await decodeRgba(inputs[i].data)
      let corners = pagePlan.corners ?? plan.corners
      let detection = { detector: 'manual' }
      if (!corners && detector === 'model') {
        ort ||= await loadOrt()
        session ||= await ort.InferenceSession.create(await readFile(await ensureRuntimeFile('docaligner-lcnet100.onnx')), { executionProviders: ['wasm'] })
        const tensor = new ort.Tensor('float32', documentCornerTensor(pixels), [1, 3, 256, 256])
        let outputs
        try {
          outputs = await session.run({ img: tensor })
          detection = { ...documentCornersFromHeatmap(outputs.heatmap, pixels.width, pixels.height), detector: 'lcnet100' }
          corners = detection.corners
        } finally { tensor.dispose(); if (outputs) Object.values(outputs).forEach(t => t.dispose()) }
      }
      if (!corners && detector === 'none') { corners = fullDocumentCorners(); detection = { detector: 'none' } }
      if (!validDocumentCorners(corners)) throw new CliError('INVALID_PLAN', 'Document corners must form a clockwise convex quadrilateral in normalized coordinates.')
      const corrected = rectifyDocument(pixels, corners)
      const pageMode = enumValue(pagePlan.mode, DOCUMENT_SCAN_MODES, mode, 'pages.mode')
      applyDocumentScanFilter(corrected, pageMode, { normalizeBackground: plan.normalizeBackground !== false })
      results.push({ data: await encodeRgba(corrected), type: 'image/png', metadata: { ...detection, corners, mode: pageMode, width: corrected.width, height: corrected.height } })
    }
  } finally { await session?.release() }
  return results
}

export const rasterizePdf = async (data, plan = {}) => {
  const dpi = integerInRange(plan.dpi, 72, 600, 144, 'dpi')
  const quality = numberInRange(plan.jpegQuality ?? plan.quality, 0.1, 1, 0.85, 'quality')
  const pdfium = await loadPdfium()
  const source = openPdfiumDocument(pdfium, data, '')
  try {
    const output = await PDFDocument.create()
    const pages = normalizePageSelection(plan.pages, pdfium.FPDF_GetPageCount(source.handle))
    const magick = await loadMagick()
    for (const pageNumber of pages) {
      const pageHandle = pdfium.FPDF_LoadPage(source.handle, pageNumber - 1)
      if (!pageHandle) throw new CliError('PROCESSING_FAILED', 'Could not load PDF page.')
      const width = pdfium.FPDF_GetPageWidthF(pageHandle), height = pdfium.FPDF_GetPageHeightF(pageHandle)
      pdfium.FPDF_ClosePage(pageHandle)
      const render = renderPdfiumPage(pdfium, source.handle, pageNumber - 1, dpi)
      let image
      try {
        image = magick.MagickImage.create(render.data, new magick.MagickReadSettings({ depth: 8, format: magick.MagickFormat.Bgra, width: render.width, height: render.height }))
        if (plan.grayscale) image.colorSpace = magick.ColorSpace.Gray
        image.quality = Math.round(quality * 100)
        image.strip()
        const jpeg = image.write(magick.MagickFormat.Jpeg, b => new Uint8Array(b))
        // Lossless page encoding protects small text/line art when it is also smaller.
        const png = image.write(magick.MagickFormat.Png, b => new Uint8Array(b))
        const embedded = png.length < jpeg.length ? await output.embedPng(png) : await output.embedJpg(jpeg)
        output.addPage([width, height]).drawImage(embedded, { x: 0, y: 0, width, height })
      } finally { image?.dispose(); render.dispose() }
    }
    return output.save()
  } finally { closePdfiumDocument(pdfium, source) }
}

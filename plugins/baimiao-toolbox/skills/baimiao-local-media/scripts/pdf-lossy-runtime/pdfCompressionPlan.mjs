import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFStream } from '../../assets/pdf-lib/pdf-lib.mjs'
import { collectPdfImageStreams, analyzePdfImageStream } from './pdfImageAnalysis.mjs'
import { analyzePdfImagePlacements } from './pdfImagePlacementAnalysis.mjs'
import { analyzePdfDocumentFromPdf } from './pdfDocumentAnalysis.mjs'
import { getPdfCompressionRisk } from './pdfCompressionSafety.mjs'

export const preparePdfCompression = async (file, options = {}) => {
  const pdf = await PDFDocument.load(file, { ignoreEncryption: false, updateMetadata: false })
  const images = collectPdfImageStreams(pdf).sort(
    (a, b) => b.stream.getContentsSize() - a.stream.getContentsSize(),
  )
  const analyses = new Map(
    images.map((image) => [
      image.stream,
      analyzePdfImageStream(image.stream, image.pageNumber, image.name),
    ]),
  )
  const fontRefs = new Set()
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) continue
    for (const key of ['FontFile', 'FontFile2', 'FontFile3']) {
      const value = object.get(PDFName.of(key))
      if (value) fontRefs.add(value.toString())
    }
  }
  const budget = { imageBytes: 0, candidateImageBytes: 0, fontBytes: 0, otherStreamBytes: 0 }
  for (const [ref, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream || object instanceof PDFStream)) continue
    const size = object.getContentsSize()
    if (object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) budget.imageBytes += size
    else if (fontRefs.has(ref.toString())) budget.fontBytes += size
    else budget.otherStreamBytes += size
  }
  for (const analysis of analyses.values()) {
    if (analysis.candidate && (!analysis.bitsPerComponent || analysis.bitsPerComponent >= 8)) {
      budget.candidateImageBytes += analysis.byteLength
    }
  }
  return {
    pdf,
    images,
    analyses,
    budget,
    placements: analyzePdfImagePlacements(pdf),
    documentAnalysis: analyzePdfDocumentFromPdf(pdf, options, images),
    compatibilityReason: getPdfCompressionRisk(pdf),
    contentKinds: new Map(),
    // Only encoded bytes and lightweight classifications survive a trial.
    encodingCache: new Map(),
    encodingCacheBytes: 0,
  }
}

export const resolveImageCompressionSettings = (analysis, placement, kind, options) => {
  const sourceEdge = Math.max(analysis.width, analysis.height)
  const documentImage = kind !== 'photo'
  const targetDpi = documentImage ? options.textDpi : options.targetDpi
  const quality = Math.max(options.jpegQuality, documentImage ? options.textQuality || 0.8 : 0)
  if (!placement || !(targetDpi > 0)) {
    // Unknown placements must not be downsampled based on an invented page size.
    return { maxImageDimension: sourceEdge, jpegQuality: quality, targetDpi: 0 }
  }
  const requiredWidth = (placement.widthPoints * targetDpi) / 72
  const requiredHeight = (placement.heightPoints * targetDpi) / 72
  let scale = Math.min(
    1,
    Math.max(requiredWidth / analysis.width, requiredHeight / analysis.height),
  )
  // Avoid a new lossy generation for a marginal resolution change.
  if (scale > 0.85) scale = 1
  return { maxImageDimension: Math.ceil(sourceEdge * scale), jpegQuality: quality, targetDpi }
}

// This is deliberately a conservative heuristic, not OCR. A failed or ambiguous
// classification receives the document policy. No decoded image is cached.
export const classifyJpegContent = async (
  image,
  analysis,
  maxDecodePixels,
  fullPageDocument = false,
) => {
  if (
    analysis.width * analysis.height > maxDecodePixels ||
    !['DeviceRGB', 'DeviceGray'].includes(analysis.colorSpace)
  )
    return 'document'
  let bitmap
  try {
    const { loadMagick, resizeImageExactly } = await import('../media-node-adapter.mjs')
    const magick = await loadMagick()
    bitmap = magick.MagickImage.create(image.stream.getContents())
    resizeImageExactly(magick, bitmap, 128, 128)
    const data = bitmap.getPixels(p => p.toByteArray(0, 0, 128, 128, 'RGBA'))
    let white = 0,
      dark = 0,
      colorful = 0,
      edges = 0,
      flat = 0
    for (let index = 0; index < data.length; index += 4) {
      const min = Math.min(data[index], data[index + 1], data[index + 2])
      const max = Math.max(data[index], data[index + 1], data[index + 2])
      if (min > 225) white++
      if (max < 100) dark++
      if (max - min > 35) colorful++
      if (index % 512 >= 4) {
        const distance =
          Math.abs(data[index] - data[index - 4]) +
          Math.abs(data[index + 1] - data[index - 3]) +
          Math.abs(data[index + 2] - data[index - 2])
        if (distance > 180) edges++
        if (distance < 12) flat++
      }
    }
    const pixels = 128 * 128
    if (fullPageDocument && white / pixels > 0.45 && dark / pixels > 0.005) return 'document'
    if (flat / pixels > 0.65 && edges / pixels > 0.015) return 'sharp'
    if (white / pixels > 0.45 && dark / pixels > 0.005) return 'document'
    return colorful / pixels > 0.15 && white / pixels < 0.4 ? 'photo' : 'document'
  } catch {
    return 'document'
  } finally {
    bitmap?.dispose()
  }
}

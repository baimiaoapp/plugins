import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
} from '../../assets/pdf-lib/pdf-lib.mjs'
import { collectPdfImageStreams } from './pdfImageAnalysis.mjs'

const SAMPLE_PAGE_LIMIT = 3
const NAME = {
  contents: PDFName.of('Contents'),
}

export const DOCUMENT_TYPES = {
  TEXT: 'text',
  SCANNED: 'scanned',
  MIXED: 'mixed',
  UNKNOWN: 'unknown',
}

export const COMPRESSION_STRATEGIES = {
  IMAGE_XOBJECT: 'image-xobject',
}

export const analyzePdfDocument = async (file, options = {}) => {
  const pdf = await PDFDocument.load(file, { ignoreEncryption: false, updateMetadata: false })
  return analyzePdfDocumentFromPdf(pdf, options)
}

export const analyzePdfDocumentFromPdf = (pdf, options = {}, imageStreams = null) => {
  const pageCount = pdf.getPageCount()
  const samplePageCount = Math.min(Number(options.samplePages) || SAMPLE_PAGE_LIMIT, pageCount)
  const pages = []
  const images = imageStreams || collectPdfImageStreams(pdf)
  const imagePages = new Set(images.map((image) => image.pageNumber))
  const sampledImageDpis = []
  let maxPageDimension = 0

  for (let index = 1; index <= samplePageCount; index++) {
    const page = pdf.getPage(index - 1)
    const { width: pageWidth, height: pageHeight } = page.getSize()
    maxPageDimension = Math.max(maxPageDimension, pageWidth, pageHeight)
    const contentText = readPageContentText(page, pdf.context)
    const textOperatorCount = countTextOperators(contentText)
    const textCharCount = countLiteralTextChars(contentText)
    const pageImages = images.filter((image) => image.pageNumber === index)
    const imageOpCount = pageImages.length
    const hasTextLayer = textOperatorCount >= 2 || textCharCount >= 20
    const mostlyImage = imagePages.has(index) && (!hasTextLayer || imageOpCount >= 1)

    for (const image of pageImages) {
      const imageWidth = numberValue(image.stream.dict.lookupMaybe(PDFName.of('Width'), PDFNumber))
      const imageHeight = numberValue(
        image.stream.dict.lookupMaybe(PDFName.of('Height'), PDFNumber),
      )
      if (!imageWidth || !imageHeight || !pageWidth || !pageHeight) continue
      sampledImageDpis.push(
        Math.min(imageWidth / (pageWidth / 72), imageHeight / (pageHeight / 72)),
      )
    }

    pages.push({
      pageNumber: index,
      textItemCount: textOperatorCount,
      textCharCount,
      imageOpCount,
      hasTextLayer,
      mostlyImage,
    })
  }

  const textPageCount = pages.filter((page) => page.hasTextLayer).length
  const imagePageCount = pages.filter((page) => page.mostlyImage).length
  const hasTextLayer = textPageCount > 0
  const mostlyImage = imagePageCount >= Math.ceil(samplePageCount / 2)
  const largeImagePageRatio = samplePageCount ? imagePageCount / samplePageCount : 0
  const documentType = getDocumentType({
    hasTextLayer,
    mostlyImage,
    textPageCount,
    imagePageCount,
    samplePageCount,
  })
  const estimatedImageDpi = sampledImageDpis.length
    ? Math.min(
        1200,
        Math.max(
          0,
          Math.round(sampledImageDpis.reduce((sum, dpi) => sum + dpi, 0) / sampledImageDpis.length),
        ),
      )
    : 0

  return {
    pageCount,
    sampledPages: samplePageCount,
    documentType,
    hasTextLayer,
    mostlyImage,
    largeImagePageRatio,
    textPageCount,
    imagePageCount,
    estimatedImageDpi,
    maxPageDimension,
    pages,
  }
}

export const selectCompressionStrategy = (analysis, options = {}) => {
  return explainCompressionStrategy(analysis, options).strategy
}

export const explainCompressionStrategy = (analysis, options = {}) => {
  const mode = options.mode || 'auto'

  if (mode === 'image-xobject') {
    return {
      strategy: COMPRESSION_STRATEGIES.IMAGE_XOBJECT,
      reason: '用户选择图片对象压缩，保留文字和矢量内容，仅重编码可替换图片并优化 PDF 结构。',
    }
  }

  return {
    strategy: COMPRESSION_STRATEGIES.IMAGE_XOBJECT,
    reason: '统一使用图片对象压缩，保留文字和矢量内容，仅重编码可替换图片并优化 PDF 结构。',
  }
}

const getDocumentType = ({
  hasTextLayer,
  mostlyImage,
  textPageCount,
  imagePageCount,
  samplePageCount,
}) => {
  if (hasTextLayer && !mostlyImage) return DOCUMENT_TYPES.TEXT
  if (!hasTextLayer && mostlyImage) return DOCUMENT_TYPES.SCANNED
  if (hasTextLayer && mostlyImage) return DOCUMENT_TYPES.MIXED
  if (textPageCount >= Math.ceil(samplePageCount / 2)) return DOCUMENT_TYPES.TEXT
  if (imagePageCount >= Math.ceil(samplePageCount / 2)) return DOCUMENT_TYPES.SCANNED
  return DOCUMENT_TYPES.UNKNOWN
}

const readPageContentText = (page, context) => {
  const contents = page.node.get(NAME.contents)
  if (!contents) return ''
  return readContentObject(contents, context)
}

const readContentObject = (object, context) => {
  const value = object instanceof PDFRef ? context.lookup(object) : object
  if (value instanceof PDFArray) {
    const chunks = []
    for (let index = 0; index < value.size(); index++)
      chunks.push(readContentObject(value.get(index), context))
    return chunks.join('\n')
  }
  if (value instanceof PDFRawStream || value instanceof PDFStream) {
    try {
      return bytesToLatin1(value.getContents())
    } catch {
      return ''
    }
  }
  if (value instanceof PDFDict) return ''
  return ''
}

const countTextOperators = (content) => {
  const matches = content.match(/\b(?:Tj|TJ|'|")\b/g)
  return matches?.length || 0
}

const countLiteralTextChars = (content) => {
  const matches = content.match(/\((?:\\.|[^\\)])*\)\s*(?:Tj|'|")/g)
  if (!matches) return 0
  return matches.reduce(
    (sum, match) => sum + match.replace(/\\./g, 'x').replace(/[()\sTj'"]/g, '').length,
    0,
  )
}

const bytesToLatin1 = (bytes) => {
  let result = ''
  const chunkSize = 8192
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return result
}

const numberValue = (value) => (value instanceof PDFNumber ? value.asNumber() : 0)

import {
  PDFDocument,
  StandardFonts,
  degrees,
  rgb,
} from '../assets/pdf-lib/pdf-lib.mjs'

const PAGE_SIZES = Object.freeze({
  a4: Object.freeze([595.28, 841.89]),
  letter: Object.freeze([612, 792]),
})

export class PdfLibError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'PdfLibError'
    this.code = code
    this.details = details
  }
}

export const createPdfLibNodeAdapter = () => new PdfLibNodeAdapter()

class PdfLibNodeAdapter {
  async getPageCount(file) {
    return (await loadPdf(file)).getPageCount()
  }

  async cleanupMetadata(file) {
    const document = await loadPdf(file)
    const fields = [
      ['title', document.getTitle()],
      ['author', document.getAuthor()],
      ['subject', document.getSubject()],
      ['keywords', document.getKeywords()],
      ['creator', document.getCreator()],
      ['producer', document.getProducer()],
    ]
    const detectedFields = fields
      .filter(([, value]) => hasValue(value))
      .map(([name]) => name)

    document.setTitle('')
    document.setAuthor('')
    document.setSubject('')
    document.setKeywords([])
    document.setCreator('')
    document.setProducer('')

    return [{
      name: 'metadata-cleanup.pdf',
      data: await document.save({ useObjectStreams: true }),
      metadataCleanup: { detectedFields, clearedFields: detectedFields },
    }]
  }

  async reorder(file, rawPlan) {
    const source = await loadPdf(file)
    const plan = normalizeReorderPlan(rawPlan, source.getPageCount())
    const output = await PDFDocument.create()
    const sourcePages = source.getPages()
    let lastPageSize = sourcePages[0].getSize()

    for (const operation of plan) {
      if (operation.type === 'blank') {
        const size = operation.size || lastPageSize
        output.addPage([size.width, size.height])
        continue
      }

      const [page] = await output.copyPages(source, [operation.page - 1])
      lastPageSize = sourcePages[operation.page - 1].getSize()
      if (operation.rotation) {
        const current = page.getRotation().angle || 0
        page.setRotation(degrees(normalizeRotation(current + operation.rotation)))
      }
      output.addPage(page)
    }

    return [{ name: 'reordered.pdf', data: await output.save({ useObjectStreams: true }) }]
  }

  async addPageNumbers(file, rawPlan = {}) {
    const document = await loadPdf(file)
    const plan = normalizePageNumberPlan(rawPlan, document.getPageCount())
    const font = await document.embedFont(getStandardFont(plan.style))
    const selected = expandRanges(plan.ranges)
    const selectedIndexes = new Set(selected.map((page) => page - 1))

    document.getPages().forEach((page, pageIndex) => {
      if (!selectedIndexes.has(pageIndex)) return
      const selectedIndex = selected.indexOf(pageIndex + 1)
      const number = plan.startNumber + selectedIndex
      const text = formatPageNumber(plan, number, selected.length)
      const position = getFacingPosition(plan.position, pageIndex, plan.facingPages, plan.coverPage)
      drawPageNumber(page, text, font, position, plan.style)
    })

    return [{ name: 'page-numbers.pdf', data: await document.save({ useObjectStreams: true }) }]
  }

  async imagesToPdf(images, rawPlan = {}) {
    const plan = normalizeImagePlan(rawPlan)
    const output = await PDFDocument.create()

    for (const image of images) {
      const embedded = image.type === 'image/png'
        ? await output.embedPng(image.data)
        : await output.embedJpg(image.data)
      const layout = getImageLayout(embedded, plan)
      const page = output.addPage([layout.pageWidth, layout.pageHeight])
      page.drawRectangle({
        x: 0,
        y: 0,
        width: layout.pageWidth,
        height: layout.pageHeight,
        color: rgb(1, 1, 1),
      })
      page.drawImage(embedded, layout.imageRect)
    }

    return [{ name: 'images.pdf', data: await output.save({ useObjectStreams: true }) }]
  }

  async addWatermark(file, rawPlan = {}) {
    const document = await loadPdf(file)
    const plan = normalizeWatermarkPlan(rawPlan, document.getPageCount())
    let renderer
    if (plan.mode === 'image') {
      renderer = plan.image.type === 'image/png'
        ? await document.embedPng(plan.image.data)
        : await document.embedJpg(plan.image.data)
    } else {
      if (!/^[\x20-\x7e]+$/.test(plan.text)) {
        throw new PdfLibError(
          'UNSUPPORTED_WATERMARK_TEXT',
          'Local text watermarks currently support printable Latin text; use an image watermark for other scripts.',
        )
      }
      renderer = await document.embedFont(getStandardFont(plan))
    }
    const selected = new Set(expandRanges(plan.ranges).map((page) => page - 1))
    document.getPages().forEach((page, pageIndex) => {
      if (selected.has(pageIndex)) drawWatermark(page, renderer, plan)
    })
    return [{ name: 'watermark.pdf', data: await document.save({ useObjectStreams: true }) }]
  }
}

const loadPdf = async (file) => {
  try {
    return await PDFDocument.load(file, { ignoreEncryption: false, updateMetadata: false })
  } catch (error) {
    const encrypted = /encrypt|password/i.test(String(error?.message || ''))
    throw new PdfLibError(
      encrypted ? 'ENCRYPTED_PDF' : 'PROCESSING_FAILED',
      encrypted
        ? 'The PDF is encrypted and requires the password workflow.'
        : 'pdf-lib could not process the PDF.',
    )
  }
}

const hasValue = (value) => Array.isArray(value)
  ? value.some(hasValue)
  : String(value || '').trim().length > 0

const normalizeReorderPlan = (rawPlan, pageCount) => {
  const items = Array.isArray(rawPlan?.pages) ? rawPlan.pages : rawPlan
  if (!Array.isArray(items) || !items.length) {
    throw new PdfLibError('INVALID_PAGE_ORDER', 'The reorder plan must contain a non-empty pages array.')
  }

  return items.map((item) => {
    if (item?.type === 'blank') {
      if (item.width === undefined && item.height === undefined) return { type: 'blank' }
      const width = Number(item.width)
      const height = Number(item.height)
      if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
        throw new PdfLibError('INVALID_PAGE_ORDER', 'Blank page width and height must be positive.')
      }
      return { type: 'blank', size: { width, height } }
    }

    const page = Number(typeof item === 'number' ? item : item?.page)
    const rotation = normalizeRotation(Number(typeof item === 'number' ? 0 : item?.rotation || 0))
    if (!Number.isInteger(page) || page < 1 || page > pageCount) {
      throw new PdfLibError('INVALID_PAGE_ORDER', 'A page number exceeds the document page count.', {
        pageCount,
      })
    }
    if (![0, 90, 180, 270].includes(rotation)) {
      throw new PdfLibError('INVALID_PAGE_ORDER', 'Page rotations must be multiples of 90 degrees.')
    }
    return { type: 'page', page, rotation }
  })
}

const normalizePageNumberPlan = (rawPlan, pageCount) => {
  const ranges = rawPlan.ranges || [{ start: 1, end: pageCount }]
  if (!Array.isArray(ranges) || !ranges.length) {
    throw new PdfLibError('INVALID_PAGE_RANGE', 'The page number plan must select at least one page.')
  }
  for (const range of ranges) {
    if (!Number.isInteger(range.start) || !Number.isInteger(range.end)
      || range.start < 1 || range.end < range.start || range.end > pageCount) {
      throw new PdfLibError('INVALID_PAGE_RANGE', 'A page range is invalid.', { pageCount })
    }
  }

  const startNumber = Number(rawPlan.startNumber ?? 1)
  if (!Number.isInteger(startNumber) || startNumber < 1 || startNumber > 999999) {
    throw new PdfLibError('INVALID_ARGUMENT', 'startNumber must be an integer from 1 to 999999.')
  }
  const position = [
    'top-left', 'top-center', 'top-right',
    'bottom-left', 'bottom-center', 'bottom-right',
  ].includes(rawPlan.position) ? rawPlan.position : 'bottom-center'
  const format = ['number', 'page-number', 'page-of-total', 'custom'].includes(rawPlan.format)
    ? rawPlan.format
    : 'number'

  return {
    ranges,
    startNumber,
    position,
    format,
    customFormat: String(rawPlan.customFormat || '{page}').slice(0, 80),
    facingPages: Boolean(rawPlan.facingPages),
    coverPage: Boolean(rawPlan.coverPage),
    style: normalizePageNumberStyle(rawPlan.style),
  }
}

const normalizePageNumberStyle = (rawStyle = {}) => ({
  fontSize: clampNumber(rawStyle.fontSize, 11, 6, 72),
  margin: clampNumber(rawStyle.margin, 28, 0, 144),
  color: parseColor(rawStyle.color),
  bold: Boolean(rawStyle.bold),
  italic: Boolean(rawStyle.italic),
  underline: Boolean(rawStyle.underline),
})

const normalizeImagePlan = (rawPlan) => {
  const pageSize = ['fit-image', 'a4', 'letter'].includes(rawPlan.pageSize)
    ? rawPlan.pageSize
    : 'fit-image'
  const orientation = ['auto', 'portrait', 'landscape'].includes(rawPlan.orientation)
    ? rawPlan.orientation
    : 'auto'
  return { pageSize, orientation, margin: clampNumber(rawPlan.margin, 0, 0, 144) }
}

const normalizeWatermarkPlan = (rawPlan, pageCount) => {
  if (rawPlan.layer === 'under-content') {
    throw new PdfLibError(
      'UNSUPPORTED_WATERMARK_LAYER',
      'Under-content watermarks require the browser tool.',
    )
  }
  const base = normalizePageNumberPlan({ ranges: rawPlan.ranges }, pageCount)
  const mode = rawPlan.mode === 'image' ? 'image' : 'text'
  const pattern = rawPlan.pattern === 'mosaic' ? 'mosaic' : 'single'
  const positions = new Set([
    'center', 'center-left', 'center-right',
    'top-left', 'top-center', 'top-right',
    'bottom-left', 'bottom-center', 'bottom-right',
  ])
  const plan = {
    mode,
    ranges: base.ranges,
    opacity: clampContinuous(rawPlan.opacity, 0.1, 0, 1),
    angle: clampContinuous(rawPlan.angle, 45, 0, 360),
    pattern,
    position: positions.has(rawPlan.position) ? rawPlan.position : 'center',
    fontSize: clampNumber(rawPlan.fontSize, 48, 12, 288),
    color: parseColor(rawPlan.color || '#808080'),
    bold: Boolean(rawPlan.bold),
    italic: Boolean(rawPlan.italic),
    underline: Boolean(rawPlan.underline),
  }
  if (mode === 'image') {
    if (!rawPlan.image?.data || !['image/png', 'image/jpeg'].includes(rawPlan.image.type)) {
      throw new PdfLibError('INVALID_PLAN', 'Image watermark data is missing or unsupported.')
    }
    return {
      ...plan,
      image: rawPlan.image,
      imageScale: clampContinuous(rawPlan.imageScale, 0.35, 0.05, 1),
      underline: false,
    }
  }
  const text = String(rawPlan.text || '').trim().slice(0, 80)
  if (!text) throw new PdfLibError('INVALID_PLAN', 'Text watermark plans require text.')
  return { ...plan, text }
}

const expandRanges = (ranges) => {
  const pages = []
  const seen = new Set()
  for (const { start, end } of ranges) {
    for (let page = start; page <= end; page += 1) {
      if (!seen.has(page)) pages.push(page)
      seen.add(page)
    }
  }
  return pages.sort((a, b) => a - b)
}

const formatPageNumber = (plan, number, total) => {
  if (plan.format === 'page-number') return `Page ${number}`
  if (plan.format === 'page-of-total') return `Page ${number} of ${total}`
  if (plan.format === 'custom') {
    return plan.customFormat.replaceAll('{page}', String(number)).replaceAll('{total}', String(total))
  }
  return String(number)
}

const drawPageNumber = (page, text, font, position, style) => {
  const { width, height } = page.getSize()
  const textWidth = font.widthOfTextAtSize(text, style.fontSize)
  const textHeight = font.heightAtSize(style.fontSize)
  const horizontal = position.split('-')[1]
  const x = horizontal === 'left'
    ? style.margin
    : horizontal === 'right'
      ? width - style.margin - textWidth
      : (width - textWidth) / 2
  const y = position.startsWith('top')
    ? height - style.margin - textHeight
    : style.margin
  page.drawText(text, { x, y, size: style.fontSize, font, color: style.color })
  if (style.underline) {
    page.drawLine({
      start: { x, y: y - 1.5 },
      end: { x: x + textWidth, y: y - 1.5 },
      thickness: Math.max(0.5, style.fontSize / 18),
      color: style.color,
    })
  }
}

const getFacingPosition = (position, pageIndex, facingPages, coverPage) => {
  if (!facingPages || position.endsWith('center')) return position
  const spreadIndex = coverPage ? pageIndex - 1 : pageIndex
  if (coverPage && pageIndex === 0) return position
  const side = spreadIndex % 2 === 0 ? 'left' : 'right'
  return position.replace(/-(left|right)$/, `-${side}`)
}

const getStandardFont = ({ bold, italic }) => {
  if (bold && italic) return StandardFonts.HelveticaBoldOblique
  if (bold) return StandardFonts.HelveticaBold
  if (italic) return StandardFonts.HelveticaOblique
  return StandardFonts.Helvetica
}

const getImageLayout = (image, options) => {
  let pageSize = options.pageSize === 'fit-image'
    ? [image.width + options.margin * 2, image.height + options.margin * 2]
    : PAGE_SIZES[options.pageSize]
  pageSize = orientPageSize(pageSize, options.orientation)
  const [pageWidth, pageHeight] = pageSize
  const margin = Math.min(options.margin, pageWidth / 2 - 1, pageHeight / 2 - 1)
  const availableWidth = Math.max(1, pageWidth - margin * 2)
  const availableHeight = Math.max(1, pageHeight - margin * 2)
  const scale = Math.min(availableWidth / image.width, availableHeight / image.height)
  const width = image.width * scale
  const height = image.height * scale
  return {
    pageWidth,
    pageHeight,
    imageRect: { x: (pageWidth - width) / 2, y: (pageHeight - height) / 2, width, height },
  }
}

const drawWatermark = (page, renderer, plan) => {
  const { width: pageWidth, height: pageHeight } = page.getSize()
  const naturalWidth = plan.mode === 'image'
    ? renderer.width * Math.min(1, (pageWidth * plan.imageScale) / renderer.width)
    : renderer.widthOfTextAtSize(plan.text, plan.fontSize)
  const naturalHeight = plan.mode === 'image'
    ? renderer.height * (naturalWidth / renderer.width)
    : plan.fontSize
  const drawAt = (centerX, centerY) => {
    const radians = (plan.angle * Math.PI) / 180
    const x = centerX - (naturalWidth / 2) * Math.cos(radians)
      + (naturalHeight / 2) * Math.sin(radians)
    const y = centerY - (naturalWidth / 2) * Math.sin(radians)
      - (naturalHeight / 2) * Math.cos(radians)
    if (plan.mode === 'image') {
      page.drawImage(renderer, {
        x, y, width: naturalWidth, height: naturalHeight,
        rotate: degrees(plan.angle), opacity: plan.opacity,
      })
    } else {
      page.drawText(plan.text, {
        x, y, size: plan.fontSize, font: renderer,
        color: plan.color, rotate: degrees(plan.angle), opacity: plan.opacity,
      })
      if (plan.underline) {
        const underlineOffset = 2
        const start = {
          x: x + underlineOffset * Math.sin(radians),
          y: y - underlineOffset * Math.cos(radians),
        }
        page.drawLine({
          start,
          end: {
            x: start.x + naturalWidth * Math.cos(radians),
            y: start.y + naturalWidth * Math.sin(radians),
          },
          thickness: Math.max(0.5, plan.fontSize / 18),
          color: plan.color,
          opacity: plan.opacity,
        })
      }
    }
  }

  if (plan.pattern === 'mosaic') {
    const stepX = Math.max(naturalWidth * 1.7, 180)
    const stepY = Math.max(naturalHeight * 3, 100)
    let row = 0
    for (let y = 0; y <= pageHeight + stepY; y += stepY) {
      const offset = row % 2 ? stepX / 2 : 0
      for (let x = -stepX; x <= pageWidth + stepX; x += stepX) drawAt(x + offset, y)
      row += 1
    }
    return
  }

  const [vertical, horizontal] = plan.position === 'center'
    ? ['center', 'center']
    : plan.position.split('-')
  const margin = 28
  const centerX = horizontal === 'left'
    ? margin + naturalWidth / 2
    : horizontal === 'right'
      ? pageWidth - margin - naturalWidth / 2
      : pageWidth / 2
  const centerY = vertical === 'top'
    ? pageHeight - margin - naturalHeight / 2
    : vertical === 'bottom'
      ? margin + naturalHeight / 2
      : pageHeight / 2
  drawAt(centerX, centerY)
}

const orientPageSize = ([width, height], orientation) => {
  if (orientation === 'portrait' && width > height) return [height, width]
  if (orientation === 'landscape' && width < height) return [height, width]
  return [width, height]
}

const parseColor = (value) => {
  const match = String(value || '#404040').match(/^#?([0-9a-f]{6})$/i)
  const hex = match ? match[1] : '404040'
  return rgb(
    Number.parseInt(hex.slice(0, 2), 16) / 255,
    Number.parseInt(hex.slice(2, 4), 16) / 255,
    Number.parseInt(hex.slice(4, 6), 16) / 255,
  )
}

const clampNumber = (value, fallback, min, max) => {
  const number = Number(value ?? fallback)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback
}

const clampContinuous = (value, fallback, min, max) => {
  const number = Number(value ?? fallback)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback
}

const normalizeRotation = (angle) => ((angle % 360) + 360) % 360

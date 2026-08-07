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

const IMAGE_SUBTYPE = PDFName.of('Image')
const FORM_SUBTYPE = PDFName.of('Form')

const NAME = {
  alternate: PDFName.of('Alternate'),
  bitsPerComponent: PDFName.of('BitsPerComponent'),
  colorSpace: PDFName.of('ColorSpace'),
  decode: PDFName.of('Decode'),
  decodeParms: PDFName.of('DecodeParms'),
  filter: PDFName.of('Filter'),
  height: PDFName.of('Height'),
  mask: PDFName.of('Mask'),
  n: PDFName.of('N'),
  range: PDFName.of('Range'),
  resources: PDFName.of('Resources'),
  sMask: PDFName.of('SMask'),
  subtype: PDFName.of('Subtype'),
  width: PDFName.of('Width'),
  xObject: PDFName.of('XObject'),
}

export const PDF_IMAGE_ANALYSIS_NAMES = NAME

const SKIP_REASONS = {
  COMPLEX_COLOR_SPACE: 'COMPLEX_COLOR_SPACE',
  HAS_ALPHA_OR_MASK: 'HAS_ALPHA_OR_MASK',
  NEEDS_CODEC_DECODER: 'NEEDS_CODEC_DECODER',
  UNSUPPORTED_BITS: 'UNSUPPORTED_BITS',
  UNSUPPORTED_FILTER: 'UNSUPPORTED_FILTER',
  UNKNOWN_DIMENSIONS: 'UNKNOWN_DIMENSIONS',
}

/**
 * Analyze Image XObjects that could become candidates for lossy compression.
 * This spike intentionally does not decode, rewrite, or log user PDF content.
 *
 * @param {ArrayBuffer | Uint8Array} file
 */
export const analyzePdfImageCompressionCandidates = async (file) => {
  const pdf = await PDFDocument.load(file, { ignoreEncryption: false, updateMetadata: false })
  return analyzePdfImageCompressionCandidatesFromPdf(pdf)
}

export const analyzePdfImageCompressionCandidatesFromPdf = (pdf) => {
  return analyzePdfImageCompressionCandidatesFromImages(collectPdfImageStreams(pdf))
}

export const analyzePdfImageCompressionCandidatesFromImages = (imageStreams) => {
  const images = imageStreams.map(({ stream, pageNumber, name }) =>
    analyzePdfImageStream(stream, pageNumber, name),
  )

  return summarizeImages(images)
}

/**
 * Internal spike helper that proves Image XObject stream replacement is viable.
 * The caller must provide a complete replacement image stream matching the dict.
 *
 * @param {ArrayBuffer | Uint8Array} file
 * @param {ArrayBuffer | Uint8Array} replacementBytes
 */
export const replaceFirstPdfImageStreamForSpike = async (file, replacementBytes) => {
  const pdf = await PDFDocument.load(file, { ignoreEncryption: false, updateMetadata: false })
  const image = collectPdfImageStreams(pdf).find(({ ref, stream }) => {
    const analysis = analyzePdfImageStream(stream, 1, null)
    return ref && analysis.candidate
  })

  if (!image?.ref) {
    throw Object.assign(new Error('No replaceable image stream found.'), {
      code: 'UNSUPPORTED_PDF',
    })
  }

  const nextDict = image.stream.dict.clone(pdf.context)
  const nextStream = PDFRawStream.of(nextDict, new Uint8Array(replacementBytes))
  pdf.context.assign(image.ref, nextStream)
  const data = await pdf.save({ useObjectStreams: true, updateFieldAppearances: false })
  return {
    data,
    replaced: 1,
    originalImageBytes: image.stream.getContentsSize(),
    replacementImageBytes: replacementBytes.byteLength,
  }
}

export const collectPdfImageStreams = (pdf) => {
  const images = []
  const visitedRefs = new Set()
  for (const [pageIndex, page] of pdf.getPages().entries()) {
    scanResources(
      page.node.Resources(),
      pdf.context,
      pageIndex + 1,
      images,
      visitedRefs,
    )
  }
  return images
}

const scanResources = (resources, context, pageNumber, images, visitedRefs) => {
  if (!(resources instanceof PDFDict)) return
  const xObjects = resources.lookupMaybe(NAME.xObject, PDFDict)
  if (!(xObjects instanceof PDFDict)) return

  for (const [name, value] of xObjects.entries()) {
    const refKey = value instanceof PDFRef ? value.toString() : ''
    if (refKey && visitedRefs.has(refKey)) continue
    if (refKey) visitedRefs.add(refKey)

    const object = context.lookup(value)
    if (!isPdfStream(object)) continue

    const subtype = object.dict.lookupMaybe(NAME.subtype, PDFName)
    if (subtype === IMAGE_SUBTYPE) {
      images.push({
        ref: value instanceof PDFRef ? value : context.getObjectRef(object),
        stream: object,
        pageNumber,
        name,
      })
      continue
    }

    if (subtype === FORM_SUBTYPE) {
      scanResources(
        object.dict.lookupMaybe(NAME.resources, PDFDict),
        context,
        pageNumber,
        images,
        visitedRefs,
      )
    }
  }
}

export const analyzePdfImageStream = (stream, pageNumber, name) => {
  const width = numberValue(stream.dict.lookupMaybe(NAME.width, PDFNumber))
  const height = numberValue(stream.dict.lookupMaybe(NAME.height, PDFNumber))
  const bitsPerComponent = numberValue(stream.dict.lookupMaybe(NAME.bitsPerComponent, PDFNumber))
  const filters = getNameList(stream.dict.lookup(NAME.filter))
  const colorSpaceInfo = getColorSpaceInfo(stream.dict.lookup(NAME.colorSpace))
  const decode = getNumberList(stream.dict.lookup(NAME.decode))
  const byteLength =
    typeof stream.getContentsSize === 'function'
      ? stream.getContentsSize()
      : stream.getContents?.()?.byteLength || 0
  const skipReason = getSkipReason({
    width,
    height,
    bitsPerComponent,
    filters,
    colorSpaceInfo,
    stream,
  })

  return {
    pageNumber,
    resourceName: name?.decodeText?.() || name?.toString?.() || '',
    width,
    height,
    bitsPerComponent,
    filters,
    colorSpace: colorSpaceInfo.name,
    colorSpaceComponents: colorSpaceInfo.components,
    alternateColorSpace: colorSpaceInfo.alternateName,
    labRange: colorSpaceInfo.labRange || [],
    baseColorSpaceComponents: colorSpaceInfo.baseComponents || 0,
    indexedHighValue: colorSpaceInfo.indexedHighValue ?? -1,
    decode,
    byteLength,
    candidate: !skipReason,
    skipReason,
  }
}

const getSkipReason = ({ width, height, bitsPerComponent, filters, colorSpaceInfo, stream }) => {
  if (!width || !height) return SKIP_REASONS.UNKNOWN_DIMENSIONS
  if (filters.length === 1 && ['JBIG2Decode', 'CCITTFaxDecode'].includes(filters[0])) {
    return SKIP_REASONS.NEEDS_CODEC_DECODER
  }
  if (filters.length === 1 && filters[0] === 'JPXDecode') {
    if (colorSpaceInfo.name && !colorSpaceInfo.supported) return SKIP_REASONS.COMPLEX_COLOR_SPACE
    return stream.dict.has(NAME.sMask) || stream.dict.has(NAME.mask)
      ? SKIP_REASONS.HAS_ALPHA_OR_MASK
      : ''
  }
  if (!colorSpaceInfo.supported) return SKIP_REASONS.COMPLEX_COLOR_SPACE
  if (colorSpaceInfo.name === 'Indexed') {
    if (![1, 2, 4, 8].includes(bitsPerComponent)) return SKIP_REASONS.UNSUPPORTED_BITS
  } else if (![1, 2, 4, 8].includes(bitsPerComponent)) {
    return SKIP_REASONS.UNSUPPORTED_BITS
  }
  if (!filters.length) return SKIP_REASONS.UNSUPPORTED_FILTER
  if (filters.every((filter) => ['DCTDecode', 'FlateDecode'].includes(filter))) {
    return stream.dict.has(NAME.sMask) || stream.dict.has(NAME.mask)
      ? SKIP_REASONS.HAS_ALPHA_OR_MASK
      : ''
  }
  if (!filters.every((filter) => ['DCTDecode', 'FlateDecode'].includes(filter))) {
    return SKIP_REASONS.UNSUPPORTED_FILTER
  }
  return ''
}

const summarizeImages = (images) => {
  const skippedByReason = images.reduce((summary, image) => {
    if (image.skipReason) summary[image.skipReason] = (summary[image.skipReason] || 0) + 1
    return summary
  }, {})
  const filtersByName = images.reduce((summary, image) => {
    const filters = image.filters?.length ? image.filters : ['NO_FILTER']
    for (const filter of filters) summary[filter] = (summary[filter] || 0) + 1
    return summary
  }, {})
  const colorSpacesByName = images.reduce((summary, image) => {
    const colorSpace = image.colorSpace || 'UNKNOWN_COLOR_SPACE'
    summary[colorSpace] = (summary[colorSpace] || 0) + 1
    return summary
  }, {})

  return {
    imageCount: images.length,
    candidateCount: images.filter((image) => image.candidate).length,
    skippedCount: images.filter((image) => !image.candidate).length,
    skippedByReason,
    filtersByName,
    colorSpacesByName,
    images,
  }
}

const isPdfStream = (object) => object instanceof PDFRawStream || object instanceof PDFStream

const numberValue = (value) => (value instanceof PDFNumber ? value.asNumber() : 0)

const getNameList = (value) => {
  if (value instanceof PDFName) return [value.decodeText()]
  if (value instanceof PDFArray) {
    const names = []
    for (let i = 0; i < value.size(); i++) {
      const item = value.lookupMaybe(i, PDFName)
      if (item) names.push(item.decodeText())
    }
    return names
  }
  return []
}

const getNumberList = (value) => {
  if (!(value instanceof PDFArray)) return []
  const numbers = []
  for (let i = 0; i < value.size(); i++) {
    const item = value.lookupMaybe(i, PDFNumber)
    if (item) numbers.push(item.asNumber())
  }
  return numbers
}

export const getPdfImageColorSpaceInfo = (value) => getColorSpaceInfo(value)

const getColorSpaceInfo = (value) => {
  if (value instanceof PDFName) return colorSpaceInfoForName(value.decodeText())
  if (!(value instanceof PDFArray))
    return { name: '', components: 0, alternateName: '', supported: false }

  const family = value.lookupMaybe(0, PDFName)?.decodeText?.() || ''
  if (family === 'ICCBased') {
    const profile = value.lookup(1)
    const profileDict =
      profile instanceof PDFRawStream || profile instanceof PDFStream ? profile.dict : null
    const alternate = profileDict?.lookupMaybe(NAME.alternate, PDFName)?.decodeText?.() || ''
    const alternateInfo = colorSpaceInfoForName(alternate)
    const components =
      numberValue(profileDict?.lookupMaybe(NAME.n, PDFNumber)) || alternateInfo.components
    return {
      name: 'ICCBased',
      components,
      alternateName: alternate,
      supported: alternateInfo.supported && components === alternateInfo.components,
    }
  }

  if (family === 'Indexed') {
    const baseInfo = getColorSpaceInfo(value.lookup(1))
    const indexedHighValue = numberValue(value.lookupMaybe(2, PDFNumber))
    return {
      name: 'Indexed',
      components: 1,
      alternateName: baseInfo.name,
      baseComponents: baseInfo.components,
      indexedHighValue,
      supported: baseInfo.supported && indexedHighValue >= 0 && indexedHighValue <= 255,
    }
  }

  if (family === 'CalGray')
    return { name: 'CalGray', components: 1, alternateName: '', supported: true }
  if (family === 'CalRGB')
    return { name: 'CalRGB', components: 3, alternateName: '', supported: true }
  if (family === 'Lab') {
    const params = value.lookupMaybe(1, PDFDict)
    const labRange = getNumberList(params?.lookup?.(NAME.range))
    return { name: 'Lab', components: 3, alternateName: '', labRange, supported: true }
  }

  return { name: family, components: 0, alternateName: '', supported: false }
}

const colorSpaceInfoForName = (name) => {
  if (name === 'DeviceGray') return { name, components: 1, alternateName: '', supported: true }
  if (name === 'DeviceRGB') return { name, components: 3, alternateName: '', supported: true }
  if (name === 'DeviceCMYK') return { name, components: 4, alternateName: '', supported: true }
  return { name, components: 0, alternateName: '', supported: false }
}

export const PDF_IMAGE_ANALYSIS_SKIP_REASONS = SKIP_REASONS

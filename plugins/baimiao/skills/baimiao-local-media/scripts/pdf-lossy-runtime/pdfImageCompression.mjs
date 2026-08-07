import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFStream,
  PDFString,
  decodePDFRawStream,
} from '../../assets/pdf-lib/pdf-lib.mjs'
import {
  analyzePdfImageCompressionCandidatesFromImages,
  analyzePdfImageStream,
  collectPdfImageStreams,
  PDF_IMAGE_ANALYSIS_NAMES,
} from './pdfImageAnalysis.mjs'
import { analyzePdfDocumentFromPdf, COMPRESSION_STRATEGIES } from './pdfDocumentAnalysis.mjs'
import { LOSSY_COMPRESS_POLICY, getLossyCompressPreset } from './lossyCompressionPolicy.mjs'

const PDF_NAME_DEVICE_RGB = PDFName.of('DeviceRGB')
const PDF_NAME_DEVICE_GRAY = PDFName.of('DeviceGray')
const PDF_NAME_DEVICE_CMYK = PDFName.of('DeviceCMYK')
const PDF_NAME_DCT_DECODE = PDFName.of('DCTDecode')
const PDF_NAME_COLUMNS = PDFName.of('Columns')
const PDF_NAME_COLORS = PDFName.of('Colors')
const PDF_NAME_PREDICTOR = PDFName.of('Predictor')
const PDF_NAME_DECODE = PDFName.of('Decode')
const DEFAULT_MAX_DECODE_PIXELS = 24_000_000
const DEFAULT_LOSSY_PRESET = getLossyCompressPreset()
const DEFAULT_MIN_SAVINGS_BYTES = LOSSY_COMPRESS_POLICY.minSavingsBytes

/**
 * Compress safe Image XObject candidates with an injected JPEG codec.
 * This is intentionally codec-agnostic so the PDF rewrite path can be tested
 * before choosing mozjpeg/libjpeg-turbo or another WASM encoder.
 *
 * @param {ArrayBuffer | Uint8Array} file
 * @param {{ reencodeJpeg(input: { data: Uint8Array, width: number, height: number, quality: number, maxImageDimension: number }): Promise<{ data: Uint8Array, width?: number, height?: number }> }} codec
 * @param {{ maxImageDimension?: number, jpegQuality?: number, keepTransparencyPng?: boolean, maxDecodePixels?: number, minSavingsBytes?: number }} options
 */
export const compressPdfImagesWithCodec = async (file, codec, options = {}) => {
  const pdf = await PDFDocument.load(file, { ignoreEncryption: false, updateMetadata: false })
  return compressPdfImagesInDocumentWithCodec(pdf, file, codec, options)
}

export const runPdfImageCompressionPipeline = async (
  file,
  options = {},
  { createCodecAdapter, optimizeOutput, onProgress = () => {}, now = () => performance.now() } = {},
) => {
  const startedAt = now()
  onProgress(0.14, '正在分析 PDF 类型')
  const pdf = await PDFDocument.load(file, { ignoreEncryption: false, updateMetadata: false })
  const imageStreams = collectPdfImageStreams(pdf)
  const documentAnalysis = analyzePdfDocumentFromPdf(pdf, options, imageStreams)
  onProgress(0.18, '正在分析 PDF 图片对象')

  const analysis = analyzePdfImageCompressionCandidatesFromImages(imageStreams, options)
  onProgress(0.32, analysis.candidateCount ? '已找到可压缩图片' : '未找到当前安全子集可压缩图片')

  if (!analysis.candidateCount && !hasFlattenableAlphaImages(analysis, options, imageStreams)) {
    return finishImageCompressionResult(file, options, documentAnalysis, startedAt, now, {
      result: createNoRewriteResult(file, analysis),
      optimizeOutput,
      onProgress,
      encodeBackend: '',
      jpxCodecAvailable: false,
      imageRewriteDurationMs: 0,
    })
  }

  const codec = await createCodecAdapter?.()
  if (!codec?.available) {
    throw Object.assign(new Error('Lossy compression requires browser image encoding.'), {
      code: 'RASTER_BACKEND_UNAVAILABLE',
    })
  }

  onProgress(0.45, `正在使用 ${formatImageCodecBackend(codec)} 重编码 PDF 图片`)
  let result = null
  let imageCompressionError = null
  const rewriteStartedAt = now()
  try {
    result = await compressPdfImagesInDocumentWithCodec(pdf, file, codec, {
      ...options,
      onProgress: ({ current, total }) => {
        const imageProgress = total ? current / total : 0
        onProgress(0.45 + imageProgress * 0.4, `正在重编码图片 ${current}/${total}`)
      },
    })
  } catch (error) {
    if (error?.code !== 'COMPRESS_NOT_EFFECTIVE') throw error
    imageCompressionError = error
    result = createNoRewriteResult(file, analysis, error.details)
  }

  return finishImageCompressionResult(file, options, documentAnalysis, startedAt, now, {
    result,
    imageCompressionError,
    optimizeOutput,
    onProgress,
    encodeBackend: codec.backend || 'image-codec',
    jpxCodecAvailable: !!codec.capabilities?.jpxDecode,
    imageRewriteDurationMs: Math.round(now() - rewriteStartedAt),
  })
}

export const compressPdfImagesInDocumentWithCodec = async (pdf, file, codec, options = {}) => {
  if (typeof codec?.reencodeJpeg !== 'function') {
    throw Object.assign(new Error('Image codec is unavailable.'), { code: 'UNSUPPORTED_PDF' })
  }

  const progress = typeof options.onProgress === 'function' ? options.onProgress : () => {}
  const originalSize = file.byteLength
  const maxImageDimension = Number(options.maxImageDimension) || DEFAULT_LOSSY_PRESET.maxImageDimension
  const maxDecodePixels = Number(options.maxDecodePixels) || DEFAULT_MAX_DECODE_PIXELS
  const jpegQuality = Number(options.jpegQuality) || DEFAULT_LOSSY_PRESET.jpegQuality
  const minSavingsBytes = normalizeMinSavingsBytes(options.minSavingsBytes)
  const keepTransparencyPng = options.keepTransparencyPng !== false
  let compressedImages = 0
  let skippedImages = 0
  const skippedByReason = {}
  const images = collectPdfImageStreams(pdf)
  const filtersByName = summarizeFilters(images)

  for (const [index, image] of images.entries()) {
    progress({ current: index + 1, total: images.length })
    const analysis = analyzePdfImageStream(
      image.stream,
      image.pageNumber,
      image.name,
      maxImageDimension,
    )
    const canFlattenAlpha = !keepTransparencyPng && canFlattenSoftMaskImage(image.stream, analysis)
    const skipReason = getCompressionSkipReason(analysis, canFlattenAlpha)
    if (!image.ref || skipReason || (!analysis.candidate && !canFlattenAlpha)) {
      skippedImages++
      incrementReason(skippedByReason, skipReason || analysis.skipReason || 'NO_IMAGE_REF')
      continue
    }

    const originalBytes = image.stream.asUint8Array()
    if (exceedsDecodePixelLimit(analysis, maxDecodePixels)) {
      skippedImages++
      incrementReason(skippedByReason, 'TOO_MANY_PIXELS')
      continue
    }
    const encoded = await tryEncodeImageWithCodec(
      image.stream,
      analysis,
      codec,
      jpegQuality,
      maxImageDimension,
      {
        flattenAlpha: canFlattenAlpha,
        grayscale: options.grayscale,
        maxDecodePixels,
      },
    )

    if (
      !encoded?.data?.byteLength ||
      !isMeaningfullySmaller(
        encoded.data.byteLength,
        originalBytes.byteLength,
        minSavingsBytes,
      )
    ) {
      skippedImages++
      incrementReason(skippedByReason, encoded?.data?.byteLength ? 'NOT_SMALLER' : 'ENCODE_FAILED')
      continue
    }

    const nextWidth = Number(encoded.width) || analysis.width
    const nextHeight = Number(encoded.height) || analysis.height
    const nextDict = image.stream.dict.clone(pdf.context)
    nextDict.set(PDF_IMAGE_ANALYSIS_NAMES.width, PDFNumber.of(nextWidth))
    nextDict.set(PDF_IMAGE_ANALYSIS_NAMES.height, PDFNumber.of(nextHeight))
    nextDict.set(PDF_IMAGE_ANALYSIS_NAMES.bitsPerComponent, PDFNumber.of(8))
    nextDict.set(PDF_IMAGE_ANALYSIS_NAMES.colorSpace, getJpegColorSpaceName(encoded.data))
    nextDict.set(PDF_IMAGE_ANALYSIS_NAMES.filter, PDF_NAME_DCT_DECODE)
    nextDict.delete(PDFName.of('DecodeParms'))
    nextDict.delete(PDF_NAME_DECODE)
    if (canFlattenAlpha) {
      nextDict.delete(PDF_IMAGE_ANALYSIS_NAMES.sMask)
      nextDict.delete(PDF_IMAGE_ANALYSIS_NAMES.mask)
    }

    pdf.context.assign(image.ref, PDFRawStream.of(nextDict, encoded.data))
    compressedImages++
  }

  if (!compressedImages) {
    throw Object.assign(new Error('No compressible images found.'), {
      code: 'COMPRESS_NOT_EFFECTIVE',
      details: { skippedByReason, filtersByName },
    })
  }

  const data = await pdf.save({ useObjectStreams: true, updateFieldAppearances: false })
  if (data.byteLength >= originalSize) {
    throw Object.assign(new Error('Compressed PDF is not smaller.'), {
      code: 'COMPRESS_NOT_EFFECTIVE',
      details: { skippedByReason, filtersByName },
    })
  }
  return {
    data,
    compressedImages,
    skippedImages,
    skippedByReason,
    filtersByName,
    outputSize: data.byteLength,
  }
}

const normalizeMinSavingsBytes = (value) => {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes < 0) return DEFAULT_MIN_SAVINGS_BYTES
  return Math.round(bytes)
}

const isMeaningfullySmaller = (nextSize, originalSize, minSavingsBytes) => {
  const savedBytes = originalSize - nextSize
  return nextSize > 0 && originalSize > 0 && savedBytes >= minSavingsBytes
}

const getCompressionSkipReason = (analysis, canFlattenAlpha) => {
  if (
    !canFlattenAlpha &&
    analysis.bitsPerComponent &&
    analysis.bitsPerComponent < 8 &&
    analysis.filters.includes('DCTDecode')
  ) {
    return 'LOW_BIT_DEPTH'
  }
  return ''
}

const canFlattenSoftMaskImage = (stream, analysis) => {
  const softMask = stream.dict.lookupMaybe(PDF_IMAGE_ANALYSIS_NAMES.sMask, PDFRawStream, PDFStream)
  return (
    analysis.skipReason === 'HAS_ALPHA_OR_MASK' &&
    analysis.filters.includes('FlateDecode') &&
    !stream.dict.has(PDF_IMAGE_ANALYSIS_NAMES.mask) &&
    canDecodeSoftMask(softMask, analysis.width, analysis.height)
  )
}

const canDecodeSoftMask = (softMask, width, height) => {
  if (!softMask) return false
  const maskWidth =
    Number(softMask.dict?.lookupMaybe?.(PDF_IMAGE_ANALYSIS_NAMES.width, PDFNumber)?.asNumber?.()) ||
    0
  const maskHeight =
    Number(
      softMask.dict?.lookupMaybe?.(PDF_IMAGE_ANALYSIS_NAMES.height, PDFNumber)?.asNumber?.(),
    ) || 0
  const maskBits =
    Number(
      softMask.dict
        ?.lookupMaybe?.(PDF_IMAGE_ANALYSIS_NAMES.bitsPerComponent, PDFNumber)
        ?.asNumber?.(),
    ) || 0
  const maskFilters = getPdfImageFilterNames(softMask)
  return (
    maskWidth === width &&
    maskHeight === height &&
    [1, 2, 4, 8].includes(maskBits) &&
    maskFilters.includes('FlateDecode')
  )
}

const hasFlattenableAlphaImages = (analysis, options = {}, imageStreams = []) => {
  return (
    options.keepTransparencyPng === false &&
    analysis.images?.some((image, index) => {
      const stream = imageStreams[index]?.stream
      const softMask = stream?.dict?.lookup?.(PDF_IMAGE_ANALYSIS_NAMES.sMask)
      return (
        image.skipReason === 'HAS_ALPHA_OR_MASK' &&
        image.filters?.includes('FlateDecode') &&
        !stream?.dict?.has?.(PDF_IMAGE_ANALYSIS_NAMES.mask) &&
        canDecodeSoftMask(softMask, image.width, image.height)
      )
    })
  )
}

const createNoRewriteResult = (file, analysis, compressionDetails = {}) => ({
  data: new Uint8Array(file),
  outputSize: file.byteLength,
  compressedImages: 0,
  skippedImages: analysis.skippedCount || analysis.imageCount || 0,
  skippedByReason: mergeSummaries(analysis.skippedByReason, compressionDetails.skippedByReason),
  filtersByName: analysis.filtersByName || compressionDetails.filtersByName || {},
})

const finishImageCompressionResult = async (
  file,
  options,
  documentAnalysis,
  startedAt,
  now,
  {
    result,
    imageCompressionError = null,
    optimizeOutput,
    onProgress,
    encodeBackend,
    jpxCodecAvailable,
    imageRewriteDurationMs,
  },
) => {
  onProgress(0.9, '正在优化 PDF 结构')
  const qpdfStartedAt = now()
  const optimized = (await optimizeOutput?.(result.data, options)) || null
  const qpdfOptimizeDurationMs = Math.round(now() - qpdfStartedAt)
  const data = optimized?.data || result.data
  const backend = optimized
    ? [encodeBackend, 'qpdf.wasm'].filter(Boolean).join('+')
    : encodeBackend || 'qpdf.wasm'
  const totalDurationMs = Math.round(now() - startedAt)
  return [
    {
      name: 'compressed.pdf',
      data,
      originalSize: file.byteLength,
      outputSize: data.byteLength,
      backend,
      documentType: documentAnalysis.documentType,
      compressionStrategy: COMPRESSION_STRATEGIES.IMAGE_XOBJECT,
      compressionMode: options.mode || 'auto',
      imageCodecBackend: encodeBackend,
      jpxCodecAvailable,
      compressedImages: result.compressedImages,
      skippedImages: result.skippedImages,
      skippedByReason: result.skippedByReason,
      filtersByName: result.filtersByName,
      imageCompressionNotEffective: !!imageCompressionError,
      optimizedByQpdf: !!optimized,
      timing: {
        totalDurationMs,
        imageRewriteDurationMs,
        qpdfOptimizeDurationMs,
      },
      notEffective: data.byteLength >= file.byteLength,
    },
  ]
}

const formatImageCodecBackend = (codec) => {
  if (codec?.backend === 'image-codec.wasm') return 'image-codec.wasm'
  return '图片编码器'
}

const mergeSummaries = (...summaries) => {
  return summaries.reduce((merged, summary) => {
    if (!summary || typeof summary !== 'object') return merged
    for (const [key, count] of Object.entries(summary)) merged[key] = (merged[key] || 0) + count
    return merged
  }, {})
}

const exceedsDecodePixelLimit = (analysis, maxDecodePixels) => {
  return (
    analysis.width > 0 && analysis.height > 0 && analysis.width * analysis.height > maxDecodePixels
  )
}

const incrementReason = (summary, reason) => {
  summary[reason] = (summary[reason] || 0) + 1
}

const encodeRgbOrGrayJpeg = (codec, input) => {
  if (input.grayscale && typeof codec.encodeGrayJpeg === 'function') {
    return codec.encodeGrayJpeg({
      data: rgbToGray(input.data),
      width: input.width,
      height: input.height,
      quality: input.quality,
      maxImageDimension: input.maxImageDimension,
    })
  }

  return codec.encodeRgbJpeg(input)
}

const rgbToGray = (rgb) => {
  const pixels = Math.floor(rgb.byteLength / 3)
  const gray = new Uint8Array(pixels)
  for (let i = 0; i < pixels; i++) {
    const input = i * 3
    gray[i] = Math.round(rgb[input] * 0.299 + rgb[input + 1] * 0.587 + rgb[input + 2] * 0.114)
  }
  return gray
}

const summarizeFilters = (images) => {
  return images.reduce((summary, image) => {
    const filters = getPdfImageFilterNames(image.stream)
    for (const filter of filters.length ? filters : ['NO_FILTER'])
      summary[filter] = (summary[filter] || 0) + 1
    return summary
  }, {})
}

const getPdfImageFilterNames = (stream) => {
  const value = stream?.dict?.lookup?.(PDF_IMAGE_ANALYSIS_NAMES.filter)
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

const getJpegColorSpaceName = (data) => {
  const components = getJpegComponentCount(data)
  if (components === 1) return PDF_NAME_DEVICE_GRAY
  if (components === 4) return PDF_NAME_DEVICE_CMYK
  return PDF_NAME_DEVICE_RGB
}

const getJpegComponentCount = (data) => {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data || [])
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 3

  for (let offset = 2; offset + 4 < bytes.byteLength; ) {
    if (bytes[offset] !== 0xff) return 3
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (marker === 0xda || marker === 0xd9) break
    if (isJpegStandaloneMarker(marker)) continue
    if (offset + 2 > bytes.byteLength) break

    const length = (bytes[offset] << 8) | bytes[offset + 1]
    if (length < 2 || offset + length > bytes.byteLength) break
    if (isJpegStartOfFrameMarker(marker)) return bytes[offset + 7] || 3
    offset += length
  }

  return 3
}

const isJpegStandaloneMarker = (marker) => marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)

const isJpegStartOfFrameMarker = (marker) => {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  )
}

const tryEncodeImageWithCodec = async (
  stream,
  analysis,
  codec,
  jpegQuality,
  maxImageDimension,
  options,
) => {
  try {
    return await encodeImageWithCodec(
      stream,
      analysis,
      codec,
      jpegQuality,
      maxImageDimension,
      options,
    )
  } catch {
    return null
  }
}

const encodeImageWithCodec = async (
  stream,
  analysis,
  codec,
  jpegQuality,
  maxImageDimension,
  options = {},
) => {
  if (analysis.filters.includes('DCTDecode')) {
    const preserveGray = analysis.colorSpace === 'DeviceGray' && analysis.colorSpaceComponents === 1
    return codec.reencodeJpeg({
      data: stream.asUint8Array(),
      width: analysis.width,
      height: analysis.height,
      quality: jpegQuality,
      maxImageDimension,
      grayscale: options.grayscale || preserveGray,
    })
  }

  if (analysis.filters.includes('FlateDecode')) {
    const indexedRgb = decodeFlateImageToIndexedRgb(stream, analysis)
    if (indexedRgb) {
      const indexedGray =
        typeof codec.encodeGrayJpeg === 'function'
          ? indexedRgbToGray(indexedRgb, options.grayscale)
          : null
      if (indexedGray) {
        return codec.encodeGrayJpeg({
          data: indexedGray,
          width: analysis.width,
          height: analysis.height,
          quality: jpegQuality,
          maxImageDimension,
        })
      }
      if (typeof codec.encodeIndexedRgbJpeg !== 'function') return null
      return codec.encodeIndexedRgbJpeg({
        data: indexedRgb.indexes,
        palette: indexedRgb.palette,
        paletteEntries: indexedRgb.paletteEntries,
        width: analysis.width,
        height: analysis.height,
        quality: jpegQuality,
        maxImageDimension,
        grayscale: options.grayscale,
      })
    }

    const indexedGray =
      typeof codec.encodeGrayJpeg === 'function'
        ? decodeFlateImageToIndexedGray(stream, analysis)
        : null
    if (indexedGray) {
      return codec.encodeGrayJpeg({
        data: indexedGray,
        width: analysis.width,
        height: analysis.height,
        quality: jpegQuality,
        maxImageDimension,
      })
    }

    const lab =
      !options.grayscale && typeof codec.encodeLabJpeg === 'function'
        ? decodeFlateImageToLab(stream, analysis, options)
        : null
    if (lab) {
      return codec.encodeLabJpeg({
        data: lab,
        width: analysis.width,
        height: analysis.height,
        labRange: analysis.labRange,
        quality: jpegQuality,
        maxImageDimension,
      })
    }

    const gray =
      typeof codec.encodeGrayJpeg === 'function'
        ? decodeFlateImageToGray(stream, analysis, options)
        : null
    if (gray) {
      return codec.encodeGrayJpeg({
        data: gray,
        width: analysis.width,
        height: analysis.height,
        quality: jpegQuality,
        maxImageDimension,
      })
    }

    const colorGray =
      options.grayscale && typeof codec.encodeGrayJpeg === 'function'
        ? decodeFlateColorImageToGray(stream, analysis, options)
        : null
    if (colorGray) {
      return codec.encodeGrayJpeg({
        data: colorGray,
        width: analysis.width,
        height: analysis.height,
        quality: jpegQuality,
        maxImageDimension,
      })
    }

    const cmyk =
      !options.grayscale && typeof codec.encodeCmykJpeg === 'function'
        ? decodeFlateImageToCmyk(stream, analysis, options)
        : null
    if (cmyk) {
      return codec.encodeCmykJpeg({
        data: cmyk,
        width: analysis.width,
        height: analysis.height,
        quality: jpegQuality,
        maxImageDimension,
      })
    }

    const rgb = decodeFlateImageToRgb(stream, analysis, options)
    if (!rgb) return null
    return encodeRgbOrGrayJpeg(codec, {
      data: rgb,
      width: analysis.width,
      height: analysis.height,
      quality: jpegQuality,
      maxImageDimension,
      grayscale: options.grayscale,
    })
  }

  if (
    ['JPXDecode', 'JBIG2Decode', 'CCITTFaxDecode'].some((filter) =>
      analysis.filters.includes(filter),
    )
  ) {
    if (typeof codec.decodePdfImage !== 'function') return null
    if (
      analysis.width &&
      analysis.height &&
      analysis.width * analysis.height > options.maxDecodePixels
    )
      return null
    const decoded = await codec.decodePdfImage({
      data: stream.asUint8Array(),
      width: analysis.width,
      height: analysis.height,
      bitsPerComponent: analysis.bitsPerComponent,
      colorSpace: analysis.colorSpace,
      colorSpaceComponents: analysis.colorSpaceComponents,
      alternateColorSpace: analysis.alternateColorSpace,
      labRange: analysis.labRange,
      filters: analysis.filters,
      maxDecodePixels: options.maxDecodePixels,
    })
    const image = normalizeDecodedImage(decoded, options.maxDecodePixels, analysis, options)
    if (!image) return null
    if (image.colorSpace === 'DeviceGray' && typeof codec.encodeGrayJpeg === 'function') {
      return codec.encodeGrayJpeg({
        data: image.data,
        width: image.width,
        height: image.height,
        quality: jpegQuality,
        maxImageDimension,
      })
    }
    return encodeRgbOrGrayJpeg(codec, {
      data: image.data,
      width: image.width,
      height: image.height,
      quality: jpegQuality,
      maxImageDimension,
      grayscale: options.grayscale,
    })
  }

  return null
}

const decodeFlateImageToIndexedRgb = (stream, analysis) => {
  if (analysis.colorSpace !== 'Indexed') return null
  if (
    Number(analysis.baseColorSpaceComponents) !== 3 ||
    analysis.alternateColorSpace !== 'DeviceRGB'
  )
    return null
  const palette = getIndexedPalette(stream, analysis)
  const highValue = Number(analysis.indexedHighValue)
  if (!palette || highValue < 0 || palette.byteLength < (highValue + 1) * 3) return null
  const raw = decodeFlateSamples(stream, analysis, 1)
  if (!raw) return null
  const indexes = unpackIndexedSamples(
    raw,
    analysis.bitsPerComponent,
    analysis.width * analysis.height,
  )
  if (!indexes) return null
  return { indexes, palette, paletteEntries: highValue + 1 }
}

const decodeFlateImageToIndexedGray = (stream, analysis) => {
  if (analysis.colorSpace !== 'Indexed') return null
  if (
    Number(analysis.baseColorSpaceComponents) !== 1 ||
    analysis.alternateColorSpace !== 'DeviceGray'
  )
    return null
  const palette = getIndexedPalette(stream, analysis)
  const highValue = Number(analysis.indexedHighValue)
  if (!palette || highValue < 0 || palette.byteLength < highValue + 1) return null
  const raw = decodeFlateSamples(stream, analysis, 1)
  if (!raw) return null
  const indexes = unpackIndexedSamples(
    raw,
    analysis.bitsPerComponent,
    analysis.width * analysis.height,
  )
  if (!indexes) return null

  const gray = new Uint8Array(indexes.byteLength)
  for (let i = 0; i < indexes.byteLength; i++) {
    const index = indexes[i]
    if (index > highValue) return null
    gray[i] = palette[index]
  }
  return gray
}

const indexedRgbToGray = ({ indexes, palette, paletteEntries }, forceGrayscale = false) => {
  if (!indexes?.byteLength || !palette?.byteLength || paletteEntries <= 0) return null
  const grayPalette = new Uint8Array(paletteEntries)
  let paletteIsGray = true
  for (let i = 0; i < paletteEntries; i++) {
    const input = i * 3
    const red = palette[input]
    const green = palette[input + 1]
    const blue = palette[input + 2]
    if (red !== green || red !== blue) paletteIsGray = false
    grayPalette[i] = Math.round(red * 0.299 + green * 0.587 + blue * 0.114)
  }
  if (!forceGrayscale && !paletteIsGray) return null

  const gray = new Uint8Array(indexes.byteLength)
  for (let i = 0; i < indexes.byteLength; i++) {
    const index = indexes[i]
    if (index >= paletteEntries) return null
    gray[i] = grayPalette[index]
  }
  return gray
}

const decodeFlateImageToLab = (stream, analysis, options) => {
  if (options.flattenAlpha) return null
  const pixels = analysis.width * analysis.height
  const components = Number(analysis.colorSpaceComponents) || 0
  if (components !== 3 || analysis.colorSpace !== 'Lab') return null
  const raw = decodeFlateSamples(stream, analysis, components)
  if (!raw) return null
  const lab = normalizeComponentSamples(
    raw,
    analysis.bitsPerComponent,
    components,
    pixels,
    analysis.decode,
  )
  if (!lab || lab.byteLength !== pixels * 3) return null
  return lab
}

const decodeFlateImageToGray = (stream, analysis, options) => {
  const pixels = analysis.width * analysis.height
  const components = Number(analysis.colorSpaceComponents) || 0
  if (components !== 1 || analysis.colorSpace !== 'DeviceGray') return null
  const raw = decodeFlateSamples(stream, analysis, components)
  if (!raw) return null
  const gray = normalizeComponentSamples(
    raw,
    analysis.bitsPerComponent,
    components,
    pixels,
    analysis.decode,
  )
  if (!gray || gray.byteLength !== pixels) return null

  if (!options.flattenAlpha) return gray
  const alpha = decodeSoftMask(stream, analysis.width, analysis.height)
  if (!alpha) return null
  const output = new Uint8Array(gray)
  flattenGrayOverWhite(output, alpha)
  return output
}

const decodeFlateImageToCmyk = (stream, analysis, options) => {
  if (options.flattenAlpha) return null
  const pixels = analysis.width * analysis.height
  const components = Number(analysis.colorSpaceComponents) || 0
  if (components !== 4 || analysis.colorSpace !== 'DeviceCMYK') return null
  const raw = decodeFlateSamples(stream, analysis, components)
  if (!raw) return null
  const cmyk = normalizeComponentSamples(
    raw,
    analysis.bitsPerComponent,
    components,
    pixels,
    analysis.decode,
  )
  if (!cmyk || cmyk.byteLength !== pixels * 4) return null
  return cmyk
}

const decodeFlateColorImageToGray = (stream, analysis, options) => {
  if (options.flattenAlpha) return null
  const pixels = analysis.width * analysis.height
  const components = Number(analysis.colorSpaceComponents) || 0
  if (
    ![3, 4].includes(components) ||
    !['DeviceRGB', 'DeviceCMYK', 'Lab'].includes(analysis.colorSpace)
  )
    return null
  const raw = decodeFlateSamples(stream, analysis, components)
  if (!raw) return null
  const samples = normalizeComponentSamples(
    raw,
    analysis.bitsPerComponent,
    components,
    pixels,
    analysis.decode,
  )
  if (!samples || samples.byteLength !== pixels * components) return null

  if (analysis.colorSpace === 'DeviceRGB') return rgbSamplesToGray(samples)
  if (analysis.colorSpace === 'DeviceCMYK') return cmykSamplesToGray(samples)
  if (analysis.colorSpace === 'Lab') return labSamplesToGray(samples, analysis.labRange)
  return null
}

const decodeFlateImageToRgb = (stream, analysis, options) => {
  const pixels = analysis.width * analysis.height
  const components = Number(analysis.colorSpaceComponents) || 0
  const raw = decodeFlateSamples(stream, analysis, components)
  if (!raw) return null
  if (analysis.colorSpace === 'Indexed') return indexedSamplesToRgb(stream, analysis, raw)
  const samples = normalizeComponentSamples(
    raw,
    analysis.bitsPerComponent,
    components,
    pixels,
    analysis.decode,
  )
  if (!samples) return null
  if (!components || samples.byteLength !== pixels * components) return null

  const rgb = samplesToRgb(samples, components, analysis.colorSpace, analysis.labRange)
  if (!rgb) return null

  if (!options.flattenAlpha) return rgb
  const alpha = decodeSoftMask(stream, analysis.width, analysis.height)
  if (!alpha) return null
  flattenRgbOverWhite(rgb, alpha)
  return rgb
}

const decodeSoftMask = (stream, width, height) => {
  const sMask = stream.dict.lookupMaybe(PDF_IMAGE_ANALYSIS_NAMES.sMask, PDFRawStream, PDFStream)
  if (!canDecodeSoftMask(sMask, width, height)) return null
  const maskBits =
    Number(
      sMask.dict?.lookupMaybe?.(PDF_IMAGE_ANALYSIS_NAMES.bitsPerComponent, PDFNumber)?.asNumber?.(),
    ) || 0
  const raw = decodeFlateSamples(
    sMask,
    {
      width,
      height,
      bitsPerComponent: maskBits,
      colorSpace: 'DeviceGray',
    },
    1,
  )
  if (!raw) return null
  return normalizeComponentSamples(
    raw,
    maskBits,
    1,
    width * height,
    getNumberList(sMask.dict.lookup(PDF_NAME_DECODE)),
  )
}

const decodeFlateSamples = (stream, analysis, components) => {
  const raw = decodePDFRawStream(stream).getBytes()
  const decodeParms = getDecodeParms(stream, analysis)
  const predictor = numberFromDict(decodeParms, PDF_NAME_PREDICTOR) || 1
  if (predictor <= 1) return raw
  if (predictor < 10 || predictor > 15) return null

  const colors =
    numberFromDict(decodeParms, PDF_NAME_COLORS) ||
    (analysis.colorSpace === 'Indexed' ? 1 : components)
  const columns = numberFromDict(decodeParms, PDF_NAME_COLUMNS) || analysis.width
  const bitsPerComponent = analysis.bitsPerComponent || 8
  if (!colors || columns !== analysis.width || ![1, 2, 4, 8].includes(bitsPerComponent)) return null

  const bytesPerPixel = Math.max(1, Math.ceil((colors * bitsPerComponent) / 8))
  const rowLength = Math.ceil((columns * colors * bitsPerComponent) / 8)
  const encodedRowLength = rowLength + 1
  if (raw.byteLength !== encodedRowLength * analysis.height) return null

  const decoded = new Uint8Array(rowLength * analysis.height)
  for (let row = 0; row < analysis.height; row++) {
    const filter = raw[row * encodedRowLength]
    const encodedOffset = row * encodedRowLength + 1
    const decodedOffset = row * rowLength
    for (let col = 0; col < rowLength; col++) {
      const current = raw[encodedOffset + col]
      const left = col >= bytesPerPixel ? decoded[decodedOffset + col - bytesPerPixel] : 0
      const up = row > 0 ? decoded[decodedOffset - rowLength + col] : 0
      const upLeft =
        row > 0 && col >= bytesPerPixel
          ? decoded[decodedOffset - rowLength + col - bytesPerPixel]
          : 0
      decoded[decodedOffset + col] = undoPngFilter(filter, current, left, up, upLeft)
    }
  }
  return decoded
}

const getDecodeParms = (stream, analysis = {}) => {
  const value = stream.dict.lookup(PDF_IMAGE_ANALYSIS_NAMES.decodeParms)
  if (value instanceof PDFDict) return value
  if (value instanceof PDFArray) {
    const filterIndex = Array.isArray(analysis.filters)
      ? analysis.filters.indexOf('FlateDecode')
      : -1
    const index = filterIndex >= 0 && filterIndex < value.size() ? filterIndex : 0
    return value.lookupMaybe(index, PDFDict) || value.lookupMaybe(0, PDFDict)
  }
  return null
}

const numberFromDict = (dict, name) => dict?.lookupMaybe?.(name, PDFNumber)?.asNumber?.() || 0

const getNumberList = (value) => {
  if (!(value instanceof PDFArray)) return []
  const numbers = []
  for (let i = 0; i < value.size(); i++) {
    const item = value.lookupMaybe(i, PDFNumber)
    if (item) numbers.push(item.asNumber())
  }
  return numbers
}

const undoPngFilter = (filter, current, left, up, upLeft) => {
  if (filter === 0) return current
  if (filter === 1) return (current + left) & 255
  if (filter === 2) return (current + up) & 255
  if (filter === 3) return (current + Math.floor((left + up) / 2)) & 255
  if (filter === 4) return (current + paeth(left, up, upLeft)) & 255
  return current
}

const paeth = (left, up, upLeft) => {
  const estimate = left + up - upLeft
  const leftDistance = Math.abs(estimate - left)
  const upDistance = Math.abs(estimate - up)
  const upLeftDistance = Math.abs(estimate - upLeft)
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left
  if (upDistance <= upLeftDistance) return up
  return upLeft
}

const indexedSamplesToRgb = (stream, analysis, samples) => {
  const palette = getIndexedPalette(stream, analysis)
  const baseComponents = Number(analysis.baseColorSpaceComponents) || 0
  const highValue = Number(analysis.indexedHighValue)
  if (!palette || !baseComponents || highValue < 0) return null
  if (palette.byteLength < (highValue + 1) * baseComponents) return null

  const pixels = analysis.width * analysis.height
  const indexes = unpackIndexedSamples(samples, analysis.bitsPerComponent, pixels)
  if (!indexes) return null

  const baseSamples = new Uint8Array(pixels * baseComponents)
  for (let i = 0; i < pixels; i++) {
    const index = indexes[i]
    if (index > highValue) return null
    const paletteOffset = index * baseComponents
    const sampleOffset = i * baseComponents
    for (let component = 0; component < baseComponents; component++) {
      baseSamples[sampleOffset + component] = palette[paletteOffset + component]
    }
  }
  return samplesToRgb(baseSamples, baseComponents, analysis.alternateColorSpace)
}

const getIndexedPalette = (stream, analysis) => {
  const colorSpace = stream.dict.lookup(PDF_IMAGE_ANALYSIS_NAMES.colorSpace)
  if (!(colorSpace instanceof PDFArray)) return null
  const lookup = colorSpace.lookup(3)
  if (lookup instanceof PDFString || lookup instanceof PDFHexString) return lookup.asBytes()
  if (lookup instanceof PDFRawStream || lookup instanceof PDFStream)
    return decodePDFRawStream(lookup).getBytes()
  if (lookup instanceof PDFName && analysis.baseColorSpaceComponents === 3) return lookup.asBytes()
  return null
}

const unpackIndexedSamples = (samples, bitsPerComponent, pixels) => {
  if (bitsPerComponent === 8) return samples.byteLength === pixels ? samples : null
  const indexes = new Uint8Array(pixels)
  const mask = (1 << bitsPerComponent) - 1
  let output = 0
  for (let i = 0; i < samples.byteLength && output < pixels; i++) {
    for (
      let shift = 8 - bitsPerComponent;
      shift >= 0 && output < pixels;
      shift -= bitsPerComponent
    ) {
      indexes[output++] = (samples[i] >> shift) & mask
    }
  }
  return output === pixels ? indexes : null
}

const normalizeComponentSamples = (samples, bitsPerComponent, components, pixels, decode = []) => {
  if (!components || !pixels || ![1, 2, 4, 8].includes(bitsPerComponent)) return null
  const totalSamples = pixels * components
  const unpacked =
    bitsPerComponent === 8 ? samples : unpackPackedSamples(samples, bitsPerComponent, totalSamples)
  if (!unpacked || unpacked.byteLength !== totalSamples) return null

  const maxSample = (1 << bitsPerComponent) - 1
  const hasDecode = Array.isArray(decode) && decode.length >= components * 2
  if (bitsPerComponent === 8 && !hasDecode) return unpacked

  const normalized = new Uint8Array(totalSamples)
  for (let i = 0; i < totalSamples; i++) {
    const component = i % components
    const min = hasDecode ? Number(decode[component * 2]) : 0
    const max = hasDecode ? Number(decode[component * 2 + 1]) : 1
    const value = maxSample ? unpacked[i] / maxSample : 0
    normalized[i] = clampByte(Math.round((min + value * (max - min)) * 255))
  }
  return normalized
}

const unpackPackedSamples = (samples, bitsPerComponent, totalSamples) => {
  const unpacked = new Uint8Array(totalSamples)
  const mask = (1 << bitsPerComponent) - 1
  let output = 0
  for (let i = 0; i < samples.byteLength && output < totalSamples; i++) {
    for (
      let shift = 8 - bitsPerComponent;
      shift >= 0 && output < totalSamples;
      shift -= bitsPerComponent
    ) {
      unpacked[output++] = (samples[i] >> shift) & mask
    }
  }
  return output === totalSamples ? unpacked : null
}

const samplesToRgb = (samples, components, colorSpace = '', labRange = []) => {
  if (colorSpace === 'Lab') return labSamplesToRgb(samples, labRange)
  if (components === 3) return samples
  const pixels = samples.byteLength / components
  const rgb = new Uint8Array(pixels * 3)

  if (components === 1) {
    for (let i = 0; i < pixels; i++) {
      const gray = samples[i]
      const out = i * 3
      rgb[out] = gray
      rgb[out + 1] = gray
      rgb[out + 2] = gray
    }
    return rgb
  }

  if (components === 4) {
    for (let i = 0; i < pixels; i++) {
      const input = i * 4
      const output = i * 3
      const c = samples[input] / 255
      const m = samples[input + 1] / 255
      const y = samples[input + 2] / 255
      const k = samples[input + 3] / 255
      rgb[output] = Math.round(255 * (1 - c) * (1 - k))
      rgb[output + 1] = Math.round(255 * (1 - m) * (1 - k))
      rgb[output + 2] = Math.round(255 * (1 - y) * (1 - k))
    }
    return rgb
  }

  return null
}

const rgbSamplesToGray = (samples) => {
  const pixels = samples.byteLength / 3
  const gray = new Uint8Array(pixels)
  for (let i = 0; i < pixels; i++) {
    const input = i * 3
    gray[i] = rgbToGrayByte(samples[input], samples[input + 1], samples[input + 2])
  }
  return gray
}

const cmykSamplesToGray = (samples) => {
  const pixels = samples.byteLength / 4
  const gray = new Uint8Array(pixels)
  for (let i = 0; i < pixels; i++) {
    const input = i * 4
    const c = samples[input] / 255
    const m = samples[input + 1] / 255
    const y = samples[input + 2] / 255
    const k = samples[input + 3] / 255
    gray[i] = rgbToGrayByte(
      Math.round(255 * (1 - c) * (1 - k)),
      Math.round(255 * (1 - m) * (1 - k)),
      Math.round(255 * (1 - y) * (1 - k)),
    )
  }
  return gray
}

const labSamplesToGray = (samples, labRange = []) => {
  if (samples.byteLength % 3) return null
  const pixels = samples.byteLength / 3
  const gray = new Uint8Array(pixels)
  const aMin = Number.isFinite(labRange[0]) ? labRange[0] : -100
  const aMax = Number.isFinite(labRange[1]) ? labRange[1] : 100
  const bMin = Number.isFinite(labRange[2]) ? labRange[2] : -100
  const bMax = Number.isFinite(labRange[3]) ? labRange[3] : 100

  for (let i = 0; i < pixels; i++) {
    const input = i * 3
    const l = (samples[input] / 255) * 100
    const a = aMin + (samples[input + 1] / 255) * (aMax - aMin)
    const b = bMin + (samples[input + 2] / 255) * (bMax - bMin)
    const rgb = labToSrgb(l, a, b)
    gray[i] = rgbToGrayByte(rgb[0], rgb[1], rgb[2])
  }
  return gray
}

const rgbToGrayByte = (red, green, blue) => Math.round(red * 0.299 + green * 0.587 + blue * 0.114)

const labSamplesToRgb = (samples, labRange = []) => {
  if (samples.byteLength % 3) return null
  const pixels = samples.byteLength / 3
  const rgb = new Uint8Array(pixels * 3)
  const aMin = Number.isFinite(labRange[0]) ? labRange[0] : -100
  const aMax = Number.isFinite(labRange[1]) ? labRange[1] : 100
  const bMin = Number.isFinite(labRange[2]) ? labRange[2] : -100
  const bMax = Number.isFinite(labRange[3]) ? labRange[3] : 100

  for (let i = 0; i < pixels; i++) {
    const input = i * 3
    const output = i * 3
    const l = (samples[input] / 255) * 100
    const a = aMin + (samples[input + 1] / 255) * (aMax - aMin)
    const b = bMin + (samples[input + 2] / 255) * (bMax - bMin)
    const converted = labToSrgb(l, a, b)
    rgb[output] = converted[0]
    rgb[output + 1] = converted[1]
    rgb[output + 2] = converted[2]
  }
  return rgb
}

const labToSrgb = (l, a, b) => {
  const fy = (l + 16) / 116
  const fx = fy + a / 500
  const fz = fy - b / 200
  const xr = labPivot(fx)
  const yr = l > 8 ? Math.pow((l + 16) / 116, 3) : l / 903.3
  const zr = labPivot(fz)
  const x = xr * 0.95047
  const y = yr
  const z = zr * 1.08883
  const r = x * 3.2406 + y * -1.5372 + z * -0.4986
  const g = x * -0.9689 + y * 1.8758 + z * 0.0415
  const blue = x * 0.0557 + y * -0.204 + z * 1.057
  return [linearToSrgbByte(r), linearToSrgbByte(g), linearToSrgbByte(blue)]
}

const labPivot = (value) => {
  const cube = value * value * value
  return cube > 0.008856 ? cube : (116 * value - 16) / 903.3
}

const linearToSrgbByte = (value) => {
  const clamped = Math.max(0, Math.min(1, value))
  return clampByte(
    Math.round(
      (clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055) * 255,
    ),
  )
}

const flattenRgbOverWhite = (rgb, alpha) => {
  for (let i = 0; i < alpha.byteLength; i++) {
    const a = alpha[i] / 255
    const out = i * 3
    rgb[out] = Math.round(rgb[out] * a + 255 * (1 - a))
    rgb[out + 1] = Math.round(rgb[out + 1] * a + 255 * (1 - a))
    rgb[out + 2] = Math.round(rgb[out + 2] * a + 255 * (1 - a))
  }
}

const flattenGrayOverWhite = (gray, alpha) => {
  for (let i = 0; i < alpha.byteLength; i++) {
    const a = alpha[i] / 255
    gray[i] = Math.round(gray[i] * a + 255 * (1 - a))
  }
}

const clampByte = (value) => Math.max(0, Math.min(255, value))

const normalizeDecodedImage = (decoded, maxDecodePixels, analysis = {}, options = {}) => {
  if (!decoded?.data?.byteLength || !decoded.width || !decoded.height) return null
  if (decoded.width * decoded.height > maxDecodePixels) return null
  const components = Number(decoded.components) || Number(decoded.colorSpaceComponents) || 3
  const colorSpace = getDecodedColorSpace(decoded, analysis, components)
  if (!colorSpace) return null
  const data = decoded.data instanceof Uint8Array ? decoded.data : new Uint8Array(decoded.data)
  if (components === 1 && colorSpace === 'DeviceGray')
    return { data, width: decoded.width, height: decoded.height, colorSpace }
  if (options.grayscale) {
    const gray = decodedColorImageToGray(
      data,
      components,
      colorSpace,
      decoded.labRange || analysis.labRange,
    )
    if (gray)
      return { data: gray, width: decoded.width, height: decoded.height, colorSpace: 'DeviceGray' }
  }
  const rgb = samplesToRgb(data, components, colorSpace, decoded.labRange || analysis.labRange)
  if (!rgb) return null
  return { data: rgb, width: decoded.width, height: decoded.height, colorSpace: 'DeviceRGB' }
}

const decodedColorImageToGray = (data, components, colorSpace, labRange = []) => {
  if (components === 3 && colorSpace === 'DeviceRGB') return rgbSamplesToGray(data)
  if (components === 4 && colorSpace === 'DeviceCMYK') return cmykSamplesToGray(data)
  if (components === 3 && colorSpace === 'Lab') return labSamplesToGray(data, labRange)
  return null
}

const getDecodedColorSpace = (decoded, analysis, components) => {
  if (decoded.colorSpace) return decoded.colorSpace
  if (components === 1) return 'DeviceGray'
  if (components === 3) return 'DeviceRGB'
  if (
    components === 4 &&
    (analysis.colorSpace === 'DeviceCMYK' || analysis.alternateColorSpace === 'DeviceCMYK')
  )
    return 'DeviceCMYK'
  return ''
}

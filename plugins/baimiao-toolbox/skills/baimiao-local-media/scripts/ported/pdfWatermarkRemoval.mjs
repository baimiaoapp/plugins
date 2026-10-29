import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFRawStream,
  decodePDFRawStream,
} from '../../assets/pdf-lib/pdf-lib.mjs'

const WATERMARK_SUBTYPE = '/Watermark'
const WATERMARK_OCG_NAME_PATTERN = /(?:water[\s_-]*mark|水印|浮水印)/iu
const PDF_WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20])
const PDF_DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25])

const WATERMARK_SCAN_PRESETS = Object.freeze({
  cautious: Object.freeze({
    keywords: 'watermark,water mark,水印,浮水印',
    frequencyThreshold: 0.85,
    largeTextThreshold: 96,
  }),
  standard: Object.freeze({
    keywords: 'watermark,water mark,confidential,draft,水印,浮水印,机密,草稿',
    frequencyThreshold: 0.6,
    largeTextThreshold: 72,
  }),
  thorough: Object.freeze({
    keywords:
      'watermark,water mark,confidential,draft,sample,copy,internal,use only,水印,浮水印,机密,草稿,样本,副本,内部,仅供',
    frequencyThreshold: 0.35,
    largeTextThreshold: 48,
  }),
})

export const analyzeWatermarkCandidates = (document, options = {}) => {
  const normalized = normalizeAdvancedOptions(options)
  const candidates = []
  const pageCount = document.getPageCount()
  const watermarkOcgRefs = collectWatermarkOcgRefs(document)
  let structuredOccurrences = 0
  const structuredPages = new Set()
  const xObjects = new Map()

  document.getPages().forEach((page, pageIndex) => {
    const pageNumber = pageIndex + 1
    const annotations = page.node.Annots()
    if (annotations instanceof PDFArray) {
      for (let index = 0; index < annotations.size(); index += 1) {
        const annotation = page.doc.context.lookup(annotations.get(index))
        if (!(annotation instanceof PDFDict)) continue
        const subtype = annotation.get(PDFName.of('Subtype'))?.toString()
        if (subtype === WATERMARK_SUBTYPE) {
          structuredOccurrences += 1
          structuredPages.add(pageNumber)
          continue
        }
        if (subtype === '/Stamp' && dictionaryContainsKeyword(annotation, normalized.keywords)) {
          candidates.push({
            id: `annotation:${pageNumber}:${index}`,
            type: 'annotation',
            reason: 'keyword',
            confidence: 'medium',
            selectedByDefault: false,
            pages: [pageNumber],
            occurrenceCount: 1,
            resourceName: '/Stamp',
          })
        }
      }
    }

    page.node.normalize()
    collectPageXObjectCandidates({
      page,
      pageNumber,
      resources: page.node.Resources(),
      watermarkOcgRefs,
      keywords: normalized.keywords,
      output: xObjects,
    })

    const contents = page.node.Contents()
    if (!(contents instanceof PDFArray)) return
    const watermarkResourceNames = collectWatermarkResourceNames(page, watermarkOcgRefs)
    for (let streamIndex = 0; streamIndex < contents.size(); streamIndex += 1) {
      const stream = page.doc.context.lookup(contents.get(streamIndex))
      if (!(stream instanceof PDFRawStream)) continue
      let decoded
      try {
        decoded = decodePDFRawStream(stream).decode()
      } catch {
        continue
      }
      const explicit = removeWatermarkMarkedContent(decoded, watermarkResourceNames)
      if (explicit.removedCount) {
        structuredOccurrences += explicit.removedCount
        structuredPages.add(pageNumber)
        continue
      }
      collectTextBlockCandidates(decoded, {
        pageNumber,
        streamIndex,
        keywords: normalized.keywords,
        largeTextThreshold: normalized.largeTextThreshold,
        output: candidates,
      })
    }
  })

  if (structuredOccurrences) {
    candidates.unshift({
      id: 'structured',
      type: 'structured',
      reason: 'explicit',
      confidence: 'high',
      selectedByDefault: true,
      pages: [...structuredPages],
      occurrenceCount: structuredOccurrences,
      resourceName: '',
    })
  }

  xObjects.forEach((candidate) => {
    const frequency = candidate.pages.size / Math.max(1, pageCount)
    const hasRepeatedEvidence =
      candidate.pages.size >= 2 && frequency >= normalized.frequencyThreshold
    if (!candidate.keywordMatched && !hasRepeatedEvidence) return
    const hasMultipleEvidence = candidate.keywordMatched && hasRepeatedEvidence
    candidates.push({
      id: candidate.id,
      type: candidate.type,
      reason: hasMultipleEvidence ? 'multiple' : candidate.keywordMatched ? 'keyword' : 'repeated',
      confidence: hasMultipleEvidence ? 'medium' : candidate.keywordMatched ? 'medium' : 'low',
      selectedByDefault: false,
      pages: [...candidate.pages].sort((a, b) => a - b),
      occurrenceCount: candidate.occurrenceCount,
      resourceName: candidate.resourceName,
      pageFrequency: frequency,
    })
  })

  return candidates.sort(compareCandidates)
}

export const removeSelectedWatermarks = (document, options = {}) => {
  const selectedIds = new Set(Array.isArray(options.candidateIds) ? options.candidateIds : [])
  if (options.mode !== 'advanced') return removeStructuredWatermarks(document)

  let removedAdvancedAnnotations = 0
  let removedHeuristicContentSections = 0
  let removedAdvancedXObjectInvocations = 0
  const affectedPages = new Set()
  const selectedXObjectRefs = new Set(
    [...selectedIds].filter((id) => id.startsWith('xobject:')).map((id) => id.slice(8)),
  )

  document.getPages().forEach((page, pageIndex) => {
    const pageNumber = pageIndex + 1
    const annotations = page.node.Annots()
    if (annotations instanceof PDFArray) {
      for (let index = annotations.size() - 1; index >= 0; index -= 1) {
        if (!selectedIds.has(`annotation:${pageNumber}:${index}`)) continue
        annotations.remove(index)
        removedAdvancedAnnotations += 1
        affectedPages.add(pageNumber)
      }
    }

    page.node.normalize()
    const contents = page.node.Contents()
    if (!(contents instanceof PDFArray)) return
    const selectedResourceNames = collectSelectedXObjectResourceNames(page, selectedXObjectRefs)
    for (let streamIndex = 0; streamIndex < contents.size(); streamIndex += 1) {
      const stream = page.doc.context.lookup(contents.get(streamIndex))
      if (!(stream instanceof PDFRawStream)) continue
      let decoded
      try {
        decoded = decodePDFRawStream(stream).decode()
      } catch {
        continue
      }
      const xObjectResult = removeWatermarkMarkedContent(decoded, {
        xObjectNames: selectedResourceNames,
        removeStructured: false,
      })
      const textResult = removeSelectedTextBlocks(
        xObjectResult.data,
        pageNumber,
        streamIndex,
        selectedIds,
      )
      if (!xObjectResult.removedCount && !textResult.removedCount) continue
      const replacement = page.doc.context.flateStream(textResult.data)
      contents.set(streamIndex, page.doc.context.register(replacement))
      removedAdvancedXObjectInvocations += xObjectResult.removedXObjectInvocations
      removedHeuristicContentSections += textResult.removedCount
      affectedPages.add(pageNumber)
    }
  })

  const structured = selectedIds.has('structured')
    ? removeStructuredWatermarks(document)
    : emptyStructuredRemovalSummary()
  structured.affectedPages.forEach((page) => affectedPages.add(page))
  return {
    ...structured,
    removedAnnotations: structured.removedAnnotations + removedAdvancedAnnotations,
    removedXObjectInvocations:
      structured.removedXObjectInvocations + removedAdvancedXObjectInvocations,
    removedHeuristicContentSections,
    removedCount:
      structured.removedCount +
      removedAdvancedAnnotations +
      removedAdvancedXObjectInvocations +
      removedHeuristicContentSections,
    affectedPages: [...affectedPages].sort((a, b) => a - b),
  }
}

export const removeStructuredWatermarks = (document) => {
  let removedAnnotations = 0
  let removedContentSections = 0
  let removedOptionalContentSections = 0
  let removedXObjectInvocations = 0
  const affectedPages = []
  const watermarkOcgRefs = collectWatermarkOcgRefs(document)

  document.getPages().forEach((page, pageIndex) => {
    const annotationCount = removeWatermarkAnnotations(page)
    const contentResult = removeWatermarkContentSections(page, watermarkOcgRefs)
    removedAnnotations += annotationCount
    removedContentSections += contentResult.removedMarkedContent
    removedOptionalContentSections += contentResult.removedOptionalContentSections
    removedXObjectInvocations += contentResult.removedXObjectInvocations
    if (annotationCount || contentResult.removedCount) affectedPages.push(pageIndex + 1)
  })

  return {
    removedAnnotations,
    removedContentSections,
    removedOptionalContentSections,
    removedXObjectInvocations,
    removedCount:
      removedAnnotations +
      removedContentSections +
      removedOptionalContentSections +
      removedXObjectInvocations,
    affectedPages,
  }
}

const emptyStructuredRemovalSummary = () => ({
  removedAnnotations: 0,
  removedContentSections: 0,
  removedOptionalContentSections: 0,
  removedXObjectInvocations: 0,
  removedCount: 0,
  affectedPages: [],
})

const collectWatermarkOcgRefs = (document) => {
  const references = new Set()
  const ocProperties = document.context.lookup(document.catalog.get(PDFName.of('OCProperties')))
  if (!(ocProperties instanceof PDFDict)) return references
  const groups = document.context.lookup(ocProperties.get(PDFName.of('OCGs')))
  if (!(groups instanceof PDFArray)) return references

  for (let index = 0; index < groups.size(); index += 1) {
    const reference = groups.get(index)
    const group = document.context.lookup(reference)
    if (!(group instanceof PDFDict) || !isWatermarkName(group.get(PDFName.of('Name')))) continue
    references.add(reference.toString())
  }
  return references
}

const removeWatermarkAnnotations = (page) => {
  const annotations = page.node.Annots()
  if (!(annotations instanceof PDFArray)) return 0

  let removed = 0
  for (let index = annotations.size() - 1; index >= 0; index -= 1) {
    const annotation = page.doc.context.lookup(annotations.get(index))
    if (!(annotation instanceof PDFDict)) continue
    if (annotation.get(PDFName.of('Subtype'))?.toString() !== WATERMARK_SUBTYPE) continue
    annotations.remove(index)
    removed += 1
  }
  return removed
}

const removeWatermarkContentSections = (page, watermarkOcgRefs) => {
  page.node.normalize()
  const contents = page.node.Contents()
  if (!(contents instanceof PDFArray)) return emptyContentRemovalResult()
  const resourceNames = collectWatermarkResourceNames(page, watermarkOcgRefs)

  const summary = emptyContentRemovalResult()
  for (let index = 0; index < contents.size(); index += 1) {
    const stream = page.doc.context.lookup(contents.get(index))
    if (!(stream instanceof PDFRawStream)) continue

    let decoded
    try {
      decoded = decodePDFRawStream(stream).decode()
    } catch {
      continue
    }

    const result = removeWatermarkMarkedContent(decoded, resourceNames)
    if (!result.removedCount) continue
    const replacement = page.doc.context.flateStream(result.data)
    contents.set(index, page.doc.context.register(replacement))
    summary.removedMarkedContent += result.removedMarkedContent
    summary.removedOptionalContentSections += result.removedOptionalContentSections
    summary.removedXObjectInvocations += result.removedXObjectInvocations
    summary.removedCount += result.removedCount
  }
  return summary
}

const emptyContentRemovalResult = () => ({
  removedMarkedContent: 0,
  removedOptionalContentSections: 0,
  removedXObjectInvocations: 0,
  removedCount: 0,
})

const collectWatermarkResourceNames = (page, watermarkOcgRefs) => {
  const propertyNames = new Set()
  const xObjectNames = new Set()
  if (!watermarkOcgRefs.size) return { propertyNames, xObjectNames }
  const resources = page.node.Resources()
  if (!(resources instanceof PDFDict)) return { propertyNames, xObjectNames }

  collectMatchingResourceNames(
    page.doc.context,
    resources.get(PDFName.of('Properties')),
    watermarkOcgRefs,
    propertyNames,
  )
  collectMatchingResourceNames(
    page.doc.context,
    resources.get(PDFName.of('XObject')),
    watermarkOcgRefs,
    xObjectNames,
    true,
  )
  return { propertyNames, xObjectNames }
}

const collectMatchingResourceNames = (
  context,
  resourceDictionary,
  watermarkOcgRefs,
  output,
  readOptionalContentEntry = false,
) => {
  const dictionary = context.lookup(resourceDictionary)
  if (!(dictionary instanceof PDFDict)) return
  dictionary.entries().forEach(([name, rawValue]) => {
    const candidate = readOptionalContentEntry
      ? context.lookup(rawValue)?.dict?.get(PDFName.of('OC'))
      : rawValue
    if (isWatermarkOcg(candidate, context, watermarkOcgRefs)) output.add(name.toString())
  })
}

const isWatermarkOcg = (candidate, context, watermarkOcgRefs) => {
  if (!candidate) return false
  if (watermarkOcgRefs.has(candidate.toString())) return true
  const group = context.lookup(candidate)
  if (!(group instanceof PDFDict)) return false
  if (isWatermarkName(group.get(PDFName.of('Name')))) return true
  const nestedGroup = group.get(PDFName.of('OC'))
  if (!nestedGroup) return false
  if (watermarkOcgRefs.has(nestedGroup.toString())) return true
  const nestedDictionary = context.lookup(nestedGroup)
  return (
    nestedDictionary instanceof PDFDict &&
    isWatermarkName(nestedDictionary.get(PDFName.of('Name')))
  )
}

const isWatermarkName = (value) => {
  const decoded = typeof value?.decodeText === 'function' ? value.decodeText() : value?.toString()
  return WATERMARK_OCG_NAME_PATTERN.test(String(decoded || ''))
}

export const removeWatermarkMarkedContent = (
  bytes,
  { propertyNames = new Set(), xObjectNames = new Set(), removeStructured = true } = {},
) => {
  const tokens = tokenizePdfContent(bytes)
  const ranges = []
  const summary = emptyContentRemovalResult()

  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value === 'Do' && xObjectNames.has(tokens[index - 1]?.value)) {
      ranges.push({ start: tokens[index - 1].start, end: tokens[index].end })
      summary.removedXObjectInvocations += 1
      continue
    }
    if (!removeStructured || tokens[index].value !== 'BDC') continue
    const section = getWatermarkSection(tokens, index, propertyNames)
    if (!section) continue

    let depth = 1
    for (let endIndex = index + 1; endIndex < tokens.length; endIndex += 1) {
      const operator = tokens[endIndex].value
      if (operator === 'BDC' || operator === 'BMC') depth += 1
      if (operator !== 'EMC') continue
      depth -= 1
      if (depth !== 0) continue
      ranges.push({ start: section.start, end: tokens[endIndex].end })
      summary[section.summaryKey] += 1
      index = endIndex
      break
    }
  }

  summary.removedCount = ranges.length
  if (!ranges.length) return { data: bytes, ...summary }
  return { data: removeByteRanges(bytes, ranges), ...summary }
}

const normalizeAdvancedOptions = (options) => {
  const scanLevel = WATERMARK_SCAN_PRESETS[options.scanLevel] ? options.scanLevel : 'standard'
  const preset = WATERMARK_SCAN_PRESETS[scanLevel]
  return {
    scanLevel,
    keywords: String(options.keywords || preset.keywords)
      .split(/[,，\n]/u)
      .map((keyword) => keyword.trim())
      .filter(Boolean)
      .slice(0, 30),
    frequencyThreshold: clampNumber(
      options.frequencyThreshold,
      0.2,
      1,
      preset.frequencyThreshold,
    ),
    largeTextThreshold: clampNumber(
      options.largeTextThreshold,
      24,
      288,
      preset.largeTextThreshold,
    ),
  }
}

const clampNumber = (value, minimum, maximum, fallback) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(maximum, Math.max(minimum, number))
}

const dictionaryContainsKeyword = (dictionary, keywords) => {
  return ['Contents', 'NM', 'Name', 'T', 'Subj'].some((key) => {
    const value = dictionary.get(PDFName.of(key))
    const decoded = typeof value?.decodeText === 'function' ? value.decodeText() : value?.toString()
    return textContainsKeyword(String(decoded || ''), keywords)
  })
}

const textContainsKeyword = (text, keywords) => {
  const normalized = String(text || '').toLocaleLowerCase()
  return keywords.some((keyword) => normalized.includes(keyword.toLocaleLowerCase()))
}

const collectPageXObjectCandidates = ({
  page,
  pageNumber,
  resources,
  watermarkOcgRefs,
  keywords,
  output,
}) => {
  if (!(resources instanceof PDFDict)) return
  const dictionary = page.doc.context.lookup(resources.get(PDFName.of('XObject')))
  if (!(dictionary instanceof PDFDict)) return
  dictionary.entries().forEach(([name, rawValue]) => {
    const object = page.doc.context.lookup(rawValue)
    if (!(object instanceof PDFRawStream)) return
    if (isWatermarkOcg(object.dict.get(PDFName.of('OC')), page.doc.context, watermarkOcgRefs)) return
    const subtype = object.dict.get(PDFName.of('Subtype'))?.toString()
    if (!['/Image', '/Form'].includes(subtype)) return
    const target = rawValue.toString()
    const id = `xobject:${target}`
    const resourceName = decodePdfName(name)
    const objectName = object.dict.get(PDFName.of('Name'))
    const keywordMatched =
      textContainsKeyword(resourceName, keywords) ||
      textContainsKeyword(
        typeof objectName?.decodeText === 'function' ? objectName.decodeText() : objectName?.toString(),
        keywords,
      )
    const candidate = output.get(id) || {
      id,
      type: subtype === '/Image' ? 'image' : 'form',
      resourceName,
      keywordMatched: false,
      pages: new Set(),
      occurrenceCount: 0,
    }
    candidate.keywordMatched ||= keywordMatched
    candidate.pages.add(pageNumber)
    candidate.occurrenceCount += 1
    output.set(id, candidate)
  })
}

const decodePdfName = (name) => {
  const value = typeof name?.decodeText === 'function' ? name.decodeText() : name?.toString()
  return String(value || '').replace(/^\//u, '')
}

const collectTextBlockCandidates = (
  bytes,
  { pageNumber, streamIndex, keywords, largeTextThreshold, output },
) => {
  getTextBlocks(bytes).forEach((block, blockIndex) => {
    const keywordMatched = containsKeywordBytes(bytes.subarray(block.start, block.end), keywords)
    const largeTextMatched = block.maxFontSize >= largeTextThreshold
    if (!keywordMatched && !largeTextMatched) return
    const hasMultipleEvidence = keywordMatched && largeTextMatched
    output.push({
      id: `text:${pageNumber}:${streamIndex}:${blockIndex}`,
      type: 'text',
      reason: hasMultipleEvidence ? 'multiple' : keywordMatched ? 'keyword' : 'large-text',
      confidence: hasMultipleEvidence ? 'medium' : 'low',
      selectedByDefault: false,
      pages: [pageNumber],
      occurrenceCount: 1,
      resourceName: '',
      fontSize: block.maxFontSize || undefined,
    })
  })
}

const getTextBlocks = (bytes) => {
  const tokens = tokenizePdfContent(bytes)
  const blocks = []
  let startToken = null
  let maxFontSize = 0
  tokens.forEach((token, index) => {
    if (token.value === 'BT' && !startToken) {
      startToken = token
      maxFontSize = 0
      return
    }
    if (!startToken) return
    if (token.value === 'Tf') {
      const size = Number(tokens[index - 1]?.value)
      if (Number.isFinite(size)) maxFontSize = Math.max(maxFontSize, size)
    }
    if (token.value !== 'ET') return
    blocks.push({ start: startToken.start, end: token.end, maxFontSize })
    startToken = null
    maxFontSize = 0
  })
  return blocks
}

const containsKeywordBytes = (bytes, keywords) => {
  const latin = asciiToken(bytes, 0, bytes.length).toLocaleLowerCase()
  return keywords.some((keyword) => {
    const normalized = keyword.toLocaleLowerCase()
    if (latin.includes(normalized)) return true
    const utf16 = [...normalized].flatMap((character) => {
      const code = character.charCodeAt(0)
      return [code >> 8, code & 0xff]
    })
    return includesByteSequence(bytes, utf16)
  })
}

const includesByteSequence = (bytes, sequence) => {
  if (!sequence.length || sequence.length > bytes.length) return false
  outer: for (let index = 0; index <= bytes.length - sequence.length; index += 1) {
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (bytes[index + offset] !== sequence[offset]) continue outer
    }
    return true
  }
  return false
}

const removeSelectedTextBlocks = (bytes, pageNumber, streamIndex, selectedIds) => {
  const ranges = []
  getTextBlocks(bytes).forEach((block, blockIndex) => {
    if (selectedIds.has(`text:${pageNumber}:${streamIndex}:${blockIndex}`)) ranges.push(block)
  })
  return {
    data: ranges.length ? removeByteRanges(bytes, ranges) : bytes,
    removedCount: ranges.length,
  }
}

const collectSelectedXObjectResourceNames = (page, selectedRefs) => {
  const names = new Set()
  if (!selectedRefs.size) return names
  const resources = page.node.Resources()
  if (!(resources instanceof PDFDict)) return names
  const dictionary = page.doc.context.lookup(resources.get(PDFName.of('XObject')))
  if (!(dictionary instanceof PDFDict)) return names
  dictionary.entries().forEach(([name, rawValue]) => {
    if (selectedRefs.has(rawValue.toString())) names.add(name.toString())
  })
  return names
}

const compareCandidates = (left, right) => {
  const confidenceOrder = { high: 0, medium: 1, low: 2 }
  return (
    confidenceOrder[left.confidence] - confidenceOrder[right.confidence] ||
    left.pages[0] - right.pages[0]
  )
}

const getWatermarkSection = (tokens, bdcIndex, propertyNames) => {
  if (
    tokens[bdcIndex - 2]?.value === '/OC' &&
    propertyNames.has(tokens[bdcIndex - 1]?.value)
  ) {
    return {
      start: tokens[bdcIndex - 2].start,
      summaryKey: 'removedOptionalContentSections',
    }
  }

  const dictionaryEndIndex = bdcIndex - 1
  if (tokens[dictionaryEndIndex]?.value !== '>>') return null

  let depth = 1
  let dictionaryStartIndex = dictionaryEndIndex - 1
  for (; dictionaryStartIndex >= 0; dictionaryStartIndex -= 1) {
    const value = tokens[dictionaryStartIndex].value
    if (value === '>>') depth += 1
    if (value === '<<') depth -= 1
    if (depth === 0) break
  }
  if (depth !== 0 || tokens[dictionaryStartIndex - 1]?.value !== '/Artifact') return null

  const dictionaryTokens = tokens.slice(dictionaryStartIndex + 1, dictionaryEndIndex)
  const subtypeIndex = dictionaryTokens.findIndex((token) => token.value === '/Subtype')
  if (dictionaryTokens[subtypeIndex + 1]?.value !== WATERMARK_SUBTYPE) return null
  return {
    start: tokens[dictionaryStartIndex - 1].start,
    summaryKey: 'removedMarkedContent',
  }
}

const tokenizePdfContent = (bytes) => {
  const tokens = []
  let index = 0
  let insideInlineImage = false

  while (index < bytes.length) {
    const byte = bytes[index]
    if (PDF_WHITESPACE.has(byte)) {
      index += 1
      continue
    }
    if (byte === 0x25) {
      index = skipComment(bytes, index + 1)
      continue
    }
    if (byte === 0x28) {
      index = skipLiteralString(bytes, index + 1)
      continue
    }
    if (byte === 0x3c && bytes[index + 1] !== 0x3c) {
      index = skipHexString(bytes, index + 1)
      continue
    }
    if ((byte === 0x3c || byte === 0x3e) && bytes[index + 1] === byte) {
      tokens.push({ value: byte === 0x3c ? '<<' : '>>', start: index, end: index + 2 })
      index += 2
      continue
    }

    const start = index
    if (byte === 0x2f) index += 1
    while (
      index < bytes.length &&
      !PDF_WHITESPACE.has(bytes[index]) &&
      !PDF_DELIMITERS.has(bytes[index])
    ) {
      index += 1
    }
    if (index === start) index += 1
    const value = asciiToken(bytes, start, index)
    tokens.push({ value, start, end: index })
    if (value === 'BI') insideInlineImage = true
    if (value === 'ID' && insideInlineImage) {
      index = skipInlineImageData(bytes, index)
      insideInlineImage = false
    }
  }
  return tokens
}

const skipComment = (bytes, start) => {
  let index = start
  while (index < bytes.length && bytes[index] !== 0x0a && bytes[index] !== 0x0d) index += 1
  return index
}

const skipLiteralString = (bytes, start) => {
  let depth = 1
  let index = start
  while (index < bytes.length && depth > 0) {
    if (bytes[index] === 0x5c) {
      index += 2
      continue
    }
    if (bytes[index] === 0x28) depth += 1
    if (bytes[index] === 0x29) depth -= 1
    index += 1
  }
  return index
}

const skipHexString = (bytes, start) => {
  let index = start
  while (index < bytes.length && bytes[index] !== 0x3e) index += 1
  return Math.min(bytes.length, index + 1)
}

const skipInlineImageData = (bytes, start) => {
  let index = start
  if (PDF_WHITESPACE.has(bytes[index])) index += 1
  while (index + 2 < bytes.length) {
    if (
      PDF_WHITESPACE.has(bytes[index - 1]) &&
      bytes[index] === 0x45 &&
      bytes[index + 1] === 0x49 &&
      PDF_WHITESPACE.has(bytes[index + 2])
    ) {
      return index + 2
    }
    index += 1
  }
  return bytes.length
}

const asciiToken = (bytes, start, end) => {
  let value = ''
  for (let index = start; index < end; index += 1) value += String.fromCharCode(bytes[index])
  return value
}

const removeByteRanges = (bytes, ranges) => {
  const outputLength = ranges.reduce((length, range) => length - (range.end - range.start), bytes.length)
  const output = new Uint8Array(outputLength)
  let sourceOffset = 0
  let outputOffset = 0
  ranges.forEach((range) => {
    output.set(bytes.subarray(sourceOffset, range.start), outputOffset)
    outputOffset += range.start - sourceOffset
    sourceOffset = range.end
  })
  output.set(bytes.subarray(sourceOffset), outputOffset)
  return output
}

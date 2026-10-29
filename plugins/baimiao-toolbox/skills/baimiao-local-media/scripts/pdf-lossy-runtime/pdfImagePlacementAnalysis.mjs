import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
} from '../../assets/pdf-lib/pdf-lib.mjs'

const IMAGE_SUBTYPE = PDFName.of('Image')
const FORM_SUBTYPE = PDFName.of('Form')
const IDENTITY_MATRIX = Object.freeze([1, 0, 0, 1, 0, 0])
const MAX_FORM_DEPTH = 20
const MAX_TOKENS = 100_000
const NAME = {
  contents: PDFName.of('Contents'),
  matrix: PDFName.of('Matrix'),
  resources: PDFName.of('Resources'),
  subtype: PDFName.of('Subtype'),
  userUnit: PDFName.of('UserUnit'),
  xObject: PDFName.of('XObject'),
}

export const analyzePdfImagePlacements = (pdf) => {
  const placements = new Map()
  for (const page of pdf.getPages()) {
    const resources = page.node.Resources()
    const contentValue = page.node.get(NAME.contents)
    if (!contentValue) continue
    const content = readContentBytes(contentValue, pdf.context)
    if (!content) return new Map()
    const userUnit = readPageUserUnit(page.node, pdf.context)
    const reliable = scanContent(
      content,
      resources,
      pdf.context,
      [userUnit, 0, 0, userUnit, 0, 0],
      placements,
      new Set(),
      0,
    )
    if (!reliable) return new Map()
  }
  return placements
}

const scanContent = (bytes, resources, context, initialMatrix, placements, formPath, depth) => {
  if (depth > MAX_FORM_DEPTH) return false
  const operations = parsePlacementOperations(bytes)
  if (!operations) return false

  let matrix = initialMatrix
  const stack = []
  for (const operation of operations) {
    if (operation.name === 'q') {
      stack.push(matrix)
      continue
    }
    if (operation.name === 'Q') {
      matrix = stack.pop() || initialMatrix
      continue
    }
    if (operation.name === 'cm') {
      matrix = multiplyMatrices(matrix, operation.args)
      continue
    }
    if (operation.name !== 'Do') continue

    const xObjects = resources.lookupMaybe(NAME.xObject, PDFDict)
    if (!(xObjects instanceof PDFDict)) return false
    const entry = findXObjectEntry(xObjects, operation.resourceName)
    if (!entry) return false
    const [value] = entry
    const object = context.lookup(value)
    if (!(object instanceof PDFRawStream || object instanceof PDFStream)) return false
    const subtype = object.dict.lookupMaybe(NAME.subtype, PDFName)
    const refKey = value instanceof PDFRef ? value.toString() : ''

    if (subtype === IMAGE_SUBTYPE && refKey) {
      recordPlacement(placements, refKey, matrix)
      continue
    }
    if (subtype !== FORM_SUBTYPE) continue
    if (!refKey || formPath.has(refKey)) return false

    const formContent = readStreamBytes(object)
    if (!formContent) return false
    const formResources = object.dict.lookupMaybe(NAME.resources, PDFDict) || resources
    const formMatrix = readMatrix(object.dict.lookup(NAME.matrix))
    const nextPath = new Set(formPath)
    nextPath.add(refKey)
    if (
      !scanContent(
        formContent,
        formResources,
        context,
        multiplyMatrices(matrix, formMatrix),
        placements,
        nextPath,
        depth + 1,
      )
    ) {
      return false
    }
  }
  return true
}

const recordPlacement = (placements, refKey, matrix) => {
  const widthPoints = Math.hypot(matrix[0], matrix[1])
  const heightPoints = Math.hypot(matrix[2], matrix[3])
  if (!(widthPoints > 0 && heightPoints > 0)) return
  const current = placements.get(refKey) || { widthPoints: 0, heightPoints: 0, uses: 0 }
  current.widthPoints = Math.max(current.widthPoints, widthPoints)
  current.heightPoints = Math.max(current.heightPoints, heightPoints)
  current.uses++
  placements.set(refKey, current)
}

const findXObjectEntry = (xObjects, resourceName) => {
  for (const [name, value] of xObjects.entries()) {
    if (name.decodeText() === resourceName) return [value, name]
  }
  return null
}

const readContentBytes = (value, context) => {
  if (!value) return null
  const resolved = value instanceof PDFRef ? context.lookup(value) : value
  if (resolved instanceof PDFArray) {
    const chunks = []
    for (let index = 0; index < resolved.size(); index++) {
      const chunk = readContentBytes(resolved.get(index), context)
      if (!chunk) return null
      chunks.push(chunk)
    }
    return joinByteChunks(chunks)
  }
  return readStreamBytes(resolved)
}

const readStreamBytes = (stream) => {
  try {
    if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).getBytes()
    if (stream instanceof PDFStream) return stream.getContents()
  } catch {
    return null
  }
  return null
}

const joinByteChunks = (chunks) => {
  if (!chunks.length) return null
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength + 1, 0)
  const output = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength + 1
  }
  return output
}

const readMatrix = (value) => {
  if (!(value instanceof PDFArray) || value.size() !== 6) return IDENTITY_MATRIX
  const matrix = []
  for (let index = 0; index < 6; index++) {
    const number = value.lookupMaybe(index, PDFNumber)?.asNumber?.()
    if (!Number.isFinite(number)) return IDENTITY_MATRIX
    matrix.push(number)
  }
  return matrix
}

const readPageUserUnit = (pageNode, context) => {
  const value = pageNode.getInheritableAttribute?.(NAME.userUnit)
  const number = value instanceof PDFRef ? context.lookup(value, PDFNumber) : value
  const userUnit = number instanceof PDFNumber ? number.asNumber() : 1
  return Number.isFinite(userUnit) && userUnit > 0 ? userUnit : 1
}

const multiplyMatrices = (left, right) => [
  left[0] * right[0] + left[2] * right[1],
  left[1] * right[0] + left[3] * right[1],
  left[0] * right[2] + left[2] * right[3],
  left[1] * right[2] + left[3] * right[3],
  left[0] * right[4] + left[2] * right[5] + left[4],
  left[1] * right[4] + left[3] * right[5] + left[5],
]

const parsePlacementOperations = (bytes) => {
  const source = bytesToLatin1(bytes)
  const operations = []
  const operands = []
  let offset = 0
  let tokenCount = 0
  while (offset < source.length && tokenCount++ < MAX_TOKENS) {
    offset = skipWhitespaceAndComments(source, offset)
    if (offset >= source.length) break
    const char = source[offset]

    if (char === '(') {
      offset = skipLiteralString(source, offset + 1)
      operands.push(null)
      continue
    }
    if (char === '<') {
      if (source[offset + 1] === '<') return null
      offset = skipHexOrDictionary(source, offset)
      operands.push(null)
      continue
    }
    if (char === '[') {
      offset = skipArray(source, offset + 1)
      if (offset < 0) return null
      operands.push(null)
      continue
    }
    if (char === '/') {
      const token = readToken(source, offset + 1)
      operands.push({ type: 'name', value: decodePdfName(token.value) })
      offset = token.offset
      continue
    }
    if (isNumberStart(char)) {
      const token = readToken(source, offset)
      const number = Number(token.value)
      operands.push(Number.isFinite(number) ? number : null)
      offset = token.offset
      continue
    }
    if (isDelimiter(char)) {
      operands.length = 0
      offset++
      continue
    }

    const token = readToken(source, offset)
    offset = token.offset
    if (token.value === 'BI') return null
    if (token.value === 'q' || token.value === 'Q') {
      operations.push({ name: token.value })
    } else if (token.value === 'cm') {
      const args = operands.slice(-6)
      if (args.length === 6 && args.every(Number.isFinite)) operations.push({ name: 'cm', args })
    } else if (token.value === 'Do') {
      const name = operands.at(-1)
      if (name?.type === 'name') operations.push({ name: 'Do', resourceName: name.value })
    }
    operands.length = 0
  }
  return tokenCount >= MAX_TOKENS ? null : operations
}

const skipWhitespaceAndComments = (source, start) => {
  let offset = start
  while (offset < source.length) {
    if (isWhitespace(source[offset])) {
      offset++
      continue
    }
    if (source[offset] === '%') {
      while (offset < source.length && !['\n', '\r'].includes(source[offset])) offset++
      continue
    }
    break
  }
  return offset
}

const skipLiteralString = (source, start) => {
  let depth = 1
  let offset = start
  while (offset < source.length && depth > 0) {
    if (source[offset] === '\\') {
      offset += 2
      continue
    }
    if (source[offset] === '(') depth++
    if (source[offset] === ')') depth--
    offset++
  }
  return offset
}

const skipHexOrDictionary = (source, start) => {
  const end = source.indexOf('>', start + 1)
  return end < 0 ? source.length : end + 1
}

const skipArray = (source, start) => {
  let depth = 1
  let offset = start
  while (offset < source.length && depth > 0) {
    if (source[offset] === '(') {
      offset = skipLiteralString(source, offset + 1)
      continue
    }
    if (source[offset] === '<') {
      if (source[offset + 1] === '<') return -1
      offset = skipHexOrDictionary(source, offset)
      continue
    }
    if (source[offset] === '[') depth++
    if (source[offset] === ']') depth--
    offset++
  }
  return depth === 0 ? offset : -1
}

const readToken = (source, start) => {
  let offset = start
  while (offset < source.length && !isWhitespace(source[offset]) && !isDelimiter(source[offset])) {
    offset++
  }
  return { value: source.slice(start, offset), offset }
}

const decodePdfName = (value) =>
  value.replace(/#([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
const isNumberStart = (char) => /[+\-.0-9]/.test(char)
const isWhitespace = (char) => /[\0\t\n\f\r ]/.test(char)
const isDelimiter = (char) => /[()[\]{}<>/%]/.test(char)

const bytesToLatin1 = (bytes) => {
  let result = ''
  const chunkSize = 8192
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return result
}

import { PDFArray, PDFName, PDFStream, PDFRawStream } from '../../assets/pdf-lib/pdf-lib.mjs'

// Bare JPEG 2000 codestreams are legal, but the corpus contains one whose
// appearance changes in Poppler after a structural rewrite. Until that path
// can be validated, preserve the entire original, including unrelated objects.
// Inspect all streams, including masks and annotation appearances.
export const getPdfCompressionRisk = (pdf) => {
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream || object instanceof PDFStream)) continue
    const filter = object.dict.lookup(PDFName.of('Filter'))
    const filters = filter instanceof PDFArray ? filter.asArray() : [filter]
    if (!filters.some((name) => name?.toString() === '/JPXDecode')) continue
    const bytes = object.getContents()
    const jp2Signature = [0, 0, 0, 12, 106, 80, 32, 32, 13, 10, 135, 10]
    if (filters.length !== 1 || !jp2Signature.every((byte, index) => bytes[index] === byte)) {
      return 'JPX_COMPATIBILITY'
    }
  }
  return ''
}

export const originalCompressionResult = (file, extra = {}) => {
  const data = file instanceof Uint8Array ? file : new Uint8Array(file)
  return {
    name: 'compressed.pdf',
    data,
    originalSize: data.byteLength,
    outputSize: data.byteLength,
    compressedImages: 0,
    skippedImages: 0,
    optimizedByQpdf: false,
    notEffective: true,
    backend: 'original',
    ...extra,
  }
}

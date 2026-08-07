import path from 'node:path'

const CONVERSION_EXTENSIONS = new Set(['.heic', '.heif', '.tif', '.tiff'])

export const createOcrInputPreparer = ({ convert = defaultConvert } = {}) => async (input) => {
  const extension = path.extname(input.path).toLowerCase()
  if (!CONVERSION_EXTENSIONS.has(extension)) return input
  let converted
  try {
    converted = Buffer.from(await convert(input.path))
  } catch {
    throw publicError('IMAGE_CONVERSION_FAILED', 'The OCR input could not be converted to JPEG locally.')
  }
  if (converted.length < 4 || converted[0] !== 0xff || converted[1] !== 0xd8) {
    throw publicError('IMAGE_CONVERSION_FAILED', 'The OCR input could not be converted to JPEG locally.')
  }
  return { ...input, name: `${path.basename(input.name, extension)}.jpg`, size: converted.length, mimeType: 'image/jpeg', data: converted }
}

async function defaultConvert(inputPath) {
  const { convertImageForOcr } = await import('./media-node-adapter.mjs')
  return convertImageForOcr(inputPath)
}

function publicError(code, message) { return Object.assign(new Error(message), { code, publicMessage: message }) }

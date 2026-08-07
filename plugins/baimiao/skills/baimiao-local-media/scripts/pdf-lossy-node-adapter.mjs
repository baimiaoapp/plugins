import { CliError } from './cli-options.mjs'
import { createImageCodecNodeAdapter } from './image-codec-node-adapter.mjs'
import { createQpdfNodeAdapter } from './qpdf-node-adapter.mjs'
import { runPdfImageCompressionPipeline } from './pdf-lossy-runtime/pdfImageCompression.mjs'

const PRESETS = Object.freeze({
  small: Object.freeze({ jpegQuality: 0.6, maxImageDimension: 960 }),
  standard: Object.freeze({ jpegQuality: 0.7, maxImageDimension: 1280 }),
  clear: Object.freeze({ jpegQuality: 0.8, maxImageDimension: 1600 }),
})

export const compressPdfImages = async (data, plan = {}) => {
  const presetName = plan.preset || 'standard'
  const preset = PRESETS[presetName]
  if (!preset) throw new CliError('INVALID_PLAN', 'preset must be small, standard, or clear.')
  const options = {
    ...preset,
    minSavingsBytes: 4096,
    mode: 'image-xobject',
    keepTransparencyPng: plan.flattenTransparency !== true,
    grayscale: Boolean(plan.grayscale),
  }
  if (plan.maxImageDimension !== undefined) {
    const value = Number(plan.maxImageDimension)
    if (!Number.isSafeInteger(value) || value < 240 || value > 2400) {
      throw new CliError('INVALID_PLAN', 'maxImageDimension must be an integer from 240 to 2400.')
    }
    options.maxImageDimension = value
  }
  if (plan.jpegQuality !== undefined) {
    const value = Number(plan.jpegQuality)
    if (!Number.isFinite(value) || value < 0.1 || value > 0.95) {
      throw new CliError('INVALID_PLAN', 'jpegQuality must be from 0.1 to 0.95.')
    }
    options.jpegQuality = value
  }

  let qpdfPromise
  const [result] = await runPdfImageCompressionPipeline(data, options, {
    createCodecAdapter: createImageCodecNodeAdapter,
    optimizeOutput: async (output) => {
      qpdfPromise ||= createQpdfNodeAdapter()
      const qpdf = await qpdfPromise
      return qpdf.optimize(output)[0]
    },
    now: () => performance.now(),
  })
  return {
    data: result.data,
    backend: result.backend || 'image-codec.wasm+qpdf.wasm',
    metadata: {
      compressedImages: result.compressedImages,
      skippedImages: result.skippedImages,
      notEffective: result.notEffective,
      documentType: result.documentType,
      preset: presetName,
    },
  }
}

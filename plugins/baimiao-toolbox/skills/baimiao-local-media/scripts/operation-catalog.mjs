const definitions = [
  define('merge', 'pdf', '/pdf-merge', 'qpdf', ['output'], ['output'], 2, Infinity, true),
  define('split', 'pdf', '/pdf-split', 'qpdf', ['ranges', 'outputDir'], ['ranges', 'outputDir']),
  define('extract', 'pdf', '/pdf-extract', 'qpdf', ['pages', 'output'], ['pages', 'output']),
  define('optimize', 'pdf', '/pdf-optimize', 'qpdf', ['output'], ['output']),
  define('rotate', 'pdf', '/pdf-rotate', 'qpdf', ['pages', 'angle', 'output'], ['pages', 'angle', 'output']),
  define('delete', 'pdf', '/pdf-delete-pages', 'qpdf', ['pages', 'output'], ['pages', 'output']),
  define('reorder', 'pdf', '/pdf-reorder', 'qpdf', ['order', 'output'], ['order', 'output']),
  define('reorder-plan', 'pdf', '/pdf-reorder', 'pdf-lib', ['plan', 'output'], ['plan', 'output']),
  define('page-numbers', 'pdf', '/pdf-page-numbers', 'pdf-lib', ['pages', 'plan', 'output'], ['output']),
  define('metadata-cleanup', 'pdf', '/pdf-metadata-cleanup', 'pdf-lib', ['output'], ['output']),
  define('images-to-pdf', 'pdf', '/images-to-pdf', 'pdf-lib', ['plan', 'output'], ['output'], 1, Infinity, false, 'image'),
  define('encrypt', 'pdf', '/pdf-encrypt', 'qpdf', ['output'], ['output']),
  define('decrypt', 'pdf', '/pdf-remove-password', 'qpdf', ['output'], ['output']),
  define('check', 'pdf', '/pdf-tools', 'qpdf', [], []),
  define('repair', 'pdf', '/pdf-tools', 'qpdf', ['output'], ['output']),
  define('linearize', 'pdf', '/pdf-optimize', 'qpdf', ['output'], ['output']),
  define('watermark', 'pdf', '/pdf-watermark', 'pdf-lib', ['plan', 'output'], ['plan', 'output']),
  define('pdf-to-images', 'pdf', '/pdf-to-images', 'media', ['plan', 'outputDir'], ['outputDir']),
  define('compress-lossy', 'pdf', '/pdf-compress', 'media', ['plan', 'output'], ['output']),
  define('image-convert', 'image', '/image-converter', 'media', ['plan', 'outputDir'], ['outputDir'], 1, Infinity, true, 'image'),
  define('heic-convert', 'image', '/heic-converter', 'media', ['plan', 'outputDir'], ['outputDir'], 1, Infinity, true, 'image'),
  define('image-compress', 'image', '/image-compress', 'media', ['plan', 'outputDir'], ['outputDir'], 1, Infinity, true, 'image'),
  define('image-resize', 'image', '/image-resize', 'media', ['plan', 'outputDir'], ['outputDir'], 1, Infinity, true, 'image'),
  define('image-crop', 'image', '/image-crop', 'media', ['plan', 'outputDir'], ['outputDir'], 1, Infinity, true, 'image'),
  define('image-privacy-mask', 'image', '/image-privacy-mask', 'media', ['plan', 'outputDir'], ['outputDir'], 1, Infinity, true, 'image'),
  define('image-watermark', 'image', '/image-watermark', 'media', ['plan', 'outputDir'], ['outputDir'], 1, Infinity, true, 'image'),
  define('image-border-radius', 'image', '/image-border-radius', 'media', ['plan', 'outputDir'], ['outputDir'], 1, Infinity, true, 'image'),
  define('image-rotate-flip', 'image', '/image-rotate-flip', 'media', ['plan', 'outputDir'], ['outputDir'], 1, Infinity, true, 'image'),
  define('image-rembg', 'image', '/image-rembg', 'media', ['plan', 'outputDir'], ['outputDir'], 1, Infinity, true, 'image'),
  define('image-to-gif', 'image', '/image-to-gif', 'media', ['plan', 'output'], ['output'], 1, Infinity, true, 'image'),
  define('video-to-gif', 'image', '/video-to-gif', 'media', ['plan', 'output'], ['output'], 1, 1, true, 'video'),
  define('gif-to-images', 'image', '/gif-to-images', 'media', ['plan', 'outputDir'], ['outputDir'], 1, 1, true, 'gif'),
]

export const LOCAL_OPERATION_CATALOG = Object.freeze(definitions)
const LOCAL_OPERATION_BY_NAME = new Map(definitions.map((definition) => [definition.name, definition]))
export const LOCAL_OPERATION_NAMES = Object.freeze(definitions.map(({ name }) => name))
export const QPDF_OPERATION_NAMES = Object.freeze(definitions.filter(({ backend }) => backend === 'qpdf').map(({ name }) => name))
export const MEDIA_OPERATION_NAMES = Object.freeze(definitions.filter(({ backend }) => backend === 'media').map(({ name }) => name))
export const IMAGE_OPERATION_NAMES = Object.freeze(definitions
  .filter(({ backend, inputKind }) => backend === 'media' && inputKind === 'image')
  .map(({ name }) => name))

export const getLocalOperation = (name) => LOCAL_OPERATION_BY_NAME.get(name)

for (const definition of definitions) validateDefinition(definition)

function define(
  name,
  category,
  route,
  backend,
  allowedOptions,
  requiredOptions,
  minInputs = 1,
  maxInputs = 1,
  uniqueInputs = true,
  inputKind = 'pdf',
) {
  const plan = allowedOptions.includes('plan')
    ? (requiredOptions.includes('plan') ? 'required' : 'optional')
    : 'forbidden'
  const output = allowedOptions.includes('outputDir')
    ? 'directory'
    : allowedOptions.includes('output') ? 'file' : 'none'
  return Object.freeze({
    name,
    category,
    route,
    backend,
    allowedOptions: Object.freeze(allowedOptions),
    requiredOptions: Object.freeze(requiredOptions),
    minInputs,
    maxInputs,
    uniqueInputs,
    inputKind,
    plan,
    output,
  })
}

function validateDefinition(definition) {
  if (definition.requiredOptions.some((name) => !definition.allowedOptions.includes(name))) {
    throw new Error(`Operation ${definition.name} requires an option that is not allowed.`)
  }
  if (definition.minInputs < 1 || definition.maxInputs < definition.minInputs) {
    throw new Error(`Operation ${definition.name} has invalid input cardinality.`)
  }
  if (!['qpdf', 'pdf-lib', 'media'].includes(definition.backend)) {
    throw new Error(`Operation ${definition.name} has an unknown backend.`)
  }
}

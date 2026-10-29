import { EXTENDED_RUNTIME_ASSETS } from './extended-runtime-assets.mjs'
export const RUNTIME_CACHE_VERSION = 'v1'

export const RUNTIME_ASSETS = Object.freeze({
  ...EXTENDED_RUNTIME_ASSETS,
  'magick.mjs': asset(
    276851,
    '296b2de0fdabc3a32e4bd1a8c19a0630e6704899577de8c44acbde7ac4b908d8',
    {
      international: 'https://cdn.jsdelivr.net/npm/@imagemagick/magick-wasm@0.0.42/dist/index.js',
      china: 'https://cdn.jsdmirror.com/npm/@imagemagick/magick-wasm@0.0.42/dist/index.js',
    },
  ),
  'magick.wasm': asset(
    14687945,
    'c903248c3b66a550b74bac5ea25d359e84455b8d82aa945a16f75f6fd8be610a',
    {
      international: 'https://cdn.jsdelivr.net/npm/@imagemagick/magick-wasm@0.0.42/dist/magick.wasm',
      china: 'https://cdn.jsdmirror.com/npm/@imagemagick/magick-wasm@0.0.42/dist/magick.wasm',
    },
  ),
  'pdfium.mjs': asset(
    298046,
    '8d9e5fd803c4fe2a1dfa60dfe871baabb88b1b1f8214b283134cff62e27693c7',
    mirrors('https://cdn.jsdelivr.net/npm/@embedpdf/pdfium@2.14.4/dist/index.js', 'https://cdn.jsdmirror.com/npm/@embedpdf/pdfium@2.14.4/dist/index.js'),
  ),
  'pdfium.wasm': asset(
    4633788,
    'c0af5a6aca30d7e54a149c3a68e317116ca906d6edc28fd3318b12c7d9478ac8',
    mirrors('https://cdn.jsdelivr.net/npm/@embedpdf/pdfium@2.14.4/dist/pdfium.wasm', 'https://cdn.jsdmirror.com/npm/@embedpdf/pdfium@2.14.4/dist/pdfium.wasm'),
  ),
  'ffmpeg-core.mjs': asset(
    111804,
    '67a48f11645f85439f3fde4f2119042c16b374b910206b7a7a24f342e28dcae3',
    mirrors('https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.js', 'https://cdn.jsdmirror.com/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.js'),
  ),
  'ffmpeg-core.wasm': asset(
    32232419,
    '9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7',
    mirrors('https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.wasm', 'https://cdn.jsdmirror.com/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.wasm'),
  ),
  'ort.wasm.mjs': asset(
    50069,
    'b5974e68e7974bbadf4f6aab6539ea50f74c6fb40a0e8bb95b3b0fa8b7efde75',
    mirrors('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0-dev.20260416-b7804b056c/dist/ort.wasm.min.mjs', 'https://cdn.jsdmirror.com/npm/onnxruntime-web@1.26.0-dev.20260416-b7804b056c/dist/ort.wasm.min.mjs'),
  ),
  'ort-wasm-simd-threaded.mjs': asset(
    24180,
    '5f2cd914554830762579c372d0211614c1e3f40ab3f6c0cfcf0900343229071d',
    mirrors('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0-dev.20260416-b7804b056c/dist/ort-wasm-simd-threaded.mjs', 'https://cdn.jsdmirror.com/npm/onnxruntime-web@1.26.0-dev.20260416-b7804b056c/dist/ort-wasm-simd-threaded.mjs'),
  ),
  'ort-wasm-simd-threaded.wasm': asset(
    12942611,
    'f4f290847a4df02d0b93cdbf39b4b0e71acefbe80573e7e6b9342a7abd7b290a',
    mirrors('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0-dev.20260416-b7804b056c/dist/ort-wasm-simd-threaded.wasm', 'https://cdn.jsdmirror.com/npm/onnxruntime-web@1.26.0-dev.20260416-b7804b056c/dist/ort-wasm-simd-threaded.wasm'),
  ),
  'rmbg-1.4-quantized.onnx': asset(
    44403226,
    'a6648479275dfd0ede0f3a8abc20aa5c437b394681b05e5af6d268250aaf40f3',
    {
      international: 'https://huggingface.co/kittypdf/RMBG-1.4-transformersjs/resolve/2d116050ec1d32554a52c017375e1cea31253b90/onnx/model_quantized.onnx',
      china: 'https://modelscope.cn/models/kittypdf/RMBG-1.4-transformersjs/resolve/main/onnx/model_quantized.onnx',
    },
  ),
  'rmbg-1.4-fp32.onnx': asset(
    176153355,
    '8cafcf770b06757c4eaced21b1a88e57fd2b66de01b8045f35f01535ba742e0f',
    {
      international: 'https://huggingface.co/kittypdf/RMBG-1.4-transformersjs/resolve/2d116050ec1d32554a52c017375e1cea31253b90/onnx/model.onnx',
      china: 'https://modelscope.cn/models/kittypdf/RMBG-1.4-transformersjs/resolve/main/onnx/model.onnx',
    },
  ),
  'NotoSansCJKsc-Regular.otf': asset(
    16437364,
    '2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b',
    mirrors('https://cdn.pdf.baimiaoapp.com/assets/wordcraft-preview/fonts/noto-sans-cjk-sc-2c76254f6fc379fd.otf', 'https://cdn.pdf.baimiaoapp.com/assets/wordcraft-preview/fonts/noto-sans-cjk-sc-2c76254f6fc379fd.otf'),
  ),
})

export const RUNTIME_BUNDLES = Object.freeze({
  office: Object.freeze(Object.keys(EXTENDED_RUNTIME_ASSETS).filter(name => /^(wordcraft|deckcraft)-preview/.test(name))),
  scan: Object.freeze(['docaligner-lcnet100.onnx']),
  'smart-cutout': Object.freeze(['slimsam-encoder.onnx', 'slimsam-decoder.onnx']),
  'upscale-photo': Object.freeze(['upscale-photo.onnx']),
  'upscale-anime': Object.freeze(['upscale-anime.onnx']),
  magick: Object.freeze(['magick.mjs', 'magick.wasm']),
  pdfium: Object.freeze(['pdfium.mjs', 'pdfium.wasm']),
  ffmpeg: Object.freeze(['ffmpeg-core.mjs', 'ffmpeg-core.wasm']),
  ort: Object.freeze([
    'ort.wasm.mjs',
    'ort-wasm-simd-threaded.mjs',
    'ort-wasm-simd-threaded.wasm',
  ]),
  rembg: Object.freeze(['rmbg-1.4-fp32.onnx']),
  'rembg-quint8': Object.freeze(['rmbg-1.4-quantized.onnx']),
  font: Object.freeze(['NotoSansCJKsc-Regular.otf']),
})

function mirrors(international, china) {
  return { international, china }
}

function asset(size, sha256, sources) {
  const normalizedSources = typeof sources === 'string'
    ? { international: sources, china: sources }
    : sources
  return Object.freeze({
    size,
    sha256,
    sources: Object.freeze(normalizedSources),
    url: normalizedSources.international,
  })
}

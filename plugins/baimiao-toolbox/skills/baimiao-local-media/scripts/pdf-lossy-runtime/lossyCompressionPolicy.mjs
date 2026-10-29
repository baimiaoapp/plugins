export const LOSSY_COMPRESS_POLICY = Object.freeze({
  defaultPresetName: 'standard',
  minSavingsBytes: 4 * 1024,
  mode: 'image-xobject',
  imageCodecBackend: 'wasm',
  convertPngToJpeg: true,
  keepTransparencyPng: true,
  preserveSharpGraphics: true,
  maxDimensionMax: 2400,
  qualityMax: 0.95,
})

export const LOSSY_COMPRESS_PRESETS = Object.freeze([
  Object.freeze({
    name: 'small',
    maxImageDimension: 960,
    jpegQuality: 0.6,
  }),
  Object.freeze({
    name: 'standard',
    maxImageDimension: 1280,
    jpegQuality: 0.7,
  }),
  Object.freeze({
    name: 'clear',
    maxImageDimension: 1600,
    jpegQuality: 0.8,
  }),
])

export const LOSSY_COMPRESS_PRESETS_BY_NAME = Object.freeze(
  Object.fromEntries(LOSSY_COMPRESS_PRESETS.map((preset) => [preset.name, preset])),
)

export const getLossyCompressPreset = (name = LOSSY_COMPRESS_POLICY.defaultPresetName) => {
  return (
    LOSSY_COMPRESS_PRESETS_BY_NAME[name] ||
    LOSSY_COMPRESS_PRESETS_BY_NAME[LOSSY_COMPRESS_POLICY.defaultPresetName]
  )
}

export const createLossyCompressOptions = (presetOrName, overrides = {}) => {
  const preset =
    typeof presetOrName === 'string' ? getLossyCompressPreset(presetOrName) : presetOrName
  const resolvedPreset = preset || getLossyCompressPreset()
  return {
    preset: resolvedPreset.name,
    contentAware: false,
    minSavingsRatio: 0,
    maxImageDimension: resolvedPreset.maxImageDimension,
    jpegQuality: resolvedPreset.jpegQuality,
    minSavingsBytes: LOSSY_COMPRESS_POLICY.minSavingsBytes,
    mode: LOSSY_COMPRESS_POLICY.mode,
    imageCodecBackend: LOSSY_COMPRESS_POLICY.imageCodecBackend,
    convertPngToJpeg: LOSSY_COMPRESS_POLICY.convertPngToJpeg,
    keepTransparencyPng: LOSSY_COMPRESS_POLICY.keepTransparencyPng,
    preserveSharpGraphics: LOSSY_COMPRESS_POLICY.preserveSharpGraphics,
    ...overrides,
  }
}

// Automatic target bounds are independent of the historical manual quality path.
export const PDF_TARGET_IMAGE_FLOOR = Object.freeze({
  contentAware: true,
  minSavingsBytes: 256,
  minSavingsRatio: 0.02,
  targetDpi: 96,
  textDpi: 144,
  jpegQuality: 0.55,
  textQuality: 0.72,
})

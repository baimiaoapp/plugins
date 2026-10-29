// Colour controls follow HarmonyOS gpu_scan_engine.cpp COMBINE_FRAGMENT.
// CPU fallback for the same Gaussian and background-normalization pipeline.
import { gaussianScanBlur, normalizeScanBackground } from './documentScanHarmonyPixels.mjs'
const clamp = (v) => Math.max(0, Math.min(1, v))
const smooth = (a, b, v) => {
  const t = clamp((v - a) / (b - a))
  return t * t * (3 - 2 * t)
}
export const DOCUMENT_SCAN_MODES = Object.freeze([
  'original',
  'colour',
  'colourSharp',
  'gray',
  'bw',
  'bwSharp',
])

export function applyDocumentScanFilter(image, mode, { normalizeBackground = false } = {}) {
  if (mode === 'original' || mode === 'natural') return image
  const { data, width, height } = image
  const source = normalizeBackground ? normalizeScanBackground(image) : data.slice()
  const sigma = Math.max(1, (Math.hypot(width, height) * 0.149) / 20)
  const blurred = gaussianScanBlur({ data: source, width, height }, sigma)
  const luminance = (p, weights) => weights.reduce((v, w, c) => v + (source[p + c] / 255) * w, 0)
  const weights = [0.2126, 0.7152, 0.0722]
  const bwWeights = [0.299, 0.587, 0.114]
  for (let p = 0; p < data.length; p += 4) {
    const base = [source[p] / 255, source[p + 1] / 255, source[p + 2] / 255]
    const detail = base.map((v, c) => v - blurred[p + c] / 255)
    let rgb = base.map((v, c) => clamp(v + detail[c] * 0.149))
    if (mode === 'colourSharp') {
      const bright = base.map((v) => v + 0.1)
      const l = bright[0] * 0.2125 + bright[1] * 0.7154 + bright[2] * 0.0721
      rgb = bright.map((v) => l + (v - l) * 1.5)
      const contrast = 1.8 - 0.6 * smooth(0.05, 0.3, Math.max(...rgb) - Math.min(...rgb))
      rgb = rgb.map((v, c) => (v - 0.75) * contrast + 0.75 + detail[c] * 0.8)
    } else if (mode === 'gray' || mode === 'bwSharp') {
      const l = rgb.reduce((v, channel, c) => v + channel * weights[c], 0)
      let gray = clamp((l - 0.5) * 1.1 + 0.58)
      if (mode === 'bwSharp') {
        const blurL = weights.reduce((v, w, c) => v + (blurred[p + c] / 255) * w, 0)
        gray = (gray + (l - blurL) * 2.3 + 0.02 - 0.5) * 1.1 + 0.5
      }
      rgb = [gray, gray, gray]
    } else if (mode === 'bw') {
      const l = rgb.reduce((v, channel, c) => v + channel * bwWeights[c], 0)
      const x = (p / 4) % width,
        y = Math.floor(p / 4 / width)
      const neighbours = [
        x > 0 ? p - 4 : p,
        x + 1 < width ? p + 4 : p,
        y > 0 ? p - width * 4 : p,
        y + 1 < height ? p + width * 4 : p,
      ]
      const minimum = Math.min(l, ...neighbours.map((i) => luminance(i, bwWeights)))
      const gray = smooth(0.25, 0.75, l + (minimum - l) * 0.6) ** 1.1
      rgb = [gray, gray, gray]
    }
    for (let c = 0; c < 3; c++) data[p + c] = Math.round(clamp(rgb[c]) * 255)
  }
  return image
}

import { CliError } from './cli-options.mjs'
import { numberInRange, integerInRange, enumValue } from './media-node-adapter.mjs'
import { compressPdfImages } from './pdf-lossy-node-adapter.mjs'
import { rasterizePdf } from './extended-media.mjs'

export const targetBytesFromPlan = plan => {
  if (plan.targetBytes === undefined) return null
  if (!Number.isSafeInteger(plan.targetBytes) || plan.targetBytes < 1 || plan.targetBytes > 1024 * 1024 * 1024) throw new CliError('INVALID_PLAN', 'targetBytes must be an integer from 1 to 1073741824.')
  return plan.targetBytes
}

// Every trial uses the original input. A missed target is a reported outcome, never a false guarantee.
export const compressPdfWithTarget = async (data, plan) => {
  const mode = enumValue(plan.mode, ['preserve', 'raster'], 'preserve', 'mode')
  const targetBytes = targetBytesFromPlan(plan)
  let attempts = 0, best
  const trial = async options => {
    const result = mode === 'raster'
      ? { data: await rasterizePdf(data, options), backend: 'pdfium.wasm+pdf-lib', metadata: { rasterized: true, searchableText: false } }
      : await compressPdfImages(data, options)
    attempts++
    if (!best || result.data.length < best.data.length) best = result
    return result
  }
  if (!targetBytes) return trial(plan)
  if (data.length <= targetBytes) return { data, backend: 'original', metadata: { targetBytes, targetMet: true, attempts: 0, notEffective: true } }
  let chosen
  if (mode === 'preserve') {
    const upper = numberInRange(plan.jpegQuality, 0.55, 0.95, 0.9, 'jpegQuality')
    // Keep small Chinese text above the website's document-quality and DPI floors.
    for (const [quality, dpi] of [[upper, 180], [Math.min(upper, 0.8), 144], [Math.min(upper, 0.68), 120], [0.55, 96]]) {
      const result = await trial({ ...plan, contentAware: true, jpegQuality: quality, targetDpi: dpi, textDpi: Math.max(144, dpi), textQuality: Math.max(0.72, quality), minSavingsBytes: 256 })
      if (result.data.length <= targetBytes) { chosen = result; break }
    }
  } else {
    const startDpi = integerInRange(plan.dpi, 144, 600, 180, 'dpi')
    const upper = numberInRange(plan.jpegQuality ?? plan.quality, 0.55, 0.95, 0.9, 'quality')
    // Never silently rasterize a preserve-mode request or reduce resolution below 144 DPI.
    for (const dpi of [...new Set([startDpi, Math.max(144, Math.round(startDpi * 0.8)), 144])]) {
      for (const quality of [...new Set([upper, Math.min(upper, 0.75), 0.55])]) {
        const result = await trial({ ...plan, dpi, jpegQuality: quality })
        if (result.data.length <= targetBytes) { chosen = result; break }
      }
      if (chosen) break
    }
  }
  chosen ||= best
  if (chosen.data.length >= data.length) chosen = { data, backend: 'original', metadata: { notEffective: true } }
  chosen.metadata = { ...chosen.metadata, targetBytes, targetMet: chosen.data.length <= targetBytes, attempts }
  return chosen
}

export const encodeImageWithTarget = (magick, image, format, plan) => {
  const targetBytes = targetBytesFromPlan(plan)
  const quality = numberInRange(plan.quality, 0.1, 1, 0.9, 'quality')
  const write = q => { image.quality = Math.round(q * 100); return image.write(magick.MagickFormat[format.format], b => new Uint8Array(b)) }
  let data = write(quality), attempts = 1
  if (targetBytes && data.length > targetBytes) {
    if (format.extension !== 'png') {
      let lo = 0.1, hi = quality, fit = null
      const low = write(lo); attempts++
      if (low.length < data.length) data = low
      if (low.length <= targetBytes) {
        fit = low
        for (let i = 0; i < 7; i++) {
          const mid = (lo + hi) / 2, candidate = write(mid); attempts++
          if (candidate.length <= targetBytes) { fit = candidate; lo = mid } else hi = mid
        }
        data = fit
      }
    }
    let bestWidth = image.width, bestHeight = image.height
    if (data.length > targetBytes && plan.allowResize === true) {
      for (let i = 0; i < 6 && data.length > targetBytes && Math.min(image.width, image.height) > 32; i++) {
        const factor = Math.max(0.5, Math.min(0.9, Math.sqrt(targetBytes / data.length) * 0.95))
        image.resize(Math.max(1, Math.round(image.width * factor)), Math.max(1, Math.round(image.height * factor)), magick.FilterType.Lanczos)
        const candidate = write(format.extension === 'png' ? quality : Math.min(quality, 0.4)); attempts++
        if (candidate.length < data.length) { data = candidate; bestWidth = image.width; bestHeight = image.height }
      }
    }
    return { data, metadata: { width: bestWidth, height: bestHeight, targetBytes, targetMet: data.length <= targetBytes, attempts } }
  }
  return { data, metadata: { width: image.width, height: image.height, ...(targetBytes ? { targetBytes, targetMet: data.length <= targetBytes, attempts } : {}) } }
}

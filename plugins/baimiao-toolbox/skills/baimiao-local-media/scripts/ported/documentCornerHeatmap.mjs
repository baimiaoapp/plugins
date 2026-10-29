import { fullDocumentCorners, validDocumentCorners } from './documentGeometry.mjs'

// DocAligner heatmap_reg: BGR uint8 resize -> NCHW float32 / 255.
// Use half-pixel bilinear sampling rather than Canvas's browser-dependent minification.
export function documentCornerTensor({ data, width, height }) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    data.length !== width * height * 4
  )
    throw new Error('DOCUMENT_DECODE')
  const size = 256,
    output = new Float32Array(3 * size * size)
  for (let y = 0; y < size; y++) {
    const sy = Math.max(0, Math.min(height - 1, ((y + 0.5) * height) / size - 0.5))
    const y0 = Math.floor(sy),
      y1 = Math.min(height - 1, y0 + 1),
      fy = sy - y0
    for (let x = 0; x < size; x++) {
      const sx = Math.max(0, Math.min(width - 1, ((x + 0.5) * width) / size - 0.5))
      const x0 = Math.floor(sx),
        x1 = Math.min(width - 1, x0 + 1),
        fx = sx - x0
      for (let c = 0; c < 3; c++) {
        const channel = 2 - c
        const value =
          (1 - fy) *
            ((1 - fx) * data[(y0 * width + x0) * 4 + channel] +
              fx * data[(y0 * width + x1) * 4 + channel]) +
          fy *
            ((1 - fx) * data[(y1 * width + x0) * 4 + channel] +
              fx * data[(y1 * width + x1) * 4 + channel])
        output[c * size * size + y * size + x] = Math.round(value) / 255
      }
    }
  }
  return output
}

const otsu = (histogram, count) => {
  let total = 0,
    lowerSum = 0,
    lowerCount = 0,
    best = -1,
    threshold = 0
  for (let i = 0; i < 256; i++) total += i * histogram[i]
  for (let i = 0; i < 256; i++) {
    lowerCount += histogram[i]
    lowerSum += i * histogram[i]
    const upperCount = count - lowerCount
    if (!lowerCount || !upperCount) continue
    const delta = lowerSum / lowerCount - (total - lowerSum) / upperCount
    const score = lowerCount * upperCount * delta * delta
    if (score > best) {
      best = score
      threshold = i
    }
  }
  return threshold
}

// Trace pixel-centre outer boundaries (8-connected), matching contour moments,
// rather than averaging foreground pixels, which changes centres around holes.
const directions = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
]
export function largestHeatmapContour(mask, width, height) {
  const stride = width + 2
  let best = null,
    tied = false
  for (let y = 1; y <= height; y++)
    for (let x = 1; x <= width; x++) {
      const start = y * stride + x
      if (mask[start] !== 1) continue
      // Scanline fill marks the component without a full-size int32 queue.
      const pending = [start]
      while (pending.length) {
        const seed = pending.pop()
        if (mask[seed] !== 1) continue
        let left = seed,
          right = seed
        while (mask[left - 1] === 1) left--
        while (mask[right + 1] === 1) right++
        mask.fill(2, left, right + 1)
        for (const dy of [-stride, stride]) {
          let inRun = false
          for (let p = left + dy - 1; p <= right + dy + 1; p++) {
            if (mask[p] === 1) {
              if (!inRun) pending.push(p)
              inRun = true
            } else inRun = false
          }
        }
      }
      let px = x,
        py = y,
        back = 4,
        first = -1,
        twiceArea = 0,
        mx = 0,
        my = 0
      let closed = false
      for (let step = 0; step < width * height * 8; step++) {
        let found = -1
        for (let k = 1; k <= 8; k++) {
          const d = (back + k) % 8,
            [dx, dy] = directions[d]
          if (mask[(py + dy) * stride + px + dx]) {
            found = d
            break
          }
        }
        if (found < 0) break
        const [dx, dy] = directions[found],
          nx = px + dx,
          ny = py + dy
        if (first < 0) first = ny * stride + nx
        else if (px === x && py === y && ny * stride + nx === first) {
          closed = true
          break
        }
        const ax = px - 1,
          ay = py - 1,
          bx = nx - 1,
          by = ny - 1
        const cross = ax * by - bx * ay
        twiceArea += cross
        mx += (ax + bx) * cross
        my += (ay + by) * cross
        const previous = directions[(found + 7) % 8]
        back = directions.findIndex(([a, b]) => a === previous[0] - dx && b === previous[1] - dy)
        px = nx
        py = ny
      }
      const area = Math.abs(twiceArea) / 2
      if (!closed || area === 0) continue
      const centre = [mx / (3 * twiceArea), my / (3 * twiceArea)].map(
        (v) => (v * area) / (area + 1e-5),
      )
      if (!best || area > best.area) {
        best = { area, centre }
        tied = false
      } else if (area === best.area) tied = true
    }
  return tied ? null : best
}

export function documentCornersFromHeatmap({ data, dims }, width, height) {
  if (
    dims.length !== 4 ||
    dims[0] !== 1 ||
    dims[1] !== 4 ||
    dims[2] !== 128 ||
    dims[3] !== 128 ||
    data.length !== 4 * 128 * 128 ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 2 ||
    height < 2 ||
    width * height > 16_000_000 ||
    Math.max(width, height) > 8192
  )
    throw new Error('DOCUMENT_CORNERS')
  const fallback = { corners: fullDocumentCorners(), confidence: 0, detector: 'docaligner' }
  const corners = [],
    peaks = [],
    stride = width + 2
  const mask = new Uint8Array(stride * (height + 2))
  for (let c = 0; c < 4; c++) {
    const offset = c * 128 * 128
    let peak = 0
    for (let i = 0; i < 128 * 128; i++) {
      const v = data[offset + i]
      if (!Number.isFinite(v) || v < 0 || v > 1) return fallback
      peak = Math.max(peak, v)
    }
    if (peak < 0.3) return fallback
    peaks.push(peak)
    mask.fill(0)
    const histogram = new Uint32Array(256)
    for (let y = 0; y < height; y++) {
      const sy = Math.max(0, Math.min(127, ((y + 0.5) * 128) / height - 0.5))
      const y0 = Math.floor(sy),
        y1 = Math.min(127, y0 + 1),
        fy = sy - y0
      for (let x = 0; x < width; x++) {
        const sx = Math.max(0, Math.min(127, ((x + 0.5) * 128) / width - 0.5))
        const x0 = Math.floor(sx),
          x1 = Math.min(127, x0 + 1),
          fx = sx - x0
        const v =
          (1 - fy) * ((1 - fx) * data[offset + y0 * 128 + x0] + fx * data[offset + y0 * 128 + x1]) +
          fy * ((1 - fx) * data[offset + y1 * 128 + x0] + fx * data[offset + y1 * 128 + x1])
        const byte = v < 0.3 ? 0 : Math.trunc(v * 255)
        mask[(y + 1) * stride + x + 1] = byte
        histogram[byte]++
      }
    }
    const threshold = otsu(histogram, width * height)
    for (let i = 0; i < mask.length; i++) mask[i] = mask[i] > threshold ? 1 : 0
    const contour = largestHeatmapContour(mask, width, height)
    if (!contour) return fallback
    corners.push([contour.centre[0] / (width - 1), contour.centre[1] / (height - 1)])
  }
  // Never reorder crossed/duplicated channels into a plausible but different crop.
  return validDocumentCorners(corners)
    ? { corners, confidence: Math.min(...peaks), detector: 'docaligner' }
    : fallback
}

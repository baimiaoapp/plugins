// Coordinates are normalized, clockwise: top-left, top-right, bottom-right, bottom-left.
export const fullDocumentCorners = () => [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
]
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
const area = (p) =>
  Math.abs(
    p.reduce((sum, a, i) => {
      const b = p[(i + 1) % p.length]
      return sum + a[0] * b[1] - b[0] * a[1]
    }, 0),
  ) / 2
export const validDocumentCorners = (p) =>
  Array.isArray(p) &&
  p.length === 4 &&
  p.every(
    (a) =>
      Array.isArray(a) && a.length === 2 && a.every((v) => Number.isFinite(v) && v >= 0 && v <= 1),
  ) &&
  p.every((a, i) => cross(a, p[(i + 1) % 4], p[(i + 2) % 4]) > 0.0001) &&
  area(p) >= 0.01
export const isFullDocument = (p) =>
  !p ||
  (validDocumentCorners(p) &&
    p.every((a, i) => a.every((v, j) => Math.abs(v - fullDocumentCorners()[i][j]) < 1e-8)))

export const documentOutputSize = (width, height, corners) => {
  if (!validDocumentCorners(corners)) throw new Error('DOCUMENT_CORNERS')
  const p = corners.map(([x, y]) => [x * (width - 1), y * (height - 1)])
  const distance = (i, j) => Math.hypot(p[i][0] - p[j][0], p[i][1] - p[j][1])
  const w = Math.max(2, Math.round(Math.max(distance(0, 1), distance(2, 3))) + 1)
  const h = Math.max(2, Math.round(Math.max(distance(0, 3), distance(1, 2))) + 1)
  if (w * h > 16_000_000 || Math.max(w, h) > 8192) throw new Error('DOCUMENT_TOO_LARGE')
  return { width: w, height: h }
}

// Inverse homography from the output unit square to the source quadrilateral.
export const documentHomography = (p) => {
  if (!validDocumentCorners(p)) throw new Error('DOCUMENT_CORNERS')
  const dx1 = p[1][0] - p[2][0],
    dx2 = p[3][0] - p[2][0]
  const dy1 = p[1][1] - p[2][1],
    dy2 = p[3][1] - p[2][1]
  const dx3 = p[0][0] - p[1][0] + p[2][0] - p[3][0]
  const dy3 = p[0][1] - p[1][1] + p[2][1] - p[3][1]
  const det = dx1 * dy2 - dx2 * dy1
  if (Math.abs(det) < 1e-10) throw new Error('DOCUMENT_CORNERS')
  const g = (dx3 * dy2 - dx2 * dy3) / det
  const h = (dx1 * dy3 - dx3 * dy1) / det
  return [
    p[1][0] - p[0][0] + g * p[1][0],
    p[3][0] - p[0][0] + h * p[3][0],
    p[0][0],
    p[1][1] - p[0][1] + g * p[1][1],
    p[3][1] - p[0][1] + h * p[3][1],
    p[0][1],
    g,
    h,
  ]
}
export const mapDocumentPoint = (m, u, v) => {
  const z = m[6] * u + m[7] * v + 1
  return [(m[0] * u + m[1] * v + m[2]) / z, (m[3] * u + m[4] * v + m[5]) / z]
}

export const rectifyDocument = (image, corners, onProgress) => {
  if (isFullDocument(corners)) return image
  const { width, height } = documentOutputSize(image.width, image.height, corners)
  const m = documentHomography(corners)
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    if (y % 64 === 0) onProgress?.(y / height)
    for (let x = 0; x < width; x++) {
      const [u, v] = mapDocumentPoint(m, x / (width - 1), y / (height - 1))
      const sx = Math.max(0, Math.min(image.width - 1, u * (image.width - 1)))
      const sy = Math.max(0, Math.min(image.height - 1, v * (image.height - 1)))
      const x0 = Math.floor(sx),
        y0 = Math.floor(sy),
        x1 = Math.min(x0 + 1, image.width - 1),
        y1 = Math.min(y0 + 1, image.height - 1)
      const fx = sx - x0,
        fy = sy - y0,
        out = (y * width + x) * 4
      for (let c = 0; c < 3; c++) {
        data[out + c] =
          (1 - fy) *
            ((1 - fx) * image.data[(y0 * image.width + x0) * 4 + c] +
              fx * image.data[(y0 * image.width + x1) * 4 + c]) +
          fy *
            ((1 - fx) * image.data[(y1 * image.width + x0) * 4 + c] +
              fx * image.data[(y1 * image.width + x1) * 4 + c])
      }
      data[out + 3] = 255
    }
  }
  return { data, width, height }
}

const convexHull = (points) => {
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const half = (list) => {
    const out = []
    for (const p of list) {
      while (out.length > 1 && cross(out.at(-2), out.at(-1), p) <= 0) out.pop()
      out.push(p)
    }
    return out
  }
  const a = half(points),
    b = half([...points].reverse())
  return [...a.slice(0, -1), ...b.slice(0, -1)]
}

// Multiple paper thresholds tolerate uneven light. The result is a proposal,
// never semantic certainty: ambiguous/full-frame inputs fall back to manual corners.
export const detectDocumentCorners = ({ data, width, height }) => {
  if (width < 8 || height < 8 || width * height > 640 * 640 || data.length !== width * height * 4)
    throw new Error('DOCUMENT_FAILED')
  const n = width * height,
    gray = new Float32Array(n),
    blurred = new Float32Array(n)
  for (let i = 0; i < n; i++)
    gray[i] = data[i * 4] * 0.2126 + data[i * 4 + 1] * 0.7152 + data[i * 4 + 2] * 0.0722
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let sum = 0,
        count = 0
      for (let yy = Math.max(0, y - 2); yy <= Math.min(height - 1, y + 2); yy++)
        for (let xx = Math.max(0, x - 2); xx <= Math.min(width - 1, x + 2); xx++) {
          sum += gray[yy * width + xx]
          count++
        }
      blurred[y * width + x] = sum / count
    }
  let best = null
  const queue = new Int32Array(n)
  for (const threshold of [64, 88, 112, 136, 160, 184, 208, 232]) {
    const seen = new Uint8Array(n)
    for (let start = 0; start < n; start++) {
      if (seen[start] || blurred[start] < threshold) continue
      let head = 0,
        tail = 1
      queue[0] = start
      seen[start] = 1
      const boundary = []
      while (head < tail) {
        const i = queue[head++],
          x = i % width,
          y = Math.floor(i / width)
        let edge = false
        for (const [xx, yy] of [
          [x - 1, y],
          [x + 1, y],
          [x, y - 1],
          [x, y + 1],
        ]) {
          if (xx < 0 || yy < 0 || xx >= width || yy >= height) {
            edge = true
            continue
          }
          const j = yy * width + xx
          if (blurred[j] < threshold) {
            edge = true
            continue
          }
          if (!seen[j]) {
            seen[j] = 1
            queue[tail++] = j
          }
        }
        if (edge) boundary.push([x, y])
      }
      if (tail < n * 0.08 || tail > n * 0.97 || boundary.length < 4) continue
      const hull = convexHull(boundary)
      if (hull.length < 4) continue
      const hullArea = area(hull)
      const quad = [...hull]
      while (quad.length > 4) {
        let at = 0,
          smallest = Infinity
        for (let i = 0; i < quad.length; i++) {
          const cost = Math.abs(
            cross(quad[(i + quad.length - 1) % quad.length], quad[i], quad[(i + 1) % quad.length]),
          )
          if (cost < smallest) {
            smallest = cost
            at = i
          }
        }
        quad.splice(at, 1)
      }
      let first = 0
      for (let i = 1; i < 4; i++)
        if (quad[i][0] + quad[i][1] < quad[first][0] + quad[first][1]) first = i
      const ordered = quad.slice(first).concat(quad.slice(0, first))
      const normalized = ordered.map(([x, y]) => [x / (width - 1), y / (height - 1)])
      if (!validDocumentCorners(normalized)) continue
      const quadArea = area(quad),
        rectangularity = quadArea / hullArea
      if (rectangularity < 0.8 || tail / hullArea < 0.55) continue
      // A paper proposal must have support along all four sides, not just a
      // bright text block or a triangle cut from a hard shadow.
      const edgeContrast = []
      for (let i = 0; i < 4; i++) {
        const a = ordered[i],
          b = ordered[(i + 1) % 4],
          dx = b[0] - a[0],
          dy = b[1] - a[1],
          len = Math.hypot(dx, dy)
        let sum = 0,
          count = 0
        for (let k = 2; k < 18; k++) {
          const x = a[0] + (dx * k) / 20,
            y = a[1] + (dy * k) / 20
          const ix = Math.round(x - (dy / len) * 4),
            iy = Math.round(y + (dx / len) * 4)
          const ox = Math.round(x + (dy / len) * 4),
            oy = Math.round(y - (dx / len) * 4)
          if (
            [ix, ox].some((v) => v < 0 || v >= width) ||
            [iy, oy].some((v) => v < 0 || v >= height)
          )
            continue
          sum += gray[iy * width + ix] - gray[oy * width + ox]
          count++
        }
        edgeContrast.push(count ? sum / count : 0)
      }
      const support = edgeContrast.filter((v) => v > 8).length
      if (support < 3) continue
      const contrast = edgeContrast.reduce((a, b) => a + Math.max(0, b), 0) / 4
      const score =
        (Math.sqrt(quadArea / n) * rectangularity * Math.min(1, contrast / 45) * support) / 4
      if (!best || score > best.score)
        best = { corners: normalized, score, confidence: Math.min(1, score) }
    }
  }
  return best && best.score > 0.2
    ? { corners: best.corners, confidence: best.confidence }
    : { corners: fullDocumentCorners(), confidence: 0 }
}

const byte = (v) => Math.round(Math.max(0, Math.min(255, v)))
// Native Gaussian kernel: radius ceil(2*sigma), clamped edges, RGBA8 after each axis.
export function gaussianScanBlur({ data, width, height }, sigma) {
  const radius = Math.ceil(sigma * 2),
    weights = new Float64Array(radius * 2 + 1)
  let total = 0
  for (let d = -radius; d <= radius; d++)
    total += weights[d + radius] = Math.exp((-0.5 * d * d) / (sigma * sigma))
  for (let i = 0; i < weights.length; i++) weights[i] /= total
  let input = data
  for (const vertical of [false, true]) {
    const output = new Uint8ClampedArray(data.length)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const p = (y * width + x) * 4
        let r = 0,
          g = 0,
          b = 0
        for (let d = -radius; d <= radius; d++) {
          const xx = vertical ? x : Math.max(0, Math.min(width - 1, x + d)),
            yy = vertical ? Math.max(0, Math.min(height - 1, y + d)) : y
          const q = (yy * width + xx) * 4,
            w = weights[d + radius]
          r += input[q] * w
          g += input[q + 1] * w
          b += input[q + 2] * w
        }
        output[p] = byte(r)
        output[p + 1] = byte(g)
        output[p + 2] = byte(b)
        output[p + 3] = 255
      }
    input = output
  }
  return input
}
const sample = (data, w, h, x, y, c) => {
  x = Math.max(0, Math.min(w - 1, x))
  y = Math.max(0, Math.min(h - 1, y))
  const x0 = Math.floor(x),
    y0 = Math.floor(y),
    x1 = Math.min(w - 1, x0 + 1),
    y1 = Math.min(h - 1, y0 + 1),
    fx = x - x0,
    fy = y - y0
  return (
    (data[(y0 * w + x0) * 4 + c] * (1 - fx) + data[(y0 * w + x1) * 4 + c] * fx) * (1 - fy) +
    (data[(y1 * w + x0) * 4 + c] * (1 - fx) + data[(y1 * w + x1) * 4 + c] * fx) * fy
  )
}
export function normalizeScanBackground({ data, width, height }) {
  const scale = Math.fround(256 / Math.max(width, height)),
    w = Math.max(1, Math.trunc(Math.fround(width * scale))),
    h = Math.max(1, Math.trunc(Math.fround(height * scale)))
  let bg = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 4; c++)
        bg[(y * w + x) * 4 + c] = byte(
          sample(
            data,
            width,
            height,
            ((x + 0.5) * width) / w - 0.5,
            ((y + 0.5) * height) / h - 0.5,
            c,
          ),
        )
  for (const dilate of [true, false])
    for (const vertical of [false, true]) {
      const output = new Uint8ClampedArray(bg.length)
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          for (let c = 0; c < 4; c++) {
            let value = dilate ? 0 : 255
            for (let d = -12; d <= 12; d++) {
              const xx = vertical ? x : Math.max(0, Math.min(w - 1, x + d)),
                yy = vertical ? Math.max(0, Math.min(h - 1, y + d)) : y
              value = dilate
                ? Math.max(value, bg[(yy * w + xx) * 4 + c])
                : Math.min(value, bg[(yy * w + xx) * 4 + c])
            }
            output[(y * w + x) * 4 + c] = value
          }
      bg = output
    }
  bg = gaussianScanBlur({ data: bg, width: w, height: h }, 5)
  const output = new Uint8ClampedArray(data.length)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4
      const rgb = [0, 1, 2].map(
        (c) =>
          data[p + c] /
          Math.max(
            0.255,
            sample(bg, w, h, ((x + 0.5) * w) / width - 0.5, ((y + 0.5) * h) / height - 0.5, c),
          ),
      )
      const l = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
      for (let c = 0; c < 3; c++)
        output[p + c] = byte(((l + (rgb[c] - l) * 1.1 - 0.5) * 1.186 + 0.5) * 255)
      output[p + 3] = data[p + 3]
    }
  return output
}

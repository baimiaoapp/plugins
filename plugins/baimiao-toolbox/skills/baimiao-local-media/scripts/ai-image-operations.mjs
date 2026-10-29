import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { CliError } from './cli-options.mjs'
import { ensureRuntimeFile } from './runtime-cache.mjs'
import { loadOrt, loadMagick, loadFfmpeg, resolveRegularInput, createResult, integerInRange, numberInRange, enumValue } from './media-node-adapter.mjs'
import { decodeRgba, encodeRgba } from './extended-media.mjs'

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const sample = (data, w, h, x, y, channels = 1, c = 0) => {
  x = clamp(x, 0, w - 1); y = clamp(y, 0, h - 1)
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1)
  const fx = x - x0, fy = y - y0
  return (1 - fy) * ((1 - fx) * data[(y0 * w + x0) * channels + c] + fx * data[(y0 * w + x1) * channels + c])
    + fy * ((1 - fx) * data[(y1 * w + x0) * channels + c] + fx * data[(y1 * w + x1) * channels + c])
}
const createSession = async (ort, filename) => ort.InferenceSession.create(await readFile(await ensureRuntimeFile(filename)), { executionProviders: ['wasm'] })

export const runAiImageOperation = async ({ operation, inputs, plan, outputPath, outputDir, transactions }) => {
  const results = []
  if (operation === 'image-upscale') {
    const model = enumValue(plan.model, ['photo', 'anime'], 'photo', 'model')
    const scale = integerInRange(plan.scale, 2, 4, 4, 'scale')
    if (![2, 4].includes(scale)) throw new CliError('INVALID_PLAN', 'scale must be 2 or 4.')
    const ort = await loadOrt()
    const session = await createSession(ort, `upscale-${model}.onnx`)
    try {
      for (const input of inputs) {
        const pixels = await decodeRgba(input.data)
        if (pixels.width * pixels.height > 1_000_000) throw new CliError('IMAGE_RESOURCE_LIMIT', 'AI upscaling accepts at most one megapixel per source; resize larger inputs first.')
        const output = await upscalePixels(pixels, ort, session, scale)
        results.push({ data: await encodeRgba(output), path: await transactions.resolveOutputPath(path.join(outputDir, `${path.parse(input.path).name}-upscale.png`)), type: 'image/png', metadata: { model, scale, width: output.width, height: output.height } })
      }
    } finally { await session.release() }
  } else {
    const pixels = await decodeRgba(inputs[0].data)
    const selector = createMaskSelector(pixels)
    try {
      if (operation === 'image-smart-cutout') {
        const mask = await selector.select(plan)
        const output = { ...pixels, data: pixels.data.slice() }
        for (let i = 0; i < mask.length; i++) output.data[i * 4 + 3] = Math.round(output.data[i * 4 + 3] * mask[i] / 255)
        results.push({ data: await encodeRgba(output), path: await transactions.resolveOutputPath(path.join(outputDir, `${path.parse(inputs[0].path).name}-cutout.png`)), type: 'image/png' })
        if (plan.saveMask === true) {
          const data = new Uint8ClampedArray(pixels.data.length)
          for (let i = 0; i < mask.length; i++) { data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = mask[i]; data[i * 4 + 3] = 255 }
          results.push({ data: await encodeRgba({ ...pixels, data }), path: await transactions.resolveOutputPath(path.join(outputDir, `${path.parse(inputs[0].path).name}-mask.png`)), type: 'image/png' })
        }
      } else {
        if (!Array.isArray(plan.objects) || !plan.objects.length || plan.objects.length > 8) throw new CliError('INVALID_PLAN', 'Motion requires 1–8 objects, each with points or maskPath and motion settings.')
        const objects = []
        for (const object of plan.objects) objects.push({ ...object, mask: await selector.select(object) })
        const data = await renderMotion(pixels, objects, plan)
        results.push({ data, path: outputPath, type: plan.format === 'gif' ? 'image/gif' : 'video/mp4', metadata: { objects: objects.length } })
      }
    } finally { await selector.dispose() }
  }
  await transactions.commitOutputs(results)
  return createResult(operation, 'onnxruntime.wasm+imagemagick.wasm', results)
}

const upscalePixels = async (source, ort, session, scale) => {
  const width = source.width * 4, height = source.height * 4
  const data = new Uint8ClampedArray(width * height * 4)
  const tile = 96, pad = 12
  for (let y = 0; y < source.height; y += tile) for (let x = 0; x < source.width; x += tile) {
    const tw = Math.min(tile, source.width - x), th = Math.min(tile, source.height - y)
    const iw = tw + pad * 2, ih = th + pad * 2, plane = iw * ih
    const values = new Float32Array(3 * plane)
    for (let yy = 0; yy < ih; yy++) for (let xx = 0; xx < iw; xx++) {
      const sx = clamp(x + xx - pad, 0, source.width - 1), sy = clamp(y + yy - pad, 0, source.height - 1)
      for (let c = 0; c < 3; c++) values[c * plane + yy * iw + xx] = source.data[(sy * source.width + sx) * 4 + c] / 255
    }
    const tensor = new ort.Tensor('float32', values, [1, 3, ih, iw])
    let outputs
    try {
      outputs = await session.run({ [session.inputNames[0]]: tensor })
      const out = outputs[session.outputNames[0]], ow = out.dims.at(-1), oh = out.dims.at(-2)
      if (ow !== iw * 4 || oh !== ih * 4) throw new CliError('PROCESSING_FAILED', 'Unexpected upscale model dimensions.')
      for (let yy = 0; yy < th * 4; yy++) for (let xx = 0; xx < tw * 4; xx++) {
        const dest = ((y * 4 + yy) * width + x * 4 + xx) * 4
        for (let c = 0; c < 3; c++) data[dest + c] = clamp(Math.round(out.data[c * ow * oh + (yy + pad * 4) * ow + xx + pad * 4] * 255), 0, 255)
        data[dest + 3] = sample(source.data, source.width, source.height, x + (xx + 0.5) / 4 - 0.5, y + (yy + 0.5) / 4 - 0.5, 4, 3)
      }
    } finally { tensor.dispose(); if (outputs) Object.values(outputs).forEach(t => t.dispose()) }
  }
  if (scale === 4) return { data, width, height }
  const output = new Uint8ClampedArray(source.width * 2 * source.height * 2 * 4)
  for (let y = 0; y < source.height * 2; y++) for (let x = 0; x < source.width * 2; x++) for (let c = 0; c < 4; c++) output[(y * source.width * 2 + x) * 4 + c] = sample(data, width, height, x * 2 + 0.5, y * 2 + 0.5, 4, c)
  return { data: output, width: source.width * 2, height: source.height * 2 }
}

const createMaskSelector = pixels => {
  let encoder, decoder, embeddings, ort
  const w = Math.round(pixels.width * 1024 / Math.max(pixels.width, pixels.height))
  const h = Math.round(pixels.height * 1024 / Math.max(pixels.width, pixels.height))
  return {
    async select(plan) {
      let mask
      if (plan.maskPath) {
        const source = await decodeRgba((await resolveRegularInput(plan.maskPath)).data)
        if (source.width !== pixels.width || source.height !== pixels.height) throw new CliError('INVALID_PLAN', 'Mask dimensions must match the auto-oriented source.')
        mask = new Uint8Array(source.width * source.height)
        for (let i = 0; i < mask.length; i++) mask[i] = source.data[i * 4]
      } else {
        const points = plan.points
        if (!Array.isArray(points) || points.length < 1 || points.length > 64 || !points.some(p => (p.label ?? 1) === 1)
          || points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0 || p.x > 1 || p.y > 1 || ![0, 1].includes(p.label ?? 1))) {
          throw new CliError('INVALID_PLAN', 'Provide maskPath or 1–64 normalized points {x,y,label:0|1}, including a foreground point.')
        }
        ort ||= await loadOrt()
        if (!embeddings) {
          encoder = await createSession(ort, 'slimsam-encoder.onnx')
          const values = new Float32Array(3 * 1024 * 1024)
          const means = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225]
          for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) values[c * 1024 * 1024 + y * 1024 + x] = (sample(pixels.data, pixels.width, pixels.height, (x + 0.5) * pixels.width / w - 0.5, (y + 0.5) * pixels.height / h - 0.5, 4, c) / 255 - means[c]) / std[c]
          const tensor = new ort.Tensor('float32', values, [1, 3, 1024, 1024])
          try { embeddings = await encoder.run({ pixel_values: tensor }) } finally { tensor.dispose() }
          await encoder.release(); encoder = null
        }
        decoder ||= await createSession(ort, 'slimsam-decoder.onnx')
        const positions = new ort.Tensor('float32', Float32Array.from(points.flatMap(p => [p.x * w, p.y * h])), [1, 1, points.length, 2])
        const labels = new ort.Tensor('int64', BigInt64Array.from(points.map(p => BigInt(p.label ?? 1))), [1, 1, points.length])
        let outputs
        try {
          outputs = await decoder.run({ ...embeddings, input_points: positions, input_labels: labels })
          const scores = outputs.iou_scores.data, masks = outputs.pred_masks
          const mw = masks.dims.at(-1), mh = masks.dims.at(-2), count = scores.length
          let bestScore = -Infinity, best
          for (let n = 0; n < count; n++) {
            const low = masks.data.subarray(n * mw * mh, (n + 1) * mw * mh)
            let score = scores[n]
            for (const point of points) if ((sample(low, mw, mh, point.x * w / 1024 * mw - 0.5, point.y * h / 1024 * mh - 0.5) > 0) !== Boolean(point.label ?? 1)) score -= 2
            if (score > bestScore) { bestScore = score; best = low }
          }
          mask = new Uint8Array(pixels.width * pixels.height)
          for (let y = 0; y < pixels.height; y++) for (let x = 0; x < pixels.width; x++) mask[y * pixels.width + x] = sample(best, mw, mh, (x + 0.5) * w / pixels.width / 1024 * mw - 0.5, (y + 0.5) * h / pixels.height / 1024 * mh - 0.5) > 0 ? 255 : 0
        } finally { positions.dispose(); labels.dispose(); if (outputs) Object.values(outputs).forEach(t => t.dispose()) }
      }
      if (plan.invert === true) for (let i = 0; i < mask.length; i++) mask[i] = 255 - mask[i]
      if (plan.brushes !== undefined) {
        if (!Array.isArray(plan.brushes) || plan.brushes.length > 200) throw new CliError('INVALID_PLAN', 'brushes must contain at most 200 normalized circular edits.')
        for (const brush of plan.brushes) {
          const cx = numberInRange(brush.x, 0, 1, NaN, 'brush.x') * (pixels.width - 1)
          const cy = numberInRange(brush.y, 0, 1, NaN, 'brush.y') * (pixels.height - 1)
          const radius = numberInRange(brush.radius, 0.001, 1, NaN, 'brush.radius') * Math.min(pixels.width, pixels.height)
          const value = enumValue(brush.mode, ['add', 'erase'], 'add', 'brush.mode') === 'add' ? 255 : 0
          for (let y = Math.max(0, Math.floor(cy - radius)); y <= Math.min(pixels.height - 1, cy + radius); y++) for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(pixels.width - 1, cx + radius); x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2) mask[y * pixels.width + x] = value
        }
      }
      return mask
    },
    async dispose() {
      if (embeddings) Object.values(embeddings).forEach(t => t.dispose())
      await encoder?.release(); await decoder?.release()
    },
  }
}

const renderMotion = async (pixels, objects, plan) => {
  const format = enumValue(plan.format, ['mp4', 'gif'], 'mp4', 'format')
  const fps = integerInRange(plan.fps, 1, 30, 12, 'fps')
  const duration = numberInRange(plan.duration, 0.1, 15, 3, 'duration')
  const maxEdge = integerInRange(plan.maxEdge, 64, 1280, 720, 'maxEdge')
  const ratio = Math.min(1, maxEdge / Math.max(pixels.width, pixels.height))
  const width = Math.max(2, Math.floor(pixels.width * ratio / 2) * 2), height = Math.max(2, Math.floor(pixels.height * ratio / 2) * 2)
  const color = plan.background || 'original'
  if (color !== 'original' && !/^#[\da-f]{6}$/i.test(color)) throw new CliError('INVALID_PLAN', 'background must be a six-digit hex color.')
  const bg = color === 'original' ? [255,255,255] : parseColor(color)
  if (width * height * Math.ceil(duration * fps) * objects.length > 180_000_000) throw new CliError('MOTION_RESOURCE_LIMIT', 'Reduce duration, fps, maxEdge or object count to stay within 180 million pixel-object frames.')
  const normalized = objects.map(o => ({ ...o,
    outline: enumValue(o.outline, ['none','solid','dashed','double'], 'solid', 'outline'),
    outlineWidth: numberInRange(o.outlineWidth, 1, 16, 3, 'outlineWidth'),
    outlineColor: parseColor(o.outlineColor || '#ffffff'),
    outerColor: parseColor(o.outerColor || '#000000'),
    glow: enumValue(o.glow, ['none','exposure','neon','sweep'], 'none', 'glow'),
    glowColor: parseColor(o.glowColor || '#ffffff'),
    glowIntensity: numberInRange(o.glowIntensity, 0, 1, 0.8, 'glowIntensity'),
    distance: maskDistance(o.mask, pixels.width, pixels.height),
    effect: enumValue(o.effect, ['float', 'swing', 'pulse', 'orbit', 'none'], 'none', 'effect'),
    amplitude: numberInRange(o.amplitude, 0, 0.5, 0.05, 'amplitude'),
    rotation: numberInRange(o.rotation, 0, 180, 12, 'rotation'),
    phase: numberInRange(o.phase, 0, 360, 0, 'phase'),
    cycles: numberInRange(o.cycles, 0.1, 10, 1, 'cycles'),
    opacity: numberInRange(o.opacity, 0, 1, 1, 'opacity'),
  }))
  const ffmpeg = await loadFfmpeg(), prefix = `motion-${randomUUID()}`
  const output = `${prefix}.${format}`, frames = Math.ceil(duration * fps)
  const filenames = []
  try {
    for (let frame = 0; frame < frames; frame++) {
      const data = new Uint8ClampedArray(width * height * 4)
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = y * width + x
        for (let c = 0; c < 3; c++) data[i * 4 + c] = color === 'original' ? sample(pixels.data, pixels.width, pixels.height, x * pixels.width / width, y * pixels.height / height, 4, c) : bg[c]
        data[i * 4 + 3] = 255
      }
      for (const object of normalized) {
        const t = frame / frames * Math.PI * 2 * object.cycles + object.phase * Math.PI / 180
        const dx = object.effect === 'orbit' ? Math.cos(t) * width * object.amplitude : 0
        const dy = ['float', 'orbit'].includes(object.effect) ? Math.sin(t) * height * object.amplitude : 0
        const angle = object.effect === 'swing' ? Math.sin(t) * object.rotation * Math.PI / 180 : 0
        const scale = object.effect === 'pulse' ? 1 + Math.sin(t) * object.amplitude : 1
        const cos = Math.cos(angle), sin = Math.sin(angle)
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const xx = (x - width / 2 - dx) / scale, yy = (y - height / 2 - dy) / scale
          const sx = (xx * cos + yy * sin + width / 2) * pixels.width / width
          const sy = (-xx * sin + yy * cos + height / 2) * pixels.height / height
          if (sx < 0 || sx >= pixels.width || sy < 0 || sy >= pixels.height) continue
          const alpha = sample(object.mask, pixels.width, pixels.height, sx, sy) / 255 * sample(pixels.data, pixels.width, pixels.height, sx, sy, 4, 3) / 255 * object.opacity
          const distance = sample(object.distance, pixels.width, pixels.height, sx, sy) * ratio
          const blend = (rgb, amount) => {
            amount = clamp(amount * object.opacity, 0, 1)
            for (let c = 0; c < 3; c++) data[(y * width + x) * 4 + c] = data[(y * width + x) * 4 + c] * (1 - amount) + rgb[c] * amount
          }
          if (distance > 0 && distance <= object.outlineWidth * (object.outline === 'double' ? 2 : 1) && object.outline !== 'none') {
            if (object.outline !== 'dashed' || (Math.atan2(y-height/2,x-width/2) * 12 + t * 2) % 2 < 1) blend(object.outline === 'double' && distance > object.outlineWidth ? object.outerColor : object.outlineColor, 1)
          }
          if (object.glow === 'neon' && distance > 0 && distance < 24) {
            const rgb = [0,2,4].map(phase => 128 + 127 * Math.sin(t + phase + Math.atan2(y-height/2,x-width/2)))
            blend(rgb, Math.exp(-distance / 6) * object.glowIntensity)
          }
          for (let c = 0; c < 3; c++) data[(y * width + x) * 4 + c] = data[(y * width + x) * 4 + c] * (1 - alpha) + sample(pixels.data, pixels.width, pixels.height, sx, sy, 4, c) * alpha
          if (object.glow === 'exposure') blend(object.glowColor, alpha * (0.5 + 0.5 * Math.sin(t)) * object.glowIntensity)
          if (object.glow === 'sweep') blend(object.glowColor, alpha * Math.exp(-(((x/width - (t/(Math.PI*2)%1)) / 0.12) ** 2)) * object.glowIntensity)
        }
      }
      const filename = `${prefix}-${String(frame).padStart(4, '0')}.png`
      ffmpeg.FS.writeFile(filename, await encodeRgba({ data, width, height })); filenames.push(filename)
    }
    ffmpeg.reset()
    const args = ['-framerate', String(fps), '-i', `${prefix}-%04d.png`]
    if (format === 'mp4') args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart')
    else args.push('-loop', '0')
    if (ffmpeg.exec(...args, output) !== 0) throw new CliError('PROCESSING_FAILED', 'Motion encoding failed.')
    return new Uint8Array(ffmpeg.FS.readFile(output))
  } finally {
    for (const filename of [...filenames, output]) try { ffmpeg.FS.unlink(filename) } catch { /* May not exist after an encoding failure. */ }
  }
}

function parseColor(color) {
  if (typeof color !== 'string' || !/^#[\da-f]{6}$/i.test(color)) throw new CliError('INVALID_PLAN', 'Colors must use six-digit hex notation.')
  return [1,3,5].map(i => parseInt(color.slice(i, i + 2), 16))
}
function maskDistance(mask, width, height) {
  const d = Float32Array.from(mask, a => a > 127 ? 0 : width + height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x
    if (x) d[i] = Math.min(d[i], d[i-1]+1)
    if (y) d[i] = Math.min(d[i], d[i-width]+1)
    if (x && y) d[i] = Math.min(d[i], d[i-width-1]+Math.SQRT2)
  }
  for (let y = height-1; y >= 0; y--) for (let x = width-1; x >= 0; x--) {
    const i = y * width + x
    if (x+1 < width) d[i] = Math.min(d[i], d[i+1]+1)
    if (y+1 < height) d[i] = Math.min(d[i], d[i+width]+1)
    if (x+1 < width && y+1 < height) d[i] = Math.min(d[i], d[i+width+1]+Math.SQRT2)
  }
  return d
}

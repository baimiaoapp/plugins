import { localResultHandoffs } from './result-handoffs.mjs'
import { randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { CliError } from './cli-options.mjs'
import { ensureRuntimeBundle, ensureRuntimeFile } from './runtime-cache.mjs'
import { createLocalArtifactTransactions } from './local-artifact-transaction.mjs'
import { IMAGE_OPERATION_NAMES, MEDIA_OPERATION_NAMES } from './operation-catalog.mjs'

const IMAGE_OPERATIONS = new Set(IMAGE_OPERATION_NAMES)
const OUTPUT_FORMATS = Object.freeze({
  jpeg: { extension: 'jpg', format: 'Jpeg', type: 'image/jpeg' },
  jpg: { extension: 'jpg', format: 'Jpeg', type: 'image/jpeg' },
  png: { extension: 'png', format: 'Png', type: 'image/png' },
  webp: { extension: 'webp', format: 'WebP', type: 'image/webp' },
})

let magickPromise
let magickFontPromise
let pdfiumPromise
let ffmpegPromise
let ortPromise
const defaultTransactions = createLocalArtifactTransactions()

export const MEDIA_OPERATIONS = Object.freeze(new Set(MEDIA_OPERATION_NAMES))

export const convertImageForOcr = async (inputPath) => {
  const input = await resolveRegularInput(inputPath)
  const magick = await loadMagick()
  let image
  try {
    image = magick.MagickImage.create(input.data)
    image.autoOrient()
    const { width, height } = calculateOcrSize(image.width, image.height)
    if (width !== image.width || height !== image.height) {
      image.resize(width, height, magick.FilterType.Lanczos)
    }
    prepareImageForWrite(magick, image, OUTPUT_FORMATS.jpeg, { quality: 0.85 })
    return new Uint8Array(image.write(
      magick.MagickFormat.Jpeg,
      (bytes) => new Uint8Array(bytes),
    ))
  } catch (error) {
    if (error instanceof CliError) throw error
    throw new CliError('INPUT_NOT_IMAGE', 'The OCR input is not a readable supported image.')
  } finally {
    image?.dispose()
  }
}

export const runMediaOperation = async ({ operation, options, transactions = defaultTransactions }) => {
  const plan = options.plan ? await transactions.readJsonPlan(options.plan) : {}
  const inputs = await Promise.all(options.inputs.map(resolveRegularInput))
  rejectDuplicateInputs(inputs)

  const { isExtendedOperation, runExtendedOperation } = await import('./extended-media.mjs')
  if (isExtendedOperation(operation)) return runExtendedOperation({ operation, inputs, options, plan, transactions })

  if (operation === 'pdf-to-images') return renderPdfToImages(inputs[0], options.outputDir, plan, transactions)
  if (operation === 'compress-lossy') return compressPdfLossy(inputs[0], options.output, plan, transactions)
  if (operation === 'video-to-gif') return convertVideoToGif(inputs[0], options.output, plan, transactions)
  if (operation === 'gif-to-images') return extractGifFrames(inputs[0], options.outputDir, plan, transactions)
  if (operation === 'image-to-gif') return convertImagesToGif(inputs, options.output, plan, transactions)
  if (operation === 'image-rembg') return removeImageBackgrounds(inputs, options.outputDir, plan, transactions)
  return processImages(operation, inputs, options.outputDir, plan, transactions)
}

const processImages = async (operation, inputs, outputDirPath, plan, transactions) => {
  const magick = await loadMagick({ font: operation === 'image-watermark' })
  const outputDirectory = await transactions.resolveOutputDirectory(outputDirPath)
  const outputFormat = normalizeOutputFormat(plan.format || plan.outputType, operation === 'image-compress' ? 'webp' : 'png')
  const results = []
  const { encodeImageWithTarget } = await import('./target-compression.mjs')

  for (const input of inputs) {
    let image
    try {
      image = magick.MagickImage.create(input.data)
      image.autoOrient()
      applyImageOperation(magick, operation, image, plan)
      prepareImageForWrite(magick, image, outputFormat, plan)
      const encoded = operation === 'image-compress' ? encodeImageWithTarget(magick, image, outputFormat, plan)
        : { data: image.write(magick.MagickFormat[outputFormat.format], (bytes) => new Uint8Array(bytes)) }
      results.push({
        ...encoded,
        path: await transactions.resolveOutputPath(path.join(
          outputDirectory,
          `${basenameWithoutExtension(input.path)}-${operationSuffix(operation)}.${outputFormat.extension}`,
        )),
        type: outputFormat.type,
        originalSize: input.data.byteLength,
      })
    } catch (error) {
      if (error instanceof CliError) throw error
      throw new CliError('INPUT_NOT_IMAGE', 'An input is not a readable supported image.')
    } finally {
      image?.dispose()
    }
  }

  await transactions.commitOutputs(results)
  return createResult(operation, 'imagemagick.wasm', results)
}

const applyImageOperation = (magick, operation, image, plan) => {
  if (operation === 'image-compress') {
    if (plan.aspectRatio) {
      const crop = normalizeCrop({ aspectRatio: plan.aspectRatio }, image.width, image.height)
      image.crop(new magick.MagickGeometry(crop.x, crop.y, crop.width, crop.height)); image.resetPage()
    }
    if (plan.width !== undefined || plan.height !== undefined) {
      const width = integerInRange(plan.width ?? Math.round(image.width * Number(plan.height) / image.height), 1, 8000, 1280, 'width')
      const height = integerInRange(plan.height ?? Math.round(image.height * width / image.width), 1, 8000, 1280, 'height')
      if (plan.keepAspectRatio === false) resizeImageExactly(magick, image, width, height)
      else image.resize(width, height, magick.FilterType.Lanczos)
    } else {
      const maxEdge = integerInRange(plan.maxEdge, 240, 6000, 1920, 'maxEdge')
      resizeToContain(image, maxEdge, maxEdge, magick)
    }
    return
  }
  if (operation === 'image-resize') {
    const mode = enumValue(plan.mode || plan.resizeMode, ['max-edge', 'width', 'height', 'percent'], 'max-edge', 'mode')
    const value = numberInRange(plan.value ?? plan.resizeValue, 1, 8000, 1280, 'value')
    const { width, height } = calculateResize(image.width, image.height, mode, value)
    image.resize(width, height, magick.FilterType.Lanczos)
    return
  }
  if (operation === 'image-crop') {
    const crop = normalizeCrop(plan, image.width, image.height)
    image.crop(new magick.MagickGeometry(crop.x, crop.y, crop.width, crop.height))
    image.resetPage()
    return
  }
  if (operation === 'image-rotate-flip') {
    const rotation = enumNumber(plan.rotation, [0, 90, 180, 270], 0, 'rotation')
    if (rotation) image.rotate(rotation)
    if (plan.flipHorizontal) image.flop()
    if (plan.flipVertical) image.flip()
    return
  }
  if (operation === 'image-privacy-mask') {
    applyPrivacyMask(magick, image, plan)
    return
  }
  if (operation === 'image-watermark') {
    applyTextWatermark(magick, image, plan)
    return
  }
  if (operation === 'image-border-radius') {
    applyBorderAndRadius(magick, image, plan)
  }
}

const prepareImageForWrite = (magick, image, outputFormat, plan) => {
  image.strip()
  image.quality = Math.round(numberInRange(plan.quality, 0.1, 1, 0.9, 'quality') * 100)
  if (outputFormat.type === 'image/jpeg' && !image.isOpaque) {
    const flattened = magick.MagickImage.create(magick.MagickColors.White, image.width, image.height)
    try {
      flattened.composite(image, magick.CompositeOperator.Over)
      image.read(flattened.write(magick.MagickFormat.Png, (bytes) => bytes))
    } finally {
      flattened.dispose()
    }
  }
}

const applyPrivacyMask = (magick, image, plan) => {
  const selection = normalizeSelection(plan.selection, image.width, image.height)
  const mode = enumValue(plan.mode, ['solid', 'blur', 'pixelate'], 'solid', 'mode')
  if (mode === 'solid') {
    const color = colorWithOpacity(plan.color || '#111827', numberInRange(plan.opacity, 0.1, 1, 0.9, 'opacity'))
    new magick.Drawables()
      .fillColor(new magick.MagickColor(color))
      .strokeColor(new magick.MagickColor(color))
      .rectangle(selection.x, selection.y, selection.x + selection.width, selection.y + selection.height)
      .draw(image)
    return
  }

  image.cloneArea(
    new magick.MagickGeometry(selection.x, selection.y, selection.width, selection.height),
    (area) => {
      if (mode === 'blur') area.gaussianBlur(0, 14)
      else {
        const smallWidth = Math.max(1, Math.round(selection.width / 14))
        const smallHeight = Math.max(1, Math.round(selection.height / 14))
        area.resize(smallWidth, smallHeight, magick.FilterType.Point)
        area.resize(selection.width, selection.height, magick.FilterType.Point)
      }
      image.composite(area, magick.CompositeOperator.Over, new magick.Point(selection.x, selection.y))
    },
  )
}

const applyTextWatermark = (magick, image, plan) => {
  const text = String(plan.text || 'Baimiao PDF').trim()
  if (!text || text.length > 200) throw new CliError('INVALID_PLAN', 'Watermark text must contain 1 to 200 characters.')
  const fontSize = integerInRange(plan.textSize, 12, Math.max(image.width, image.height), 48, 'textSize')
  const opacity = numberInRange(plan.opacity, 0.05, 1, 0.12, 'opacity')
  const color = colorWithOpacity(plan.color || '#808080', opacity)
  const angle = numberInRange(plan.angle, -180, 180, -30, 'angle')
  const pattern = enumValue(plan.pattern, ['single', 'tile', 'mosaic'], 'single', 'pattern')
  const metricsDrawer = new magick.Drawables()
    .font('BaimiaoNotoSans')
    .fontPointSize(fontSize)
    .fillColor(new magick.MagickColor(color))
  const metrics = metricsDrawer.fontTypeMetrics(text)
  if (!metrics) throw new CliError('PROCESSING_FAILED', 'The bundled watermark font could not measure the text.')
  const padding = Math.max(12, Math.ceil(fontSize * 0.5))
  const label = magick.MagickImage.create(
    magick.MagickColors.Transparent,
    Math.max(1, Math.ceil(metrics.textWidth + padding * 2)),
    Math.max(1, Math.ceil(metrics.textHeight + padding * 2)),
  )
  try {
    new magick.Drawables()
      .font('BaimiaoNotoSans')
      .fontPointSize(fontSize)
      .fillColor(new magick.MagickColor(color))
      .text(padding, padding + metrics.ascent, text)
      .draw(label)
    if (angle) label.rotate(angle)
    if (pattern === 'single') {
      const point = watermarkPoint(plan.position, image.width, image.height, label.width, label.height)
      image.composite(label, magick.CompositeOperator.Over, new magick.Point(point.x, point.y))
      return
    }
    const gapX = Math.max(label.width + fontSize * 2, Math.round(image.width * 0.25))
    const gapY = Math.max(label.height + fontSize * 2, Math.round(image.height * 0.2))
    for (let y = -label.height; y < image.height + label.height; y += gapY) {
      const offset = Math.floor(y / gapY) % 2 ? Math.round(gapX / 2) : 0
      for (let x = -label.width + offset; x < image.width + label.width; x += gapX) {
        image.composite(label, magick.CompositeOperator.Over, new magick.Point(x, y))
      }
    }
  } finally {
    label.dispose()
  }
}

const applyBorderAndRadius = (magick, image, plan) => {
  const borderWidth = integerInRange(plan.borderWidth, 0, 512, 0, 'borderWidth')
  const radius = integerInRange(plan.borderRadius, 0, Math.max(image.width, image.height), 24, 'borderRadius')
  const targetWidth = image.width + borderWidth * 2
  const targetHeight = image.height + borderWidth * 2
  const rgba = image.getPixels((pixels) => pixels.toByteArray(0, 0, image.width, image.height, 'RGBA'))
  if (!rgba) throw new CliError('PROCESSING_FAILED', 'The image pixels could not be read.')
  const output = new Uint8Array(targetWidth * targetHeight * 4)
  const border = parseHexColor(plan.borderColor || '#ffffff')
  for (let index = 0; index < output.length; index += 4) {
    output[index] = border.r
    output[index + 1] = border.g
    output[index + 2] = border.b
    output[index + 3] = border.a
  }
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (!insideRoundedRect(x, y, image.width, image.height, radius)) continue
      const source = (y * image.width + x) * 4
      const target = ((y + borderWidth) * targetWidth + x + borderWidth) * 4
      output.set(rgba.subarray(source, source + 4), target)
    }
  }
  const replacement = magick.MagickImage.create(output, new magick.MagickReadSettings({
    depth: 8,
    format: magick.MagickFormat.Rgba,
    height: targetHeight,
    width: targetWidth,
  }))
  try {
    image.read(replacement.write(magick.MagickFormat.Png, (bytes) => bytes))
  } finally {
    replacement.dispose()
  }
}

const convertImagesToGif = async (inputs, outputPath, plan, transactions) => {
  const magick = await loadMagick()
  const maxEdge = integerInRange(plan.maxEdge, 64, 1920, 720, 'maxEdge')
  const delayMs = integerInRange(plan.delayMs, 20, 60_000, 500, 'delayMs')
  const repeat = integerInRange(plan.repeat, 0, 65_535, 0, 'repeat')
  const loaded = []
  const collection = magick.MagickImageCollection.create()
  try {
    for (const input of inputs) {
      const image = magick.MagickImage.create(input.data)
      image.autoOrient()
      resizeToContain(image, maxEdge, maxEdge, magick)
      loaded.push(image)
    }
    const width = Math.max(...loaded.map((image) => image.width))
    const height = Math.max(...loaded.map((image) => image.height))
    for (const image of loaded) {
      image.backgroundColor = magick.MagickColors.White
      image.extent(width, height, magick.Gravity.Center, magick.MagickColors.White)
      image.animationDelay = Math.max(1, Math.round(delayMs / 10))
      image.animationTicksPerSecond = 100
      image.animationIterations = repeat
      collection.push(image)
    }
    collection.optimizeTransparency()
    const data = collection.write(magick.MagickFormat.Gif, (bytes) => new Uint8Array(bytes))
    const resolvedOutput = await transactions.resolveOutputPath(outputPath)
    const results = [{ data, path: resolvedOutput, type: 'image/gif' }]
    await transactions.commitOutputs(results)
    return createResult('image-to-gif', 'imagemagick.wasm', results)
  } catch (error) {
    if (error instanceof CliError) throw error
    throw new CliError('INPUT_NOT_IMAGE', 'Every GIF source must be a readable image.')
  } finally {
    collection.dispose()
  }
}

const extractGifFrames = async (input, outputDirPath, plan, transactions) => {
  const magick = await loadMagick()
    const outputDirectory = await transactions.resolveOutputDirectory(outputDirPath)
  const outputFormat = normalizeOutputFormat(plan.format || plan.outputType, 'png')
  let frames
  try {
    frames = magick.MagickImageCollection.create(input.data)
    if (frames.length < 1 || !['GIF', 'APNG', 'WEBP'].includes(frames[0].format)) {
      throw new Error('not animated')
    }
    frames.coalesce()
    const results = []
    for (const [index, frame] of frames.entries()) {
      prepareImageForWrite(magick, frame, outputFormat, plan)
      const data = frame.write(magick.MagickFormat[outputFormat.format], (bytes) => new Uint8Array(bytes))
      results.push({
        data,
        path: await transactions.resolveOutputPath(path.join(
          outputDirectory,
          `${basenameWithoutExtension(input.path)}-frame-${String(index + 1).padStart(4, '0')}.${outputFormat.extension}`,
        )),
        type: outputFormat.type,
      })
    }
    await transactions.commitOutputs(results)
    return createResult('gif-to-images', 'imagemagick.wasm', results)
  } catch (error) {
    if (error instanceof CliError) throw error
    throw new CliError('INPUT_NOT_GIF', 'The input is not a readable animated image.')
  } finally {
    frames?.dispose()
  }
}

const convertVideoToGif = async (input, outputPath, plan, transactions) => {
  const ffmpeg = await loadFfmpeg()
    const resolvedOutput = await transactions.resolveOutputPath(outputPath)
  const fps = integerInRange(plan.fps, 1, 30, 10, 'fps')
  const maxEdge = integerInRange(plan.maxEdge, 64, 1920, 720, 'maxEdge')
  const startSeconds = numberInRange(plan.startSeconds, 0, 86_400, 0, 'startSeconds')
  const endSeconds = plan.endSeconds === undefined ? null : numberInRange(plan.endSeconds, 0.01, 86_400, 5, 'endSeconds')
  if (endSeconds !== null && endSeconds <= startSeconds) {
    throw new CliError('INVALID_PLAN', 'endSeconds must be greater than startSeconds.')
  }
  const inputName = `input-${randomUUID()}${path.extname(input.path) || '.video'}`
  const outputName = `output-${randomUUID()}.gif`
  ffmpeg.FS.writeFile(inputName, input.data)
  try {
    const args = ['-ss', String(startSeconds), '-i', inputName]
    if (endSeconds !== null) args.push('-t', String(endSeconds - startSeconds))
    args.push(
      '-vf',
      `fps=${fps},scale=w='min(${maxEdge}\\,iw)':h='min(${maxEdge}\\,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos`,
      '-loop',
      String(integerInRange(plan.repeat, 0, 65_535, 0, 'repeat')),
      outputName,
    )
    ffmpeg.reset()
    const exitCode = ffmpeg.exec(...args)
    if (exitCode !== 0) throw new Error(`ffmpeg exited with ${exitCode}`)
    const data = new Uint8Array(ffmpeg.FS.readFile(outputName))
    if (!data.byteLength) throw new Error('empty output')
    const results = [{ data, path: resolvedOutput, type: 'image/gif' }]
    await transactions.commitOutputs(results)
    return createResult('video-to-gif', 'ffmpeg.wasm', results)
  } catch {
    throw new CliError('INPUT_NOT_VIDEO', 'The input is not a supported readable video.')
  } finally {
    try { ffmpeg.FS.unlink(inputName) } catch { /* The virtual input may already be gone. */ }
    try { ffmpeg.FS.unlink(outputName) } catch { /* FFmpeg may fail before creating output. */ }
  }
}

const renderPdfToImages = async (input, outputDirPath, plan, transactions) => {
  assertPdfInput(input)
  const outputDirectory = await transactions.resolveOutputDirectory(outputDirPath)
  const outputFormat = normalizeOutputFormat(plan.format || plan.outputType, 'png')
  const dpi = integerInRange(plan.dpi, 36, 600, 144, 'dpi')
  const pdfium = await loadPdfium()
  const document = openPdfiumDocument(pdfium, input.data, '')
  try {
    const pageCount = pdfium.FPDF_GetPageCount(document.handle)
    const pages = normalizePageSelection(plan.pages, pageCount)
    const results = []
    for (const pageNumber of pages) {
      const rendered = renderPdfiumPage(pdfium, document.handle, pageNumber - 1, dpi)
      try {
        const magick = await loadMagick()
        const image = magick.MagickImage.create(rendered.data, new magick.MagickReadSettings({
          depth: 8,
          format: magick.MagickFormat.Bgra,
          height: rendered.height,
          width: rendered.width,
        }))
        try {
          prepareImageForWrite(magick, image, outputFormat, plan)
          const data = image.write(magick.MagickFormat[outputFormat.format], (bytes) => new Uint8Array(bytes))
          results.push({
            data,
            path: await transactions.resolveOutputPath(path.join(
              outputDirectory,
              `${basenameWithoutExtension(input.path)}-page-${String(pageNumber).padStart(4, '0')}.${outputFormat.extension}`,
            )),
            type: outputFormat.type,
          })
        } finally {
          image.dispose()
        }
      } finally {
        rendered.dispose()
      }
    }
    await transactions.commitOutputs(results)
    return createResult('pdf-to-images', 'pdfium.wasm+imagemagick.wasm', results)
  } finally {
    closePdfiumDocument(pdfium, document)
  }
}

const compressPdfLossy = async (input, outputPath, plan, transactions) => {
  assertPdfInput(input)
  const resolvedOutput = await transactions.resolveOutputPath(outputPath)
  const { compressPdfWithTarget } = await import('./target-compression.mjs')
  const result = await compressPdfWithTarget(input.data, plan)
  const outputs = [{
    data: result.data,
    path: resolvedOutput,
    type: 'application/pdf',
    metadata: result.metadata,
  }]
  await transactions.commitOutputs(outputs)
  return createResult('compress-lossy', result.backend, outputs)
}

const removeImageBackgrounds = async (inputs, outputDirPath, plan, transactions) => {
  const precision = normalizeRembgPrecision(plan.precision)
  const outputDirectory = await transactions.resolveOutputDirectory(outputDirPath)
  const magick = await loadMagick()
  const ort = await loadOrt()
  const modelFilename = precision === 'fp32' ? 'rmbg-1.4-fp32.onnx' : 'rmbg-1.4-quantized.onnx'
  const model = await readFile(await ensureRuntimeFile(modelFilename))
  const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] })
  const inputName = session.inputNames[0]
  const outputName = session.outputNames[0]
  const results = []
  try {
    for (const input of inputs) {
      let source
      try {
        source = magick.MagickImage.create(input.data)
        source.autoOrient()
      } catch {
        throw new CliError('INPUT_NOT_IMAGE', 'An input is not a readable supported image.')
      }
      try {
        const modelImage = source.clone((image) => {
          resizeImageExactly(magick, image, 1024, 1024)
          return image.getPixels((pixels) => pixels.toByteArray(0, 0, 1024, 1024, 'RGB'))
        })
        if (!modelImage) throw new CliError('PROCESSING_FAILED', 'The image pixels could not be prepared.')
        const tensorData = new Float32Array(3 * 1024 * 1024)
        const plane = 1024 * 1024
        for (let index = 0; index < plane; index += 1) {
          tensorData[index] = modelImage[index * 3] / 255 - 0.5
          tensorData[plane + index] = modelImage[index * 3 + 1] / 255 - 0.5
          tensorData[plane * 2 + index] = modelImage[index * 3 + 2] / 255 - 0.5
        }
        const prediction = await session.run({
          [inputName]: new ort.Tensor('float32', tensorData, [1, 3, 1024, 1024]),
        })
        const output = prediction[outputName]
        const mask = normalizeMask(output.data)
        const maskImage = magick.MagickImage.create(mask, new magick.MagickReadSettings({
          depth: 8,
          format: magick.MagickFormat.Gray,
          height: output.dims.at(-2),
          width: output.dims.at(-1),
        }))
        try {
          resizeImageExactly(magick, maskImage, source.width, source.height)
          const rgba = source.getPixels((pixels) => pixels.toByteArray(0, 0, source.width, source.height, 'RGBA'))
          const alpha = maskImage.getPixels((pixels) => pixels.toByteArray(0, 0, source.width, source.height, 'R'))
          if (!rgba || !alpha) throw new CliError('PROCESSING_FAILED', 'The background mask could not be applied.')
          for (let pixel = 0; pixel < alpha.length; pixel += 1) rgba[pixel * 4 + 3] = alpha[pixel]
          const resultImage = magick.MagickImage.create(rgba, new magick.MagickReadSettings({
            depth: 8,
            format: magick.MagickFormat.Rgba,
            height: source.height,
            width: source.width,
          }))
          try {
            resultImage.strip()
            const data = resultImage.write(magick.MagickFormat.Png, (bytes) => new Uint8Array(bytes))
            results.push({
              data,
              path: await transactions.resolveOutputPath(path.join(
                outputDirectory,
                `${basenameWithoutExtension(input.path)}-rembg.png`,
              )),
              type: 'image/png',
            })
          } finally {
            resultImage.dispose()
          }
        } finally {
          maskImage.dispose()
        }
      } finally {
        source.dispose()
      }
    }
  } finally {
    await session.release()
  }
  await transactions.commitOutputs(results)
  return createResult('image-rembg', `onnxruntime.wasm+rmbg-1.4-${precision}+imagemagick.wasm`, results)
}

const normalizeRembgPrecision = (value) => {
  const precision = value ?? 'fp32'
  if (precision !== 'fp32' && precision !== 'quint8') {
    throw new CliError('INVALID_PLAN', 'image-rembg precision must be fp32 or quint8.')
  }
  return precision
}

const resizeImageExactly = (magick, image, width, height) => {
  const geometry = new magick.MagickGeometry(width, height)
  geometry.ignoreAspectRatio = true
  image.resize(geometry, magick.FilterType.Lanczos)
}

const loadMagick = async ({ font = false } = {}) => {
  if (!magickPromise) {
    magickPromise = (async () => {
      const files = await ensureRuntimeBundle('magick')
      const module = await import(pathToFileURL(files['magick.mjs']))
      await module.initializeImageMagick(await readFile(files['magick.wasm']))
      return module
    })()
  }
  const module = await magickPromise
  if (font) await loadMagickFont(module)
  return module
}

const loadMagickFont = async (magick) => {
  if (!magickFontPromise) {
    magickFontPromise = (async () => {
      const font = await ensureRuntimeFile('NotoSansCJKsc-Regular.otf')
      magick.Magick.addFont('BaimiaoNotoSans', await readFile(font))
    })()
  }
  return magickFontPromise
}

const loadPdfium = async () => {
  if (!pdfiumPromise) {
    pdfiumPromise = (async () => {
      const files = await ensureRuntimeBundle('pdfium')
      const { init } = await import(pathToFileURL(files['pdfium.mjs']))
      const module = await init({ wasmBinary: await readFile(files['pdfium.wasm']) })
      module.FPDF_InitLibrary()
      return module
    })()
  }
  return pdfiumPromise
}

const loadFfmpeg = async () => {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      globalThis.self ||= { location: { href: import.meta.url } }
      globalThis.self.location ||= { href: import.meta.url }
      const files = await ensureRuntimeBundle('ffmpeg')
      const { default: createFfmpegCore } = await import(pathToFileURL(files['ffmpeg-core.mjs']))
      return createFfmpegCore({ wasmBinary: await readFile(files['ffmpeg-core.wasm']) })
    })()
  }
  return ffmpegPromise
}

const loadOrt = async () => {
  if (!ortPromise) {
    ortPromise = (async () => {
      const files = await ensureRuntimeBundle('ort')
      const module = await import(pathToFileURL(files['ort.wasm.mjs']))
      module.env.wasm.numThreads = 1
      module.env.wasm.proxy = false
      module.env.wasm.wasmPaths = {
        wasm: pathToFileURL(files['ort-wasm-simd-threaded.wasm']).href,
        mjs: pathToFileURL(files['ort-wasm-simd-threaded.mjs']).href,
      }
      return module
    })()
  }
  return ortPromise
}

const openPdfiumDocument = (pdfium, data, password) => {
  const pointer = pdfium.pdfium.wasmExports.malloc(data.byteLength)
  pdfium.pdfium.HEAPU8.set(data, pointer)
  const handle = pdfium.FPDF_LoadMemDocument64(pointer, data.byteLength, password)
  if (!handle) {
    pdfium.pdfium.wasmExports.free(pointer)
    const error = pdfium.FPDF_GetLastError()
    throw new CliError(error === 4 ? 'PASSWORD_REQUIRED' : 'INPUT_NOT_PDF', 'The PDF could not be opened.', { pdfiumError: error })
  }
  return { handle, pointer }
}

const closePdfiumDocument = (pdfium, document) => {
  pdfium.FPDF_CloseDocument(document.handle)
  pdfium.pdfium.wasmExports.free(document.pointer)
}

const renderPdfiumPage = (pdfium, document, pageIndex, dpi) => {
  const page = pdfium.FPDF_LoadPage(document, pageIndex)
  if (!page) throw new CliError('PROCESSING_FAILED', 'A selected PDF page could not be loaded.')
  const width = Math.max(1, Math.round((pdfium.FPDF_GetPageWidthF(page) * dpi) / 72))
  const height = Math.max(1, Math.round((pdfium.FPDF_GetPageHeightF(page) * dpi) / 72))
  if (width * height > 100_000_000) {
    pdfium.FPDF_ClosePage(page)
    throw new CliError('INVALID_PLAN', 'The selected DPI would create a page larger than 100 megapixels.')
  }
  const bitmap = pdfium.FPDFBitmap_Create(width, height, 1)
  if (!bitmap) {
    pdfium.FPDF_ClosePage(page)
    throw new CliError('PROCESSING_FAILED', 'A PDF render bitmap could not be allocated.')
  }
  pdfium.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff)
  pdfium.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, 0x01 | 0x02)
  const pointer = pdfium.FPDFBitmap_GetBuffer(bitmap)
  const stride = pdfium.FPDFBitmap_GetStride(bitmap)
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    data.set(pdfium.pdfium.HEAPU8.subarray(pointer + y * stride, pointer + y * stride + width * 4), y * width * 4)
  }
  return {
    data,
    width,
    height,
    dispose() {
      pdfium.FPDFBitmap_Destroy(bitmap)
      pdfium.FPDF_ClosePage(page)
    },
  }
}

const resolveRegularInput = async (inputPath) => {
  if (!path.isAbsolute(inputPath)) throw new CliError('INVALID_ARGUMENT', 'Input paths must be absolute.')
  try {
    const resolved = await realpath(inputPath)
    const info = await stat(resolved)
    if (!info.isFile() || info.size < 1) throw new Error('not a file')
    return { path: resolved, data: await readFile(resolved) }
  } catch {
    throw new CliError('INPUT_NOT_FOUND', 'An input file does not exist or cannot be read.')
  }
}

const createResult = (operation, backend, outputs) => ({
  ok: true,
  operation,
  backend,
  outputs: outputs.map((output) => ({
    path: output.path,
    type: output.type,
    size: output.data.byteLength,
    nextOperations: localResultHandoffs(output.type).filter(name => name !== operation),
    ...(output.originalSize ? { originalSize: output.originalSize } : {}),
    ...(output.metadata ? { metadata: output.metadata } : {}),
  })),
})

const normalizeOutputFormat = (value, fallback) => {
  const normalized = String(value || fallback).toLowerCase().replace('image/', '')
  const format = OUTPUT_FORMATS[normalized]
  if (!format) throw new CliError('INVALID_PLAN', 'format must be png, jpeg, or webp.')
  return format
}

const normalizeCrop = (plan, width, height) => {
  if (plan.crop || ['x', 'y', 'width', 'height'].some((key) => plan[key] !== undefined)) {
    const crop = plan.crop || plan
    const x = integerInRange(crop.x, 0, width - 1, 0, 'crop.x')
    const y = integerInRange(crop.y, 0, height - 1, 0, 'crop.y')
    return {
      x,
      y,
      width: integerInRange(crop.width, 1, width - x, width - x, 'crop.width'),
      height: integerInRange(crop.height, 1, height - y, height - y, 'crop.height'),
    }
  }
  const ratio = parseAspectRatio(plan.aspectRatio || '1:1')
  const sourceRatio = width / height
  if (sourceRatio > ratio) {
    const cropWidth = Math.max(1, Math.round(height * ratio))
    return { x: Math.round((width - cropWidth) / 2), y: 0, width: cropWidth, height }
  }
  const cropHeight = Math.max(1, Math.round(width / ratio))
  return { x: 0, y: Math.round((height - cropHeight) / 2), width, height: cropHeight }
}

const normalizeSelection = (selection, width, height) => {
  const source = selection || {}
  const fallbackWidth = Math.max(1, Math.round(width * 0.48))
  const fallbackHeight = Math.max(1, Math.round(Math.min(width, height) * 0.28))
  const x = integerInRange(source.x, 0, width - 1, Math.round((width - fallbackWidth) / 2), 'selection.x')
  const y = integerInRange(source.y, 0, height - 1, Math.round((height - fallbackHeight) / 2), 'selection.y')
  return {
    x,
    y,
    width: integerInRange(source.width, 1, width - x, Math.min(fallbackWidth, width - x), 'selection.width'),
    height: integerInRange(source.height, 1, height - y, Math.min(fallbackHeight, height - y), 'selection.height'),
  }
}

const calculateResize = (width, height, mode, value) => {
  if (mode === 'percent') {
    const scale = value / 100
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
  }
  if (mode === 'width') return { width: Math.round(value), height: Math.max(1, Math.round((height * value) / width)) }
  if (mode === 'height') return { width: Math.max(1, Math.round((width * value) / height)), height: Math.round(value) }
  const scale = Math.min(1, value / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

const calculateOcrSize = (width, height) => {
  const longerSide = Math.max(width, height)
  const shorterSide = Math.min(width, height)
  const scale = longerSide / shorterSide > 16
    ? Math.min(1, 16384 / longerSide)
    : Math.min(1, 1024 / shorterSide)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

const resizeToContain = (image, maxWidth, maxHeight, magick) => {
  const scale = Math.min(1, maxWidth / image.width, maxHeight / image.height)
  if (scale < 1) image.resize(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)), magick.FilterType.Lanczos)
}

const normalizePageSelection = (pages, pageCount) => {
  if (pages === undefined) return Array.from({ length: pageCount }, (_, index) => index + 1)
  if (!Array.isArray(pages) || !pages.length) throw new CliError('INVALID_PLAN', 'pages must be a non-empty array.')
  const selected = []
  for (const value of pages) {
    if (Number.isSafeInteger(value)) selected.push(value)
    else if (value && Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end) && value.start <= value.end) {
      selected.push(...Array.from({ length: value.end - value.start + 1 }, (_, index) => value.start + index))
    } else throw new CliError('INVALID_PLAN', 'pages entries must be page numbers or {start,end} ranges.')
  }
  if (selected.some((page) => page < 1 || page > pageCount)) throw new CliError('INVALID_PAGE_RANGE', 'A selected page is outside the PDF.', { pageCount })
  return [...new Set(selected)]
}

const normalizeMask = (values) => {
  let minimum = Infinity
  let maximum = -Infinity
  for (const value of values) {
    if (value < minimum) minimum = value
    if (value > maximum) maximum = value
  }
  const range = maximum - minimum || 1
  const mask = new Uint8Array(values.length)
  for (let index = 0; index < values.length; index += 1) mask[index] = Math.max(0, Math.min(255, Math.round(((values[index] - minimum) / range) * 255)))
  return mask
}

const watermarkPoint = (position, width, height, labelWidth, labelHeight) => {
  const margin = Math.max(12, Math.round(Math.min(width, height) * 0.05))
  const points = {
    'top-left': [margin, margin],
    'top-center': [(width - labelWidth) / 2, margin],
    'top-right': [width - labelWidth - margin, margin],
    'center-left': [margin, (height - labelHeight) / 2],
    center: [(width - labelWidth) / 2, (height - labelHeight) / 2],
    'center-right': [width - labelWidth - margin, (height - labelHeight) / 2],
    'bottom-left': [margin, height - labelHeight - margin],
    'bottom-center': [(width - labelWidth) / 2, height - labelHeight - margin],
    'bottom-right': [width - labelWidth - margin, height - labelHeight - margin],
  }
  const point = points[position] || points['bottom-right']
  return { x: Math.round(point[0]), y: Math.round(point[1]) }
}

const insideRoundedRect = (x, y, width, height, radius) => {
  const r = Math.min(radius, width / 2, height / 2)
  if (!r) return true
  const cx = x < r ? r : x >= width - r ? width - r - 1 : x
  const cy = y < r ? r : y >= height - r ? height - r - 1 : y
  return (x - cx) ** 2 + (y - cy) ** 2 <= r ** 2
}

const colorWithOpacity = (color, opacity) => {
  const parsed = parseHexColor(color)
  return `rgba(${parsed.r},${parsed.g},${parsed.b},${opacity})`
}

const parseHexColor = (value) => {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(value || ''))
  if (!match) throw new CliError('INVALID_PLAN', 'Colors must use #RRGGBB or #RRGGBBAA.')
  return {
    r: Number.parseInt(match[1].slice(0, 2), 16),
    g: Number.parseInt(match[1].slice(2, 4), 16),
    b: Number.parseInt(match[1].slice(4, 6), 16),
    a: match[2] ? Number.parseInt(match[2], 16) : 255,
  }
}

const parseAspectRatio = (value) => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(value))
  if (!match || Number(match[2]) <= 0) throw new CliError('INVALID_PLAN', 'aspectRatio must use a value such as 1:1 or 16:9.')
  return Number(match[1]) / Number(match[2])
}

const numberInRange = (value, minimum, maximum, fallback, name) => {
  if (value === undefined || value === null || value === '') {
    if (!Number.isFinite(fallback)) throw new CliError('INVALID_PLAN', `${name} is required.`)
    return fallback
  }
  const number = Number(value)
  if (!Number.isFinite(number) || number < minimum || number > maximum) throw new CliError('INVALID_PLAN', `${name} must be between ${minimum} and ${maximum}.`)
  return number
}

const integerInRange = (value, minimum, maximum, fallback, name) => Math.round(numberInRange(value, minimum, maximum, fallback, name))

const enumValue = (value, allowed, fallback, name) => {
  if (value === undefined) return fallback
  if (!allowed.includes(value)) throw new CliError('INVALID_PLAN', `${name} must be one of: ${allowed.join(', ')}.`)
  return value
}

const enumNumber = (value, allowed, fallback, name) => enumValue(value === undefined ? undefined : Number(value), allowed, fallback, name)

const assertPdfInput = (input) => {
  if (!input.data.subarray(0, Math.min(input.data.length, 1024)).includes('%PDF-')) throw new CliError('INPUT_NOT_PDF', 'The input does not contain a PDF header.')
}

const rejectDuplicateInputs = (inputs) => {
  if (new Set(inputs.map((input) => input.path)).size !== inputs.length) throw new CliError('INVALID_ARGUMENT', 'Duplicate input files are not allowed.')
}

const basenameWithoutExtension = (file) => path.basename(file, path.extname(file)) || 'output'

const operationSuffix = (operation) => ({
  'image-border-radius': 'decorated',
  'image-compress': 'compressed',
  'image-convert': 'converted',
  'heic-convert': 'converted',
  'image-crop': 'cropped',
  'image-privacy-mask': 'masked',
  'image-resize': 'resized',
  'image-rotate-flip': 'transformed',
  'image-watermark': 'watermarked',
}[operation] || 'processed')

export { loadMagick, loadOrt, loadPdfium, loadFfmpeg, openPdfiumDocument, closePdfiumDocument, renderPdfiumPage, normalizePageSelection, resolveRegularInput, createResult, resizeImageExactly, numberInRange, integerInRange, enumValue, prepareImageForWrite, normalizeOutputFormat }

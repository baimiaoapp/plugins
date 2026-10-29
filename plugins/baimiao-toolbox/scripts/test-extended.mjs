import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { executeLocalOperation } from '../skills/baimiao-local-media/scripts/baimiao.mjs'
import { loadMagick } from '../skills/baimiao-local-media/scripts/media-node-adapter.mjs'
import { PDFDocument, PDFName } from '../skills/baimiao-local-media/assets/pdf-lib/pdf-lib.mjs'

const directory = await mkdtemp(path.join(os.tmpdir(), 'baimiao-extended-'))
let checks = 0
const run = async (operation, input, plan = {}, outputKind = 'file') => {
  const index = checks++
  const planPath = path.join(directory, `${index}.json`)
  await writeFile(planPath, JSON.stringify(plan))
  const output = path.join(directory, `${index}-output${operation === 'cutout-motion' ? '.mp4' : '.pdf'}`)
  if (outputKind === 'dir') await mkdir(output)
  const result = await executeLocalOperation([operation, ...[input].flat().flatMap(p => ['--input', p]), '--plan', planPath,
    ...(outputKind === 'none' ? [] : [outputKind === 'dir' ? '--output-dir' : '--output', output])])
  assert.equal(result.ok, true)
  for (const file of result.outputs) assert.equal((await readFile(file.path)).length, file.size)
  return result
}
try {
  const m = await loadMagick()
  const img = m.MagickImage.create(m.MagickColors.White, 64, 48)
  new m.Drawables().fillColor(m.MagickColors.Red).rectangle(16, 12, 48, 36).draw(img)
  const imagePath = path.join(directory, 'source.png')
  await writeFile(imagePath, img.write(m.MagickFormat.Png, b => new Uint8Array(b))); img.dispose()
  const original = await readFile(imagePath)
  for (const mode of ['original', 'colour', 'colourSharp', 'gray', 'bw', 'bwSharp']) {
    const result = await run('document-scan', imagePath, { detector: 'none', mode }, 'dir')
    assert.equal(result.outputs[0].metadata.width, 64)
  }
  const scan = await run('document-scan-pdf', imagePath, { detector: 'none', corners: [[0.1,0.1],[0.9,0.05],[0.95,0.95],[0.05,0.9]] })
  assert.equal((await PDFDocument.load(await readFile(scan.outputs[0].path))).getPageCount(), 1)
  const compressed = await run('image-compress', imagePath, { targetBytes: 10000, format: 'jpeg', width: 32, height: 24 }, 'dir')
  assert.equal(compressed.outputs[0].metadata.targetMet, true)
  assert.equal(compressed.outputs[0].metadata.width, 32)
  const missed = await run('image-compress', imagePath, { targetBytes: 1, format: 'png' }, 'dir')
  assert.equal(missed.outputs[0].metadata.targetMet, false)
  const doc = await PDFDocument.create(), page = doc.addPage([200, 300])
  page.drawText('Keep this text', { x: 10, y: 100, size: 10 })
  const annotation = doc.context.obj({ Type: 'Annot', Subtype: 'Watermark', Rect: [0,0,100,100] })
  page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(annotation)]))
  const pdf = path.join(directory, 'watermark.pdf'); await writeFile(pdf, await doc.save())
  const analysis = await run('pdf-analyze-watermarks', pdf, {}, 'none')
  assert(analysis.candidates.length > 0)
  const removed = await run('pdf-remove-watermark', pdf)
  assert.equal(removed.outputs[0].metadata.removedCount, 1)
  const raster = await run('pdf-to-scanned', pdf, { dpi: 144 })
  assert.deepEqual((await PDFDocument.load(await readFile(raster.outputs[0].path))).getPages()[0].getSize(), { width: 200, height: 300 })
  const target = await run('compress-lossy', pdf, { targetBytes: 1 })
  assert.equal(target.outputs[0].metadata.targetMet, false)
  const rasterTarget = await run('compress-lossy', pdf, { targetBytes: 1, mode: 'raster', dpi: 144 })
  assert.equal(rasterTarget.outputs[0].metadata.targetMet, false)
  const mask = m.MagickImage.create(m.MagickColors.White, 64, 48)
  const maskPath = path.join(directory, 'mask.png'); await writeFile(maskPath, mask.write(m.MagickFormat.Png, b => new Uint8Array(b))); mask.dispose()
  const cut = await run('image-smart-cutout', imagePath, { maskPath, saveMask: true, brushes: [{ x:0.5, y:0.5, radius:0.2, mode:'erase' }] }, 'dir')
  assert.equal(cut.outputs.length, 2)
  const cutImage = m.MagickImage.create(await readFile(cut.outputs[0].path))
  assert.equal(cutImage.getPixels(p => p.toByteArray(32,24,1,1,'RGBA'))[3], 0); cutImage.dispose()
  const motion = await run('cutout-motion', imagePath, { objects: [{ maskPath, effect: 'swing' }], duration: 0.25, fps: 4, maxEdge: 64 })
  assert((await readFile(motion.outputs[0].path)).subarray(0,32).includes('ftyp'))
  const lighting = await run('cutout-motion', imagePath, { format:'gif', objects:[{ maskPath, outline:'double', glow:'sweep' }, { maskPath, glow:'exposure', phase:90, opacity:0.5 }], duration:1, fps:4, maxEdge:64 })
  const frames = m.MagickImageCollection.create(await readFile(lighting.outputs[0].path))
  try {
    frames.coalesce()
    assert.equal(frames.length, 4)
    const first = frames[0].getPixels(p => new Uint8Array(p.toByteArray(0,0,64,48,'RGB')))
    const last = frames[2].getPixels(p => new Uint8Array(p.toByteArray(0,0,64,48,'RGB')))
    assert.notDeepEqual(first, last)
  } finally { frames.dispose() }

  for (const [operation, name] of [['word-to-pdf','sample.docx'],['pptx-to-pdf','sample.pptx']]) {
    const result = await run(operation, fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)))
    assert.equal((await PDFDocument.load(await readFile(result.outputs[0].path))).getPageCount(), 1)
    assert.equal(result.outputs[0].metadata.missingGlyphs, 0)
  }
  assert.deepEqual(await readFile(imagePath), original)
  await assert.rejects(executeLocalOperation(['pdf-to-scanned', '--input', pdf, '--output', pdf]), e => e.code === 'OUTPUT_EXISTS')
  await assert.rejects(run('document-scan', imagePath, { corners:[[0,0],[1,1],[1,0],[0,1]] }, 'dir'), e => e.code === 'INVALID_PLAN')
  if (process.argv.includes('--ai')) {
    const detected = await run('document-scan', imagePath, {}, 'dir')
    assert.equal(detected.outputs[0].metadata.detector, 'lcnet100')
    const selected = await run('image-smart-cutout', imagePath, { points: [{x:0.5,y:0.5,label:1},{x:0.02,y:0.02,label:0}], saveMask:true }, 'dir')
    assert.equal(selected.outputs.length, 2)
    const selectedMask = m.MagickImage.create(await readFile(selected.outputs[1].path))
    try {
      assert.equal(selectedMask.getPixels(p => p.toByteArray(32,24,1,1,'R'))[0], 255)
      assert.equal(selectedMask.getPixels(p => p.toByteArray(2,2,1,1,'R'))[0], 0)
    } finally { selectedMask.dispose() }

    for (const model of ['photo','anime']) {
      const result = await run('image-upscale', imagePath, { model, scale: 2 }, 'dir')
      assert.equal(result.outputs[0].metadata.width, 128)
    }
  }
  console.log(JSON.stringify({ ok: true, extendedChecks: checks, artifacts: directory }))
} finally {
  if (!process.env.BAIMIAO_KEEP_TEST_OUTPUT) await rm(directory, { recursive: true, force: true })
}

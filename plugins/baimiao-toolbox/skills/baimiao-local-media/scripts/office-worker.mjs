import { parentPort, workerData } from 'node:worker_threads'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { ensureRuntimeFile } from './runtime-cache.mjs'
import { EXTENDED_RUNTIME_ASSETS, OFFICE_FONT_PACKS } from './extended-runtime-assets.mjs'
import { selectFontPacks } from './ported/selectFontPacks.mjs'

try {
  const { kind, data } = workerData
  const moduleName = Object.keys(EXTENDED_RUNTIME_ASSETS).find(x => x.startsWith(`${kind}-preview.`) && x.endsWith('.mjs'))
  const wasmName = moduleName.replace('.mjs', '.wasm')
  const runtime = await import(pathToFileURL(await ensureRuntimeFile(moduleName)))
  await runtime.default({ module_or_path: await readFile(await ensureRuntimeFile(wasmName)) })
  let missing, codepoints, names
  if (kind === 'wordcraft') {
    missing = runtime.missing_docx_codepoints(data)
    codepoints = runtime.docx_codepoints(data)
    names = runtime.docx_font_names(data)
  } else {
    const requirements = runtime.pptx_font_requirements(data)
    try {
      missing = requirements.missing_codepoints()
      codepoints = requirements.codepoints()
      names = requirements.font_names()
    } finally { requirements.free() }
  }
  for (const pack of selectFontPacks(OFFICE_FONT_PACKS[kind], Array.from(missing), names.split('\n').filter(Boolean), Array.from(codepoints))) {
    runtime.register_preview_font(await readFile(await ensureRuntimeFile(pack.file)))
  }
  const result = kind === 'wordcraft' ? runtime.convert_docx_preview(data) : runtime.convert_pptx_preview(data)
  try {
    const pdf = result.take_pdf()
    parentPort.postMessage({ data: pdf, metadata: { missingGlyphs: result.missing_glyphs, incomplete: result.missing_glyphs > 0 } })
  } finally { result.free() }
} catch (error) {
  parentPort.postMessage({ error: { code: error.code || 'OFFICE_CONVERSION_FAILED', message: error.code ? error.message : 'The Office document could not be converted.' } })
}

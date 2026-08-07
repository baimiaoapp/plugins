import assert from 'node:assert/strict'

import { executeLocalOperation } from '../skills/baimiao-local-media/scripts/baimiao.mjs'
import { createLocalOperationHandlers } from '../skills/baimiao-local-media/scripts/operation-handlers.mjs'

import {
  IMAGE_OPERATION_NAMES,
  LOCAL_OPERATION_CATALOG,
  LOCAL_OPERATION_NAMES,
  MEDIA_OPERATION_NAMES,
  QPDF_OPERATION_NAMES,
  getLocalOperation,
} from '../skills/baimiao-local-media/scripts/operation-catalog.mjs'

assert.equal(new Set(LOCAL_OPERATION_NAMES).size, LOCAL_OPERATION_NAMES.length)
assert.equal(LOCAL_OPERATION_CATALOG.length, 32)
assert.equal(getLocalOperation('merge').minInputs, 2)
assert.equal(getLocalOperation('images-to-pdf').uniqueInputs, false)
assert.equal(getLocalOperation('reorder-plan').backend, 'pdf-lib')
assert.equal(getLocalOperation('pdf-to-images').category, 'pdf')
assert.equal(getLocalOperation('image-rembg').plan, 'optional')
assert.equal(QPDF_OPERATION_NAMES.length + MEDIA_OPERATION_NAMES.length
  + LOCAL_OPERATION_CATALOG.filter(({ backend }) => backend === 'pdf-lib').length, 32)
assert.equal(IMAGE_OPERATION_NAMES.includes('pdf-to-images'), false)
await assert.rejects(
  executeLocalOperation(['missing']),
  (error) => error?.code === 'INVALID_ARGUMENT',
)

const committed = []
const mergeHandler = createLocalOperationHandlers({
  transactions: {
    async resolveOutputPath(output) { return `/resolved/${output.split('/').at(-1)}` },
    async commitOutputs(outputs) { committed.push(...outputs) },
  },
})
const mergeHandlerResult = await mergeHandler.merge({
  adapter: { async merge() { return [{ data: Buffer.from('merged') }] } },
  inputs: [{ data: Buffer.from('first') }, { data: Buffer.from('second') }],
  options: { output: '/tmp/merged.pdf' },
})
assert.equal(mergeHandlerResult.outputs[0].path, '/resolved/merged.pdf')
assert.equal(committed[0].data.toString(), 'merged')

process.stdout.write(`${JSON.stringify({ ok: true, operationCatalog: LOCAL_OPERATION_NAMES.length })}\n`)

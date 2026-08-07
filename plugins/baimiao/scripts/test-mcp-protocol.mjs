import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import process from 'node:process'

import { createJsonRpcLineHandler } from '../mcp/json-rpc.mjs'
import {
  LATEST_SUPPORTED_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  createBaimiaoServer,
} from '../mcp/baimiao-server.mjs'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const server = await createBaimiaoServer({ adapter: {} })
const handleLine = createJsonRpcLineHandler(server.handleRequest)

assert.deepEqual(SUPPORTED_PROTOCOL_VERSIONS, ['2024-11-05'])
assert.equal(LATEST_SUPPORTED_PROTOCOL_VERSION, '2024-11-05')

assert.deepEqual(await responseFor(handleLine, '{'), errorResponse(null, -32700, 'Parse error.'))
assert.deepEqual(await responseFor(handleLine, 'null'), errorResponse(null, -32600, 'Invalid Request.'))
assert.deepEqual(await responseFor(handleLine, '[]'), errorResponse(null, -32600, 'Invalid Request.'))
assert.deepEqual(
  await responseFor(handleLine, JSON.stringify({ jsonrpc: '1.0', id: 7, method: 'ping' })),
  errorResponse(7, -32600, 'Invalid Request.'),
)
assert.deepEqual(
  await responseFor(handleLine, JSON.stringify({ jsonrpc: '2.0', id: {}, method: 'ping' })),
  errorResponse(null, -32600, 'Invalid Request.'),
)
assert.deepEqual(
  await responseFor(handleLine, JSON.stringify({ jsonrpc: '2.0', id: 8 })),
  errorResponse(8, -32600, 'Invalid Request.'),
)

const supportedInitialize = await request(handleLine, {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05' },
})
assert.equal(supportedInitialize.result.protocolVersion, '2024-11-05')

const unsupportedInitialize = await request(handleLine, {
  jsonrpc: '2.0', id: 2, method: 'initialize',
  params: { protocolVersion: '2099-01-01' },
})
assert.equal(unsupportedInitialize.result.protocolVersion, LATEST_SUPPORTED_PROTOCOL_VERSION)

assert.deepEqual(
  await request(handleLine, { jsonrpc: '2.0', id: 3, method: 'missing' }),
  errorResponse(3, -32601, 'Method not found.'),
)
assert.equal(
  await handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'missing' })),
  null,
)

const throwingHandler = createJsonRpcLineHandler(async () => {
  throw new Error('private implementation detail')
})
assert.deepEqual(
  await request(throwingHandler, { jsonrpc: '2.0', id: 'failure', method: 'explode' }),
  errorResponse('failure', -32603, 'Internal error.'),
)
assert.equal(
  await throwingHandler(JSON.stringify({ jsonrpc: '2.0', method: 'explode' })),
  null,
)

const mcp = path.join(projectRoot, 'mcp/baimiao-mcp.mjs')
const mockAdapter = path.join(projectRoot, 'scripts/fixtures/mock-mcp-adapter.mjs')
const child = spawnSync(process.execPath, [mcp], {
  encoding: 'utf8',
  env: { ...process.env, BAIMIAO_MCP_ADAPTER_MODULE: mockAdapter },
  input: [
    '{',
    JSON.stringify({ jsonrpc: '2.0', method: 'missing' }),
    JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' }),
  ].join('\n'),
})
assert.equal(child.status, 0, child.stderr)
assert.equal(child.stderr, '')
assert.deepEqual(child.stdout.trim().split('\n').map(JSON.parse), [
  errorResponse(null, -32700, 'Parse error.'),
  { jsonrpc: '2.0', id: 4, result: {} },
])

console.log(JSON.stringify({ ok: true, protocolVersions: SUPPORTED_PROTOCOL_VERSIONS }))

async function request(handler, value) {
  return responseFor(handler, JSON.stringify(value))
}

async function responseFor(handler, line) {
  const response = await handler(line)
  assert.notEqual(response, null)
  return JSON.parse(response)
}

function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

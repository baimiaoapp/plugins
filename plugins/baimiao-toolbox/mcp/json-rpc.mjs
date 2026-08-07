const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

export function createJsonRpcLineHandler(handleRequest) {
  if (typeof handleRequest !== 'function') throw new TypeError('handleRequest must be a function.')

  return async function handleLine(line) {
    let request
    try {
      request = JSON.parse(line)
    } catch {
      return serializeError(null, -32700, 'Parse error.')
    }

    const requestId = recoverRequestId(request)
    if (!isJsonRpcRequest(request)) {
      return serializeError(requestId, -32600, 'Invalid Request.')
    }

    const notification = !hasOwn(request, 'id')
    try {
      const response = await handleRequest(request)
      if (notification) return null
      if (!response) return serializeError(request.id, -32603, 'Internal error.')
      return JSON.stringify(response)
    } catch {
      if (notification) return null
      return serializeError(request.id, -32603, 'Internal error.')
    }
  }
}

function isJsonRpcRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (value.jsonrpc !== '2.0' || typeof value.method !== 'string' || !value.method) return false
  if (hasOwn(value, 'id') && !isRequestId(value.id)) return false
  if (hasOwn(value, 'params') && !isStructuredValue(value.params)) return false
  return true
}

function isRequestId(value) {
  return value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
}

function isStructuredValue(value) {
  return value !== null && typeof value === 'object'
}

function recoverRequestId(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return hasOwn(value, 'id') && isRequestId(value.id) ? value.id : null
}

function serializeError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })
}

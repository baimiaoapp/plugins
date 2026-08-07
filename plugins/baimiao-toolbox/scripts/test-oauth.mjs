import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createAdapter } from '../mcp/baimiao-http-adapter.mjs'
import { createCredentialStore, createOAuthClient, createPkce } from '../mcp/baimiao-oauth.mjs'

const root = await mkdtemp(path.join(os.tmpdir(), 'baimiao-oauth-test-'))
const resource = 'https://service.example/mcp'
const issuer = 'https://identity.example/oauth'
const endpoints = {
  protected: `${resource}/.well-known/oauth-protected-resource`,
  metadata: 'https://identity.example/api/oauth/.well-known/oauth-authorization-server',
  authorize: `${issuer}/authorize`, token: `${issuer}/token`, revoke: `${issuer}/revoke`,
}
const access_one = 'access-token-one'
const access_two = 'access-token-two'
const refresh_one = 'refresh-token-one'
const refresh_two = 'refresh-token-two'

try {
  const rfc_verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
  const pkce = await createPkce({ random_bytes: () => Buffer.from(rfc_verifier, 'base64url') })
  assert.equal(pkce.verifier, rfc_verifier)
  assert.equal(pkce.challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')

  let challenge
  let code_requests = 0
  let revoke_requests = 0
  const storage = createCredentialStore({ credential_path: path.join(root, 'first', 'oauth.json') })
  const fetch_impl = async (url, init = {}) => {
    assert(init.signal instanceof AbortSignal)
    if (String(url) === endpoints.protected) return jsonResponse({ resource, authorization_servers: [issuer] })
    if (String(url) === endpoints.metadata) return jsonResponse(metadata())
    if (String(url) === endpoints.token) {
      const body = new URLSearchParams(init.body)
      assert.equal(body.get('grant_type'), 'authorization_code')
      assert.equal(body.get('resource'), resource)
      assert.equal(challengeFor(body.get('code_verifier')), challenge)
      code_requests += 1
      return jsonResponse({ access_token: access_one, refresh_token: refresh_one, token_type: 'Bearer', expires_in: 600, scope: 'documents:process' })
    }
    if (String(url) === endpoints.revoke) {
      revoke_requests += 1
      const body = new URLSearchParams(init.body)
      assert.equal(body.get('token'), refresh_one)
      return new Response('', { status: 200 })
    }
    throw new Error(`Unexpected test URL: ${String(url)}`)
  }
  const oauth = createOAuthClient({
    fetch_impl, storage, resource_url: resource, client_id: 'test-client',
    open_url: async (authorization_url) => {
      const url = new URL(authorization_url)
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
      challenge = url.searchParams.get('code_challenge')
      const callback = new URL(url.searchParams.get('redirect_uri'))
      callback.searchParams.set('code', 'one-time-code')
      callback.searchParams.set('state', url.searchParams.get('state'))
      assert.equal((await fetch(callback)).status, 200)
    },
  })
  assert.equal((await oauth.login()).authenticated, true)
  assert.equal(code_requests, 1)
  const saved = await storage.read()
  assert.deepEqual(Object.keys(saved).sort(), ['access_token', 'audience', 'client_id', 'expires_at', 'issuer', 'refresh_expires_at', 'refresh_token', 'scope', 'token_type'])
  assert((await readFile(storage.path, 'utf8')).includes(access_one))
  const info = await stat(storage.path)
  if (process.platform !== 'win32') assert.equal(info.mode & 0o077, 0)

  const legacy_storage = createCredentialStore({ credential_path: path.join(root, 'legacy', 'oauth.json') })
  await legacy_storage.write({ ...saved, client_id: 'baimiao-stdio', scope: 'mcp:tools' })
  const migrated_oauth = createOAuthClient({ fetch_impl, storage: legacy_storage, resource_url: resource, client_id: 'test-client' })
  assert.deepEqual(await migrated_oauth.status(), { authenticated: false, reason: 'reauthorize' })
  assert.equal(await legacy_storage.read(), null)

  assert.deepEqual(await oauth.logout(), { authenticated: false, credentials_removed: true })
  assert.equal(revoke_requests, 1)

  let now = Date.now()
  let refresh_requests = 0
  let refresh_body
  let rotate_refresh_token = true
  const refresh_storage = createCredentialStore({ credential_path: path.join(root, 'refresh', 'oauth.json') })
  await refresh_storage.write({ ...saved, access_token: access_one, refresh_token: refresh_one, expires_at: now + 1, refresh_expires_at: now + 86_400_000 })
  const refresh_fetch = async (url, init = {}) => {
    if (String(url) === endpoints.protected) return jsonResponse({ resource, authorization_servers: [issuer] })
    if (String(url) === endpoints.metadata) return jsonResponse(metadata())
    if (String(url) === endpoints.token) {
      refresh_body = new URLSearchParams(init.body)
      refresh_requests += 1
      return jsonResponse({
        access_token: access_two,
        ...(rotate_refresh_token ? { refresh_token: refresh_two, refresh_token_expires_in: 2_592_000 } : {}),
        token_type: 'Bearer', expires_in: 1_800, scope: 'documents:process',
      })
    }
    throw new Error('Unexpected refresh URL')
  }
  const refresh_oauth = createOAuthClient({ fetch_impl: refresh_fetch, storage: refresh_storage, resource_url: resource, client_id: 'test-client', now: () => now })
  assert.equal((await refresh_oauth.getAuthorizationHeaders()).authorization, `Bearer ${access_two}`)
  assert.equal(refresh_body.get('grant_type'), 'refresh_token')
  assert.equal(refresh_body.get('refresh_token'), refresh_one)
  assert.equal((await refresh_storage.read()).refresh_token, refresh_two)

  await refresh_storage.write({ ...saved, access_token: access_one, refresh_token: refresh_one, expires_at: now + 1, refresh_expires_at: now + 86_400_000 })
  refresh_requests = 0
  const concurrent = await Promise.all([refresh_oauth.getAuthorizationHeaders(), refresh_oauth.getAuthorizationHeaders(), refresh_oauth.getAuthorizationHeaders()])
  assert.equal(refresh_requests, 1, 'Only one refresh may run concurrently')
  assert(concurrent.every((headers) => headers.authorization === `Bearer ${access_two}`))

  const retained_refresh_expiry = now + 86_400_000
  await refresh_storage.write({
    ...saved,
    access_token: access_one,
    refresh_token: refresh_one,
    expires_at: now + 1,
    refresh_expires_at: retained_refresh_expiry,
  })
  rotate_refresh_token = false
  assert.equal((await refresh_oauth.getAuthorizationHeaders()).authorization, `Bearer ${access_two}`)
  assert.equal((await refresh_storage.read()).refresh_token, refresh_one)
  assert.equal((await refresh_storage.read()).refresh_expires_at, retained_refresh_expiry)

  const failed_storage = createCredentialStore({ credential_path: path.join(root, 'failed', 'oauth.json') })
  await failed_storage.write({ ...saved, expires_at: now + 1 })
  const failed_oauth = createOAuthClient({
    fetch_impl: async (url, init = {}) => String(url) === endpoints.protected ? jsonResponse({ resource, authorization_servers: [issuer] })
      : String(url) === endpoints.metadata ? jsonResponse(metadata())
        : new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'content-type': 'application/json' } }),
    storage: failed_storage, resource_url: resource, client_id: 'test-client', now: () => now,
  })
  await assert.rejects(failed_oauth.getAuthorizationHeaders(), (error) => error.code === 'OAUTH_REAUTH_REQUIRED' && !error.message.includes(refresh_one))
  assert.equal(await failed_storage.read(), null)

  const denied = createOAuthClient({ fetch_impl, storage: createCredentialStore({ credential_path: path.join(root, 'denied', 'oauth.json') }), resource_url: resource, open_url: async (authorization_url) => {
    const url = new URL(authorization_url)
    const callback = new URL(url.searchParams.get('redirect_uri'))
    callback.searchParams.set('error', 'access_denied')
    callback.searchParams.set('state', url.searchParams.get('state'))
    await fetch(callback)
  } })
  await assert.rejects(denied.login(), (error) => error.code === 'OAUTH_ACCESS_DENIED' && error.publicMessage.includes('denied'))

  const previous_api_base = process.env.BAIMIAO_MCP_API_BASE_URL
  process.env.BAIMIAO_MCP_API_BASE_URL = 'https://service.example/api/'
  const api_storage = createCredentialStore({ credential_path: path.join(root, 'api', 'oauth.json') })
  await api_storage.write({ ...saved, access_token: access_one, refresh_token: refresh_one, expires_at: now + 600_000, refresh_expires_at: now + 86_400_000 })
  let api_refreshes = 0
  let sign_calls = 0
  const api_fetch = async (url, init = {}) => {
    const request_url = String(url)
    if (request_url === endpoints.protected) return jsonResponse({ resource, authorization_servers: [issuer] })
    if (request_url === endpoints.metadata) return jsonResponse(metadata())
    if (request_url === endpoints.token) {
      api_refreshes += 1
      return jsonResponse({ access_token: access_two, refresh_token: refresh_two, token_type: 'Bearer', expires_in: 1_800, refresh_token_expires_in: 2_592_000, scope: 'documents:process' })
    }
    if (request_url.includes('/aliyun/oss/sign')) {
      sign_calls += 1
      if (sign_calls === 1) return new Response('', { status: 401 })
      return envelope({ host: 'https://upload.example/', file_key: 'key', policy: 'policy', signature: 'signature', x_oss_credential: 'credential', x_oss_date: 'date', security_token: 'security' })
    }
    if (request_url === 'https://upload.example/') return new Response('', { status: 200 })
    if (request_url.endsWith('/ocr/text')) return envelope({ result: { text: 'ok' } })
    throw new Error(`Unexpected API URL ${request_url}`)
  }
  const api_oauth = createOAuthClient({ fetch_impl: api_fetch, storage: api_storage, resource_url: resource, client_id: 'test-client', now: () => now })
  const adapter = createAdapter({ fetch_impl: api_fetch, oauth_client: api_oauth })
  const task = await adapter.submit({ operation: 'ocr', input: { data: new Uint8Array([1]), mimeType: 'image/png', name: 'x.png' }, options: { kind: 'text' } })
  assert.equal(task.status, 'completed')
  assert.equal(api_refreshes, 1)
  assert.equal(sign_calls, 2, '401 retries the original request once')
  if (previous_api_base === undefined) delete process.env.BAIMIAO_MCP_API_BASE_URL
  else process.env.BAIMIAO_MCP_API_BASE_URL = previous_api_base

  process.stdout.write(`${JSON.stringify({ ok: true, firstAuthorization: true, refresh: true, rotation: true, retainedRefreshToken: true, concurrentRefresh: true, single401Retry: true, reauthorize: true, denied: true, tokenRedaction: true })}\n`)
} finally {
  await rm(root, { recursive: true, force: true })
}

function metadata() {
  return { issuer, authorization_endpoint: endpoints.authorize, token_endpoint: endpoints.token, revocation_endpoint: endpoints.revoke, grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'] }
}
function jsonResponse(value) { return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } }) }
function envelope(value) { return jsonResponse({ code: 200, data: value }) }
function challengeFor(verifier) { return createHash('sha256').update(verifier, 'ascii').digest('base64url') }

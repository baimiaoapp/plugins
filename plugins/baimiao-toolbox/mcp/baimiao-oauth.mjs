import { randomBytes, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const DEFAULT_RESOURCE = 'https://pdf.baimiaoapp.com/api/web/mcp'
const DEFAULT_CLIENT_ID = 'baimiao-toolbox'
const DEFAULT_SCOPE = 'documents:process'
const CALLBACK_PATH = '/oauth/callback'
const EXPIRY_SKEW_MS = 30_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_REFRESH_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000

export function createOAuthClient({
  fetch_impl = globalThis.fetch,
  open_url = openSystemBrowser,
  storage = createCredentialStore(),
  now = () => Date.now(),
  random_bytes = randomBytes,
  callback_timeout_ms = 300_000,
  request_timeout_ms = DEFAULT_REQUEST_TIMEOUT_MS,
  resource_url = process.env.BAIMIAO_MCP_RESOURCE_URL || DEFAULT_RESOURCE,
  client_id = process.env.BAIMIAO_MCP_OAUTH_CLIENT_ID || DEFAULT_CLIENT_ID,
  metadata_url = process.env.BAIMIAO_MCP_OAUTH_METADATA_URL,
} = {}) {
  if (typeof fetch_impl !== 'function') throw new Error('OAuth requires a Fetch-compatible Node.js runtime.')
  const resource = secureUrl(resource_url, 'OAuth resource URL').href.replace(/\/$/, '')
  let refresh_promise
  let needs_reauthorization = false

  return {
    async login() {
      const metadata = await discover(fetch_impl, resource, metadata_url, request_timeout_ms)
      const verifier = base64url(random_bytes(32))
      const challenge = base64url(await cryptoDigest(verifier))
      const state = base64url(random_bytes(32))
      const callback = await createLoopbackCallback({ state, timeout_ms: callback_timeout_ms })
      const authorize_url = new URL(metadata.authorization_endpoint)
      authorize_url.search = new URLSearchParams({
        response_type: 'code', client_id, redirect_uri: callback.redirect_uri,
        scope: DEFAULT_SCOPE, state, code_challenge: challenge,
        code_challenge_method: 'S256', resource,
      }).toString()

      try {
        await open_url(authorize_url.href)
        const code = await callback.wait_for_code
        const token = await exchangeCode(fetch_impl, metadata, {
          code, client_id, redirect_uri: callback.redirect_uri, verifier, resource,
        }, request_timeout_ms)
        const expires_at = now() + token.expires_in * 1000
        const refresh_expires_at = now() + (token.refresh_token_expires_in || DEFAULT_REFRESH_LIFETIME_MS / 1000) * 1000
        await storage.write({
          access_token: token.access_token,
          refresh_token: token.refresh_token,
          refresh_expires_at,
          client_id,
          token_type: token.token_type,
          expires_at,
          scope: token.scope || DEFAULT_SCOPE,
          issuer: metadata.issuer,
          audience: resource,
        })
        needs_reauthorization = false
        return { authenticated: true, expires_at: new Date(expires_at).toISOString(), scope: token.scope || DEFAULT_SCOPE }
      } catch (error) {
        callback.cancel()
        throw sanitizeOAuthError(error)
      }
    },

    async status() {
      const credential = await storage.read()
      if (!credential) return { authenticated: false, ...(needs_reauthorization ? { reason: 'reauthorize' } : {}) }
      if (!validCredentialBoundary(credential, resource, client_id)) {
        await storage.clear()
        return { authenticated: false, reason: 'reauthorize' }
      }
      if (credential.expires_at <= now() + EXPIRY_SKEW_MS) {
        try {
          await refresh()
        } catch (error) {
          if (error?.code === 'OAUTH_REAUTH_REQUIRED') return { authenticated: false, reason: 'reauthorize' }
          throw error
        }
      }
      const current = await storage.read()
      return {
        authenticated: true,
        expires_at: new Date(current.expires_at).toISOString(),
        scope: current.scope,
      }
    },

    async logout() {
      const credential = await storage.read()
      if (credential && validCredentialBoundary(credential, resource, client_id)) {
        try {
          const metadata = await discover(fetch_impl, resource, metadata_url, request_timeout_ms)
          await revokeToken(fetch_impl, metadata.revocation_endpoint, {
            token: credential.refresh_token, client_id: credential.client_id, resource,
          }, request_timeout_ms)
        } catch {}
      }
      await storage.clear()
      needs_reauthorization = false
      return { authenticated: false, credentials_removed: true }
    },

    async getAuthorizationHeaders() {
      const credential = await storage.read()
      if (!credential || !validCredentialBoundary(credential, resource, client_id)) {
        await storage.clear()
        throw authRequired()
      }
      if (credential.expires_at <= now() + EXPIRY_SKEW_MS) await refresh()
      const current = await storage.read()
      if (!current || !validCredentialBoundary(current, resource, client_id)) throw authRequired()
      return { authorization: `Bearer ${current.access_token}` }
    },

    async refreshAfterUnauthorized() { await refresh(true) },
  }

  async function refresh(force = false) {
    if (refresh_promise) return refresh_promise
    refresh_promise = (async () => {
      const credential = await storage.read()
      if (!credential || !validCredentialBoundary(credential, resource, client_id) || typeof credential.refresh_token !== 'string' || !credential.refresh_token) {
        await storage.clear()
        throw authRequired()
      }
      if (!force && credential.expires_at > now() + EXPIRY_SKEW_MS) return credential
      if (Number.isFinite(credential.refresh_expires_at) && credential.refresh_expires_at <= now()) {
        await clearForReauthorization()
        throw reauthorizationRequired()
      }
      const metadata = await discover(fetch_impl, resource, metadata_url, request_timeout_ms)
      let token
      try {
        token = await exchangeRefresh(fetch_impl, metadata, {
          refresh_token: credential.refresh_token, client_id: credential.client_id || client_id, resource,
        }, request_timeout_ms)
      } catch (error) {
        if (error?.code === 'OAUTH_REAUTH_REQUIRED') await clearForReauthorization()
        throw error
      }
      const expires_at = now() + token.expires_in * 1000
      const refresh_expires_at = Number.isSafeInteger(token.refresh_token_expires_in) && token.refresh_token_expires_in > 0
        ? now() + token.refresh_token_expires_in * 1000
        : credential.refresh_expires_at
      await storage.write({
        ...credential,
        access_token: token.access_token,
        refresh_token: token.refresh_token || credential.refresh_token,
        expires_at,
        refresh_expires_at,
        client_id: credential.client_id || client_id,
        token_type: token.token_type,
        scope: token.scope || credential.scope || DEFAULT_SCOPE,
      })
      return await storage.read()
    })()
    try { return await refresh_promise } catch (error) {
      if (error?.code === 'OAUTH_REAUTH_REQUIRED') throw error
      throw sanitizeOAuthError(error)
    } finally { refresh_promise = undefined }
  }

  async function clearForReauthorization() {
    needs_reauthorization = true
    await storage.clear()
  }
}

export function createCredentialStore({ credential_path = defaultCredentialPath(), random_bytes = randomBytes } = {}) {
  if (!path.isAbsolute(credential_path)) throw new Error('Credential path must be absolute.')
  return {
    path: credential_path,
    async read() {
      let contents
      try {
        const info = await stat(credential_path)
        if (!info.isFile()) return null
        if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) await chmod(credential_path, 0o600)
        contents = await readFile(credential_path, 'utf8')
      } catch (error) {
        if (error?.code === 'ENOENT') return null
        throw error
      }
      try {
        const value = JSON.parse(contents)
        return value && typeof value === 'object' ? value : null
      } catch {
        await this.clear()
        return null
      }
    },
    async write(value) {
      const directory = path.dirname(credential_path)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      if (process.platform !== 'win32') await chmod(directory, 0o700)
      const temporary = path.join(directory, `.oauth-${process.pid}-${base64url(random_bytes(8))}.tmp`)
      let handle
      try {
        handle = await open(temporary, 'wx', 0o600)
        await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
        await handle.sync()
        await handle.close()
        handle = undefined
        await rename(temporary, credential_path)
        if (process.platform !== 'win32') await chmod(credential_path, 0o600)
      } catch (error) {
        await handle?.close().catch(() => {})
        await unlink(temporary).catch(() => {})
        throw error
      }
    },
    async clear() { await unlink(credential_path).catch((error) => { if (error?.code !== 'ENOENT') throw error }) },
  }
}

export function createPkce({ random_bytes = randomBytes } = {}) {
  const verifier = base64url(random_bytes(32))
  return cryptoDigest(verifier).then((digest) => ({ verifier, challenge: base64url(digest) }))
}

async function discover(fetch_impl, resource, configured_metadata_url, timeout_ms) {
  const resource_metadata_url = `${resource}/.well-known/oauth-protected-resource`
  const protected_resource = await requestJson(fetch_impl, resource_metadata_url, {}, timeout_ms)
  if (protected_resource.resource !== resource || !Array.isArray(protected_resource.authorization_servers)) {
    throw new Error('OAuth protected-resource metadata does not match the configured MCP audience.')
  }
  const issuer = protected_resource.authorization_servers[0]
  secureUrl(issuer, 'OAuth issuer')
  const metadata_url = configured_metadata_url
    || new URL('/api/oauth/.well-known/oauth-authorization-server', issuer).href
  secureUrl(metadata_url, 'OAuth metadata URL')
  const metadata = await requestJson(fetch_impl, metadata_url, {}, timeout_ms)
  if (metadata.issuer !== issuer.replace(/\/$/, '')) throw new Error('OAuth issuer metadata mismatch.')
  if (!metadata.code_challenge_methods_supported?.includes('S256')) throw new Error('OAuth server does not support PKCE S256.')
  if (!metadata.grant_types_supported?.includes('authorization_code')) throw new Error('OAuth server does not support authorization_code.')
  if (!metadata.grant_types_supported?.includes('refresh_token')) throw new Error('OAuth server does not support refresh_token.')
  secureUrl(metadata.authorization_endpoint, 'OAuth authorization endpoint')
  secureUrl(metadata.token_endpoint, 'OAuth token endpoint')
  secureUrl(metadata.revocation_endpoint, 'OAuth revocation endpoint')
  return metadata
}

async function exchangeCode(fetch_impl, metadata, { code, client_id, redirect_uri, verifier, resource }, timeout_ms) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code', code, client_id, redirect_uri,
    code_verifier: verifier, resource,
  })
  const token = await requestJson(fetch_impl, metadata.token_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
  }, timeout_ms)
  if (typeof token.access_token !== 'string' || !token.access_token || token.token_type?.toLowerCase() !== 'bearer') {
    throw new Error('OAuth token response is invalid.')
  }
  if (typeof token.refresh_token !== 'string' || !token.refresh_token) throw new Error('OAuth token response is invalid.')
  if (!Number.isSafeInteger(token.expires_in) || token.expires_in <= 0) throw new Error('OAuth token expiry is invalid.')
  return token
}

async function exchangeRefresh(fetch_impl, metadata, { refresh_token, client_id, resource }, timeout_ms) {
  const token = await requestJson(fetch_impl, metadata.token_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token, client_id, resource }),
  }, timeout_ms)
  if (typeof token.access_token !== 'string' || !token.access_token || token.token_type?.toLowerCase() !== 'bearer'
    || (token.refresh_token !== undefined && (typeof token.refresh_token !== 'string' || !token.refresh_token))
    || !Number.isSafeInteger(token.expires_in) || token.expires_in <= 0) {
    throw new Error('OAuth refresh response is invalid.')
  }
  return token
}

async function revokeToken(fetch_impl, endpoint, { token, client_id, resource }, timeout_ms) {
  let response
  try {
    response = await fetch_impl(endpoint, {
      method: 'POST', redirect: 'error',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, client_id, resource }), signal: AbortSignal.timeout(timeout_ms),
    })
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw new Error('OAuth revoke timed out.')
    throw new Error('OAuth revoke failed.')
  }
  if (!response.ok) throw new Error('OAuth revoke failed.')
}

async function requestJson(fetch_impl, url, init = {}, timeout_ms = DEFAULT_REQUEST_TIMEOUT_MS) {
  let response
  try {
    response = await fetch_impl(url, {
      ...init,
      redirect: 'error',
      headers: { accept: 'application/json', ...init.headers },
      signal: AbortSignal.timeout(timeout_ms),
    })
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw Object.assign(new Error('Baimiao OAuth request timed out.'), {
        code: 'OAUTH_TIMEOUT', publicMessage: 'Baimiao OAuth request timed out.',
      })
    }
    throw Object.assign(new Error('Baimiao OAuth request failed.'), {
      code: 'OAUTH_FAILED', publicMessage: 'Baimiao OAuth request failed.',
    })
  }
  if (!response.ok) {
    let payload = null
    try { payload = await response.json() } catch {}
    if (payload?.error === 'invalid_grant' || payload?.error === 'invalid_token' || payload?.error === 'invalid_client') throw reauthorizationRequired()
    if (response.status >= 500) throw Object.assign(new Error('Baimiao OAuth service is temporarily unavailable.'), { code: 'OAUTH_SERVER_ERROR', publicMessage: 'Baimiao OAuth service is temporarily unavailable. Please retry.' })
    if (response.status === 401 || response.status === 403) throw authRequired()
    throw new Error('OAuth request failed.')
  }
  if (!(response.headers.get('content-type') || '').includes('application/json')) throw new Error('OAuth server returned an invalid response.')
  return response.json()
}

async function createLoopbackCallback({ state, timeout_ms }) {
  let settle
  let reject_wait
  const wait_for_code = new Promise((resolve, reject) => { settle = resolve; reject_wait = reject })
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    if (url.pathname !== CALLBACK_PATH) {
      response.writeHead(404).end('Not found')
      return
    }
    const received_state = url.searchParams.get('state') || ''
    if (!constantTimeEqual(state, received_state)) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Authorization state mismatch. Return to your AI assistant and retry.')
      reject_wait(new Error('OAuth callback state mismatch.'))
      server.close()
      return
    }
    const oauth_error = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    if (oauth_error || !code) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Authorization was not completed. Return to your AI assistant and retry.')
      reject_wait(oauth_error === 'access_denied' ? authorizationDenied() : new Error(oauth_error ? 'OAuth authorization failed.' : 'OAuth callback did not contain a code.'))
      server.close()
      return
    }
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('Baimiao authorization completed. You can close this tab.')
    settle(code)
    server.close()
  })
  server.on('error', reject_wait)
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject))
  const address = server.address()
  const timer = setTimeout(() => {
    reject_wait(new Error('OAuth authorization timed out.'))
    server.close()
  }, timeout_ms)
  timer.unref()
  wait_for_code.finally(() => clearTimeout(timer)).catch(() => {})
  return {
    redirect_uri: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
    wait_for_code,
    cancel() { clearTimeout(timer); server.close() },
  }
}

async function openSystemBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open'
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url]
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}

function defaultCredentialPath() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Baimiao PDF', 'oauth.json')
  if (process.platform === 'win32') return path.join(os.homedir(), 'AppData', 'Roaming', 'Baimiao PDF', 'oauth.json')
  return path.join(os.homedir(), '.config', 'baimiao', 'oauth.json')
}

function validCredentialBoundary(value, audience, client_id) {
  return typeof value.access_token === 'string' && value.access_token
    && value.token_type?.toLowerCase() === 'bearer'
    && Number.isFinite(value.expires_at)
    && typeof value.refresh_token === 'string' && value.refresh_token
    && value.client_id === client_id
    && value.audience === audience
    && typeof value.issuer === 'string'
    && String(value.scope || '').split(' ').includes(DEFAULT_SCOPE)
}

function secureUrl(value, label) {
  const url = new URL(value)
  const loopback = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !loopback) throw new Error(`${label} must use HTTPS except on loopback.`)
  if (url.username || url.password) throw new Error(`${label} must not contain credentials.`)
  return url
}

function constantTimeEqual(expected, actual) {
  const left = Buffer.from(expected)
  const right = Buffer.from(actual)
  return left.length === right.length && timingSafeEqual(left, right)
}
function base64url(value) { return Buffer.from(value).toString('base64url') }
async function cryptoDigest(value) { return (await import('node:crypto')).createHash('sha256').update(value, 'ascii').digest() }
function authRequired() {
  return Object.assign(new Error('Baimiao authorization is required. Run login_baimiao and retry.'), {
    code: 'AUTH_REQUIRED', publicMessage: 'Baimiao authorization is required. Run login_baimiao and retry.',
  })
}
function reauthorizationRequired() {
  return Object.assign(new Error('Baimiao authorization expired or was revoked. Run login_baimiao to authorize again.'), {
    code: 'OAUTH_REAUTH_REQUIRED', publicMessage: 'Baimiao authorization expired or was revoked. Run login_baimiao to authorize again.',
  })
}
function authorizationDenied() {
  return Object.assign(new Error('Baimiao authorization was denied. No credentials were changed.'), {
    code: 'OAUTH_ACCESS_DENIED', publicMessage: 'Baimiao authorization was denied. No credentials were changed.',
  })
}
function sanitizeOAuthError(error) {
  if (['AUTH_REQUIRED', 'OAUTH_TIMEOUT', 'OAUTH_REAUTH_REQUIRED', 'OAUTH_ACCESS_DENIED', 'OAUTH_SERVER_ERROR'].includes(error?.code)) return error
  return Object.assign(new Error('Baimiao OAuth failed.'), {
    code: 'OAUTH_FAILED', publicMessage: 'Baimiao OAuth failed.',
  })
}

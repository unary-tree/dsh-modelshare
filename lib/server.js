/**
 * The shared OpenAI-compatible endpoint.
 *
 * A standalone loopback listener rather than a DSH web route: it is meant for
 * *other* software, so it owns its port, its CORS answers, and its lifetime.
 * Every call is served through ctx.llm, so the models the profile has already
 * connected are the models this endpoint can share.
 *
 * Two audiences hit this server:
 * - model clients, which present a sharing key and call /v1/*;
 * - the DSH page, which is same-origin with the harness and edits the
 *   settings through /modelshare/api/*.
 */
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { errorBody, ProxyError, splitRoute, convertRequest, toOpenAiStream, toOpenAiResponse } from './wire.js'

const MAX_BODY_BYTES = 32 * 1024 * 1024
const HEARTBEAT_MS = 15000

/** Read and parse a JSON request body with a hard size bound. */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new ProxyError(413, 'request body is too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new ProxyError(400, 'request body is not valid JSON')
  }
}

/** Write one JSON response with the headers every OpenAI client expects. */
function sendJson(res, status, value) {
  const text = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  })
  res.end(text)
}

/** Answer an OPTIONS preflight for browser-based clients. */
function sendPreflight(res) {
  res.writeHead(204, {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, HEAD, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, x-api-key, openai-organization, openai-project',
    'access-control-max-age': '86400',
    'content-length': '0',
  })
  res.end()
}

/**
 * Extract the presented sharing key from either header spelling.
 * @param req - the incoming request.
 * @returns the trimmed token, or '' when none was sent.
 */
function presentedKey(req) {
  const header = String(req.headers.authorization ?? '')
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim()
  return String(req.headers['x-api-key'] ?? '').trim()
}

/**
 * Build the request handler for one plugin instance.
 * @param getContext - resolves the live DSH context (null while unloaded).
 * @param getConfig - resolves the effective config for the current request.
 * @param getStore - resolves the live sharing settings.
 * @param log - diagnostic sink.
 * @returns an http request listener.
 */
export function createHandler({ getContext, getConfig, getStore, log = () => {} }) {
  /** Everything the profile currently offers, as page-facing rows. */
  async function catalog(ctx) {
    const providers = ctx.llm.listProviders()
    const single = providers.length === 1
    const rows = []
    const seen = new Set()
    for (const provider of providers) {
      let models = []
      try {
        models = await ctx.llm.listModels(provider.id)
      } catch (error) {
        log('listModels failed for ' + provider.id + ': ' + (error?.message ?? error))
        continue
      }
      for (const model of models) {
        const id = single ? model.id : provider.id + '/' + model.id
        if (seen.has(id)) continue
        seen.add(id)
        rows.push({ id, provider: provider.id, providerName: provider.name, model: model.id, name: model.name })
      }
    }
    return { rows, single }
  }

  /** The base URL to advertise: explicit setting first, else the request host. */
  function baseUrlFor(req, store) {
    const configured = store.snapshot().baseUrl
    if (configured.length > 0) return configured
    const host = String(req.headers.host ?? '')
    const port = host.includes(':') ? host : host + ':' + (getConfig().port || 0)
    return 'http://' + port + '/v1'
  }

  /** Serve the page-facing settings document. */
  async function serveSettings(ctx, req, res) {
    const store = getStore()
    const { rows, single } = await catalog(ctx)
    const doc = store.snapshot()
    sendJson(res, 200, {
      ok: true,
      settings: doc,
      baseUrl: baseUrlFor(req, store),
      singleProvider: single,
      models: rows,
    })
  }

  /** Replace the settings document from the page. */
  async function saveSettings(ctx, req, res) {
    const body = await readJson(req)
    const store = getStore()
    const doc = store.replace(body)
    log('settings saved: ' + doc.keys.length + ' key(s), ' + doc.sharedModels.length + ' shared model(s)')
    sendJson(res, 200, { ok: true, settings: doc })
  }

  /** Mint a new sharing key. */
  async function createKey(ctx, req, res) {
    const body = await readJson(req)
    const store = getStore()
    const entry = store.addKey({ label: body.label, models: body.models })
    log('key created: ' + entry.key.slice(0, 7) + '...')
    sendJson(res, 200, { ok: true, entry })
  }

  /** Delete a sharing key. */
  async function deleteKey(ctx, req, res, url) {
    const key = url.searchParams.get('key') ?? ''
    const store = getStore()
    if (!store.removeKey(key)) {
      sendJson(res, 404, { ok: false, error: 'no such key' })
      return
    }
    log('key removed')
    sendJson(res, 200, { ok: true })
  }

  /** Serve POST /v1/chat/completions. */
  async function chatCompletions(ctx, req, res) {
    const store = getStore()
    const body = await readJson(req)
    const config = getConfig()

    if (!store.enabled) {
      throw new ProxyError(503, 'model sharing is paused; enable it on the Model Share page', { code: 'sharing_disabled', type: 'api_error' })
    }

    const entry = store.matchKey(presentedKey(req))
    if (entry === undefined) {
      throw new ProxyError(401, 'invalid API key: create one on the DSH Model Share page', { code: 'invalid_api_key', type: 'authentication_error' })
    }

    const { rows, single } = await catalog(ctx)
    if (rows.length === 0) {
      throw new ProxyError(503, 'the harness has no LLM provider registered right now', { code: 'no_provider', type: 'api_error' })
    }
    const providerIds = [...new Set(rows.map((row) => row.provider))]

    const requested = typeof body.model === 'string' && body.model.trim().length > 0 ? body.model.trim() : ''
    if (requested.length === 0) throw new ProxyError(400, "'model' is required", { param: 'model' })
    const route = splitRoute(requested, config.defaultProvider, providerIds, config.modelRoutes)
    const publicId = single ? route.model : route.provider + '/' + route.model

    if (!providerIds.includes(route.provider)) {
      throw new ProxyError(404, "unknown model '" + requested + "': provider route '" + route.provider + "' is not registered", { param: 'model', code: 'model_not_found' })
    }
    if (!rows.some((row) => row.id === publicId)) {
      throw new ProxyError(404, "unknown model '" + requested + "'", { param: 'model', code: 'model_not_found' })
    }
    if (!store.permits(entry, publicId)) {
      throw new ProxyError(403, "this API key may not use model '" + publicId + "'", { param: 'model', code: 'model_not_allowed' })
    }

    const request = convertRequest(body, route, { toolResultStyle: config.toolResultStyle })
    const controller = new AbortController()
    res.on('close', () => { if (!res.writableEnded) controller.abort() })

    const id = 'chatcmpl-' + randomUUID().replace(/-/g, '')
    const created = Math.floor(Date.now() / 1000)
    const options = {
      provider: route.provider,
      model: route.model,
      messages: request.messages,
      signal: controller.signal,
      sessionId: route.provider + ':' + id,
    }
    if (request.system !== undefined) options.system = request.system
    if (request.tools !== undefined) options.tools = request.tools
    if (request.call.temperature !== undefined) options.temperature = request.call.temperature
    if (request.call.maxTokens !== undefined) options.maxTokens = request.call.maxTokens
    if (request.call.stop !== undefined) options.stop = request.call.stop
    if (request.reasoningEffort !== undefined) options.reasoningEffort = request.reasoningEffort

    const stream = ctx.llm.stream(options)
    log('chat ' + publicId + (request.stream ? ' stream' : '') + ' ' + request.messages.length + ' messages')

    if (!request.stream) {
      const response = await toOpenAiResponse(stream, { id, model: publicId, created })
      if (config.includeUsage && response.usage === undefined) response.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      sendJson(res, 200, response)
      return
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'access-control-allow-origin': '*',
    })

    let closed = false
    res.on('close', () => { closed = true })
    const write = (payload) => {
      if (closed) return false
      try {
        res.write('data: ' + JSON.stringify(payload) + '\n\n')
        return true
      } catch {
        closed = true
        return false
      }
    }
    const heartbeat = setInterval(() => { if (!closed) res.write(': keep-alive\n\n') }, HEARTBEAT_MS)
    heartbeat.unref?.()

    try {
      for await (const payload of toOpenAiStream(stream, { id, model: publicId, created, includeUsage: request.streamOptions?.include_usage === true })) {
        for (const chunk of payload) if (!write(chunk)) break
        if (closed) break
      }
      if (!closed) res.write('data: [DONE]\n\n')
    } catch (error) {
      log('stream failed: ' + (error?.message ?? error))
      if (!closed) write(errorBody(error))
    } finally {
      clearInterval(heartbeat)
      if (!closed) res.end()
    }
  }

  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname.replace(/\/+$/, '') || '/'

    if (req.method === 'OPTIONS') return sendPreflight(res)

    const ctx = getContext()
    if (!ctx) {
      sendJson(res, 503, errorBody(new ProxyError(503, 'the harness is still loading', { type: 'api_error', code: 'unavailable' })))
      return
    }

    try {
      // Page-facing settings API.
      if (path === '/modelshare/api/settings') {
        if (req.method === 'GET') return await serveSettings(ctx, req, res)
        if (req.method === 'PUT' || req.method === 'POST') return await saveSettings(ctx, req, res)
        sendJson(res, 405, { ok: false, error: 'use GET or PUT' })
        return
      }
      if (path === '/modelshare/api/keys') {
        if (req.method === 'POST') return await createKey(ctx, req, res)
        if (req.method === 'DELETE') return await deleteKey(ctx, req, res, url)
        sendJson(res, 405, { ok: false, error: 'use POST or DELETE' })
        return
      }

      if (path === '/' || path === '/health') {
        const store = getStore()
        sendJson(res, 200, {
          ok: true,
          service: 'dsh-modelshare',
          enabled: store.enabled,
          keys: store.snapshot().keys.length,
          baseUrl: baseUrlFor(req, store),
          endpoints: ['/v1/models', '/v1/chat/completions'],
        })
        return
      }

      // Model-client API: every route below needs a valid sharing key.
      const entry = store_match(getStore(), req)
      if (entry === undefined) {
        sendJson(res, 401, errorBody(Object.assign(new Error('invalid API key: create one on the DSH Model Share page'), { type: 'authentication_error', code: 'invalid_api_key' })))
        return
      }

      if (path === '/v1/models' && (req.method === 'GET' || req.method === 'HEAD')) {
        const { rows, single } = await catalog(ctx)
        const store = getStore()
        const data = []
        for (const row of rows) {
          if (!store.permits(entry, row.id)) continue
          data.push({
            id: row.id,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: row.provider,
            ...(row.name && row.name !== row.id ? { name: row.name } : {}),
          })
        }
        void single
        sendJson(res, 200, { object: 'list', data })
        return
      }

      if (path === '/v1/chat/completions') {
        if (req.method !== 'POST') {
          sendJson(res, 405, errorBody(new ProxyError(405, 'use POST for /v1/chat/completions')))
          return
        }
        await chatCompletions(ctx, req, res)
        return
      }

      if (path === '/v1/completions') {
        sendJson(res, 400, errorBody(new ProxyError(400, 'the legacy /v1/completions endpoint is not supported; use /v1/chat/completions')))
        return
      }

      sendJson(res, 404, errorBody(new ProxyError(404, 'unknown endpoint ' + path)))
    } catch (error) {
      log('request failed: ' + (error?.stack ?? error))
      if (!res.headersSent) sendJson(res, error?.status ?? 500, errorBody(error))
      else if (!res.writableEnded) res.end()
    }
  }
}

/** Match the presented key against the live store. */
function store_match(store, req) {
  return store.matchKey(presentedKey(req))
}

/**
 * Start (or restart) the listener for one endpoint instance.
 * @param options - handler plus bind settings and a logger.
 * @returns a stop function that closes the server and drops open sockets.
 */
export function startServer({ handler, host, port, log, onListen, onError }) {
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      log('handler crashed: ' + (error?.stack ?? error))
      try {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        if (!res.writableEnded) res.end()
      } catch {}
    })
  })
  server.on('connection', (socket) => socket.setNoDelay(true))
  server.on('error', (error) => {
    log('listen failed on ' + host + ':' + port + ': ' + (error?.message ?? error))
    onError?.(error)
  })
  server.listen(port, host, () => {
    const address = server.address()
    onListen?.(typeof address === 'object' && address !== null ? address.port : port)
  })
  return () => {
    try { server.close() } catch {}
    try { server.closeAllConnections?.() } catch {}
  }
}

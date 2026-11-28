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
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { errorBody, ProxyError, splitRoute, convertRequest, toOpenAiStream, toOpenAiResponse } from './wire.js'
import { convertResponsesRequest, toResponsesStream, toResponsesObject } from './responses.js'

/** First non-internal IPv4 address, for telling a LAN caller where to connect. */
function localAddress() {
  try {
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.family === 'IPv4' && !entry.internal) return entry.address
      }
    }
  } catch {}
  return undefined
}

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
export function createHandler({ getContext, getConfig, getStore, rebind, log = () => {} }) {
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

  /**
   * The base URL to advertise to model clients.
   *
   * It must be the endpoint's own address, never the address the page was
   * served from: the page API now lives on the DSH web server, so deriving the
   * URL from the request host would hand out the DSH port, which serves no
   * /v1 at all.
   */
  function baseUrlFor(store) {
    const snapshot = store.snapshot()
    if (snapshot.baseUrl.length > 0) return snapshot.baseUrl
    const config = getConfig()
    const port = config.port || 0
    // Loopback mode is only reachable from this machine, so 127.0.0.1 is the
    // honest address. All-interfaces mode is for other machines: hand out a real
    // LAN address there, since 127.0.0.1 would be useless to the caller who
    // asked for it (and a machine's own loopback still works for its owner).
    if (snapshot.listen !== 'all') return 'http://127.0.0.1:' + port + '/v1'
    const lan = localAddress()
    return 'http://' + (lan ?? '127.0.0.1') + ':' + port + '/v1'
  }

  /** Serve the page-facing settings document. */
  async function serveSettings(ctx, req, res) {
    const store = getStore()
    const { rows, single } = await catalog(ctx)
    const doc = store.snapshot()
    sendJson(res, 200, {
      ok: true,
      settings: doc,
      baseUrl: baseUrlFor(store),
      lanAddress: localAddress() ?? null,
      port: getConfig().port || 0,
      singleProvider: single,
      models: rows,
    })
  }

  /**
   * Probe one model by actually calling it.
   *
   * A catalog entry proves the provider lists a model, not that the model
   * answers: a stale credential or a lapsed subscription fails only at request
   * time. So the test is a real, minimal generation -- the smallest call that
   * can still distinguish "works" from "fails", with a hard timeout so a hung
   * provider cannot hold the page open.
   * @param ctx - the harness context.
   * @param req - the request carrying { model }.
   * @param res - the response to answer on.
   */
  async function testModel(ctx, req, res) {
    const body = await readJson(req)
    const config = getConfig()
    const { rows, single } = await catalog(ctx)
    const requested = typeof body.model === 'string' ? body.model.trim() : ''
    if (requested.length === 0) {
      sendJson(res, 400, { ok: false, error: 'model is required' })
      return
    }
    const row = rows.find((entry) => entry.id === requested)
    if (row === undefined) {
      sendJson(res, 404, { ok: false, error: 'no such model: ' + requested })
      return
    }

    const providerIds = [...new Set(rows.map((entry) => entry.provider))]
    const route = { provider: row.provider, model: row.model }
    void single
    void providerIds

    const controller = new AbortController()
    // Bounded: a model that cannot answer within the budget is reported as
    // slow, which is what the user needs to know.
    const budget = Number(config.testTimeoutMs) > 0 ? Number(config.testTimeoutMs) : 30000
    let timer
    const started = Date.now()
    try {
      const stream = ctx.llm.stream({
        provider: route.provider,
        model: route.model,
        messages: [{ id: 'msg_probe', role: 'user', content: [{ type: 'text', text: 'ping' }], source: { kind: 'user' } }],
        maxTokens: 16,
        temperature: 0,
        signal: controller.signal,
      })
      let text = ''
      let finish = null
      let usage
      // Race the probe against its budget. Aborting the controller is only a
      // request to the adapter; a provider that ignores it would otherwise hold
      // the page open for as long as it likes.
      let expired = false
      const deadline = new Promise((resolve) => {
        timer = setTimeout(() => { expired = true; controller.abort(); resolve() }, budget)
        timer.unref?.()
      })
      const consume = (async () => {
        for await (const chunk of stream) {
          if (chunk.type === 'text-delta') text += chunk.text
          else if (chunk.type === 'reasoning-delta') text += chunk.text
          else if (chunk.type === 'usage') usage = chunk.usage
          else if (chunk.type === 'finish') finish = chunk.reason
        }
      })()
      await Promise.race([consume, deadline])
      const ms = Date.now() - started
      if (expired && finish === null) {
        sendJson(res, 200, {
          ok: false,
          ms,
          model: requested,
          error: 'no answer within ' + budget + 'ms',
          code: 'TIMEOUT',
        })
        return
      }
      if (finish !== null && (finish.kind === 'error' || finish.kind === 'aborted')) {
        const failure = finish.failure ?? {}
        sendJson(res, 200, {
          ok: false,
          ms,
          model: requested,
          error: String(failure.message ?? 'model call failed'),
          code: String(failure.code ?? finish.kind),
        })
        return
      }
      sendJson(res, 200, {
        ok: true,
        ms,
        model: requested,
        reply: text.slice(0, 200),
        ...(usage === undefined ? {} : { usage: { input: usage.inputTokens, output: usage.outputTokens } }),
      })
    } catch (error) {
      sendJson(res, 200, {
        ok: false,
        ms: Date.now() - started,
        model: requested,
        error: String(error?.message ?? error),
        code: String(error?.code ?? 'PROBE_FAILED'),
      })
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Replace the settings document from the page.
   *
   * A change of listen mode cannot be applied to a live socket, so the listener
   * is closed and reopened here. The reply reports the bound address so the
   * page never claims a state the process is not in.
   */
  async function saveSettings(ctx, req, res) {
    const body = await readJson(req)
    const store = getStore()
    const before = store.snapshot().listen
    const doc = store.replace(body)
    log('settings saved: ' + doc.keys.length + ' key(s), ' + doc.sharedModels.length + ' shared model(s)')
    if (doc.listen !== before && typeof rebind === 'function') {
      log('listen mode changed: ' + before + ' -> ' + doc.listen + ', rebinding')
      try {
        rebind()
      } catch (error) {
        log('rebind failed: ' + (error?.message ?? error))
      }
    }
    sendJson(res, 200, { ok: true, settings: doc, baseUrl: baseUrlFor(store) })
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

  /**
   * Resolve and authorize the model one request names.
   *
   * Shared by every protocol face (Chat Completions, Responses): they differ in
   * how a conversation is spelled, not in who may call what.
   * @param ctx - the harness context.
   * @param entry - the sharing key entry from the request.
   * @param body - the parsed request body.
   * @returns the route, the public model id, and the effective config.
   */
  async function authorizeModel(ctx, entry, body) {
    const store = getStore()
    const config = getConfig()

    if (!store.enabled) {
      throw new ProxyError(503, 'model sharing is paused; enable it on the Model Share page', { code: 'sharing_disabled', type: 'api_error' })
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
    return { route, publicId, config }
  }

  /** Build the harness request both protocol faces dispatch. */
  function harnessOptions(route, request, controller) {
    const options = {
      provider: route.provider,
      model: route.model,
      messages: request.messages,
      signal: controller.signal,
      sessionId: route.provider + ':' + randomUUID().replace(/-/g, ''),
    }
    if (request.system !== undefined) options.system = request.system
    if (request.tools !== undefined) options.tools = request.tools
    if (request.call.temperature !== undefined) options.temperature = request.call.temperature
    if (request.call.maxTokens !== undefined) options.maxTokens = request.call.maxTokens
    if (request.call.stop !== undefined) options.stop = request.call.stop
    if (request.reasoningEffort !== undefined) options.reasoningEffort = request.reasoningEffort
    return options
  }

  /** Serve POST /v1/chat/completions. */
  async function chatCompletions(ctx, req, res) {
    const store = getStore()
    const body = await readJson(req)
    const entry = store.matchKey(presentedKey(req))
    if (entry === undefined) {
      throw new ProxyError(401, 'invalid API key: create one on the DSH Model Share page', { code: 'invalid_api_key', type: 'authentication_error' })
    }
    const { route, publicId, config } = await authorizeModel(ctx, entry, body)

    const request = convertRequest(body, route, { toolResultStyle: config.toolResultStyle })
    const controller = new AbortController()
    res.on('close', () => { if (!res.writableEnded) controller.abort() })

    const id = 'chatcmpl-' + randomUUID().replace(/-/g, '')
    const created = Math.floor(Date.now() / 1000)
    const stream = ctx.llm.stream(harnessOptions(route, request, controller))
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

  /**
   * Serve POST /v1/responses (the OpenAI Responses API).
   *
   * Codex and other newer clients speak this instead of Chat Completions. It
   * encodes the same conversation in a flatter item list and streams a typed
   * event vocabulary, so it shares authorization with the chat route and
   * differs only in translation.
   */
  async function responses(ctx, req, res, entry) {
    const body = await readJson(req)
    const { route, publicId, config } = await authorizeModel(ctx, entry, body)
    const request = convertResponsesRequest(body, route, { toolResultStyle: config.toolResultStyle })

    const controller = new AbortController()
    res.on('close', () => { if (!res.writableEnded) controller.abort() })
    const id = 'resp_' + randomUUID().replace(/-/g, '')
    const created = Math.floor(Date.now() / 1000)
    const stream = ctx.llm.stream(harnessOptions(route, request, controller))
    log('responses ' + publicId + (request.stream ? ' stream' : '') + ' ' + request.messages.length + ' messages')

    if (!request.stream) {
      const response = await toResponsesObject(stream, { id, model: publicId, created })
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
    const writeEvent = (payload) => {
      if (closed) return false
      try {
        res.write('event: ' + payload.type + '\ndata: ' + JSON.stringify(payload) + '\n\n')
        return true
      } catch {
        closed = true
        return false
      }
    }
    const heartbeat = setInterval(() => { if (!closed) res.write(': keep-alive\n\n') }, HEARTBEAT_MS)
    heartbeat.unref?.()

    try {
      for await (const payload of toResponsesStream(stream, { id, model: publicId, created })) {
        if (!writeEvent(payload)) break
      }
    } catch (error) {
      log('responses stream failed: ' + (error?.message ?? error))
      if (!closed) {
        writeEvent({
          type: 'response.failed',
          sequence_number: 0,
          response: { id, object: 'response', created_at: created, model: publicId, status: 'failed', error: { code: String(error?.code ?? 'server_error'), message: String(error?.message ?? 'model call failed') }, output: [] },
        })
      }
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
      if (path === '/modelshare/api/test-model') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'use POST' })
          return
        }
        return await testModel(ctx, req, res)
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
          baseUrl: baseUrlFor(store),
          endpoints: ['/v1/models', '/v1/chat/completions', '/v1/responses'],
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

      if (path === '/v1/responses') {
        if (req.method !== 'POST') {
          sendJson(res, 405, errorBody(new ProxyError(405, 'use POST for /v1/responses')))
          return
        }
        await responses(ctx, req, res, entry)
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

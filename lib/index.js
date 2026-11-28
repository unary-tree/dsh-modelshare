/**
 * dsh-modelshare - share this DSH profile's models over a local
 * OpenAI-compatible endpoint, with a page to manage keys and model access.
 *
 * The endpoint is a second loopback listener, not a route on the DSH web
 * server: it exists for other software whose base URL points at it. Each call
 * is served through ctx.llm, so the providers the profile has already
 * connected are exactly the ones it can share.
 *
 * Two listeners, because the two audiences resolve addresses differently:
 * the OpenAI endpoint owns a port (other programs paste its base URL), while
 * the settings page's own API is registered on the DSH web server so the
 * browser reaches it same-origin without knowing any port.
 *
 * @module dsh-modelshare
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ShareStore } from './store.js'
import { createHandler, startServer } from './server.js'

export const name = 'modelshare'
/** ctx.llm serves the models; ctx.webServer carries the settings page's API. */
export const inject = ['llm', 'webServer']

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  defaultProvider: '',
  defaultModel: '',
  modelRoutes: {},
  includeUsage: true,
  logFile: '',
  settingsFile: '',
  toolResultStyle: 'tool-role',
  /** Budget for one model test from the page, in milliseconds. */
  testTimeoutMs: 30000,
}

/** Route prefix the settings page calls; served by the DSH web server. */
const PAGE_API_PREFIX = '/modelshare'

/** Live state across a hot reload: the previous listener is replaced, not stacked. */
const RUNTIME = (globalThis[Symbol.for('dsh.modelshare')] ??= { ctx: null, stop: null, store: null, port: 0, bind: '127.0.0.1' })

/** Append-only log with a size cap; never throws into the request path. */
function createLog(config) {
  const file = config.logFile || path.join(os.homedir(), '.dsh', 'storages', 'dsh-modelshare', 'modelshare.log')
  return (message) => {
    const line = '[' + new Date().toISOString() + '] ' + message + '\n'
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const stat = fs.existsSync(file) ? fs.statSync(file) : null
      if (stat && stat.size > 2 * 1024 * 1024) fs.writeFileSync(file, '')
      fs.appendFileSync(file, line)
    } catch {}
  }
}

/** The settings document path: config override, else the DSH home. */
function settingsPath(config) {
  if (typeof config.settingsFile === 'string' && config.settingsFile.length > 0) return config.settingsFile
  return path.join(os.homedir(), '.dsh', 'storages', 'dsh-modelshare', 'settings.json')
}

/**
 * Resolve the configured fallback route through the live provider registry.
 * @param ctx - the harness context.
 * @param config - plugin config.
 * @returns the provider/model pair used when a request omits its model.
 */
function defaultRoute(ctx, config) {
  let providers = []
  try { providers = ctx.llm.listProviders().map((provider) => provider.id) } catch {}
  if (config.defaultModel) {
    const slash = String(config.defaultModel).indexOf('/')
    if (config.defaultProvider) return { provider: config.defaultProvider, model: String(config.defaultModel) }
    if (slash > 0) return { provider: String(config.defaultModel).slice(0, slash), model: String(config.defaultModel).slice(slash + 1) }
    return { provider: providers[0], model: String(config.defaultModel) }
  }
  if (config.defaultProvider) return { provider: config.defaultProvider, model: '' }
  return { provider: providers[0], model: '' }
}

/** Build the effective server config from the plugin config and its defaults. */
function resolveConfig(config) {
  const merged = { ...DEFAULTS, ...config }
  merged.modelRoutes = { ...(config.modelRoutes ?? {}) }
  return merged
}

/**
 * Fill the default route from the profile's own model selection.
 * Resolved per request, not once at startup: the agent's default-model service
 * comes up after this plugin, so an apply-time read only ever sees nothing.
 * @param ctx - the harness context.
 * @param config - the resolved plugin config.
 * @returns a config whose defaultProvider/defaultModel are populated when possible.
 */
function withProfileDefault(ctx, config) {
  if (config.defaultProvider && config.defaultModel) return config
  let selection
  try { selection = ctx.agentDefaultModel?.currentSelection?.() } catch {}
  const merged = { ...config }
  if (selection && selection.provider && selection.model) {
    if (!merged.defaultProvider) merged.defaultProvider = selection.provider
    if (!merged.defaultModel) merged.defaultModel = selection.model
  }
  const fallback = defaultRoute(ctx, merged)
  merged.defaultProvider = fallback.provider ?? ''
  merged.defaultModel = fallback.model ?? ''
  return merged
}

/**
 * Plugin entry: start the listener and keep it pointed at the live context.
 * @param ctx - the plugin context (cordis).
 * @param config - plugin config; see DEFAULTS.
 */
export function apply(ctx, config = {}) {
  const log = createLog({ ...DEFAULTS, ...config })
  RUNTIME.ctx = ctx
  log('apply: sharing harness models over the OpenAI Chat Completions API')

  const settings = resolveConfig({ ...DEFAULTS, ...config })
  const store = new ShareStore({ file: settingsPath(settings), log })
  RUNTIME.store = store
  log('settings: ' + store.snapshot().keys.length + ' key(s) at ' + store.file)

  const handler = createHandler({
    getContext: () => RUNTIME.ctx,
    getConfig: () => withProfileDefault(RUNTIME.ctx ?? ctx, settings),
    getStore: () => RUNTIME.store,
    // Lets a settings save move the listener without waiting for a restart.
    rebind: () => bindEndpoint(),
    log,
  })

  /**
   * Bind now, and rebind whenever the page changes the listen mode.
   *
   * The address cannot be switched on a live socket, so the page's choice is
   * applied by closing this listener and opening the new one. Applying it at
   * the moment of the change keeps the page honest: what it reports is what is
   * bound, not what will be bound after a restart.
   */
  function bindEndpoint() {
    RUNTIME.stop?.()
    const listen = RUNTIME.store.snapshot().listen
    // 'all' is the unspecified address: reachable from other machines. Anything
    // else stays on loopback, the safe default.
    const host = listen === 'all' ? '0.0.0.0' : '127.0.0.1'
    RUNTIME.bind = host
    RUNTIME.stop = startServer({
      handler,
      host,
      port: Number(settings.port) || 0,
      log,
      onListen: (port) => {
        RUNTIME.port = port
        log('listening on http://' + host + ':' + port + '/v1')
      },
      onError: (error) => {
        RUNTIME.port = 0
        log('listener error: ' + (error?.message ?? error))
      },
    })
  }

  // The OpenAI endpoint: its own port, because other programs point a base URL
  // at it and it must keep that address across DSH restarts.
  ctx.effect(() => {
    bindEndpoint()
    return () => {
      log('stopping endpoint')
      RUNTIME.stop?.()
      RUNTIME.stop = null
      RUNTIME.port = 0
    }
  }, 'modelshare.endpoint')

  // The page's API: on the DSH web server, so the browser calls it same-origin.
  // A separate port would make every page request a cross-origin call that the
  // page cannot even address (it does not know the endpoint's port).
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PAGE_API_PREFIX,
    handler: (req, res) => handler(req, res),
  }), 'modelshare.page-api')
}

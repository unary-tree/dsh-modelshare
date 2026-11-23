/**
 * OpenAI <-> DeepSeek Harness wire mapping.
 *
 * Pure translation only: no DSH services, no HTTP. Everything the HTTP layer
 * needs to turn a Chat Completions request into GenerateOptions (and a DSH
 * StreamChunk sequence back into OpenAI chunks) lives here, so the mapping can
 * be exercised without a running harness.
 *
 * The harness vocabulary is provider-neutral but smaller than OpenAI's: a
 * message carries one role (system | user | assistant | tool), and content
 * blocks are text | reasoning | image | tool-call. Tool calls therefore ride on
 * the assistant message that produced them, while each tool result is a
 * distinct tool-role message answering exactly one call -- the shape every
 * shipped adapter serializes onto the OpenAI/Anthropic wires.
 */
import { randomUUID } from 'node:crypto'

/**
 * Message identity. The harness treats messages as immutable values; an id is
 * opaque, so a locally minted one is equivalent to the helper the harness
 * ships -- and keeps this plugin free of a dependency on an internal package.
 */
const newId = () => randomUUID()

/** A user-role message carrying text. */
const userMessage = (content) => ({ id: newId(), role: 'user', content, source: { kind: 'user' } })

/**
 * One message answering one tool call.
 *
 * The message vocabulary moved between harness releases, so the shape is
 * chosen by `toolResultStyle`:
 *
 * - `'tool-role'` (default, current releases): a distinct `role: 'tool'`
 *   message carrying `toolCallId`/`isError` at the top level. Adapters read
 *   those fields off the message.
 * - `'user-block'` (older releases): a `role: 'user'` message whose content is
 *   a single `tool-result` content block.
 *
 * Getting this wrong is silent: the call still succeeds, the model just never
 * sees the result. See README "换一台 DSH 安装" for how to switch.
 */
function toolResultMessage({ callId, text, isError }, style) {
  if (style === 'user-block') {
    return {
      id: newId(),
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) }],
      source: { kind: 'tool', callId },
    }
  }
  return {
    id: newId(),
    role: 'tool',
    content: [{ type: 'text', text }],
    source: { kind: 'tool', callId },
    toolCallId: callId,
    ...(isError ? { isError: true } : {}),
  }
}

/** An assistant message produced by the routed model. */
const assistantMessage = (content, provenance) => ({ id: newId(), role: 'assistant', content, source: { kind: 'model', ...provenance } })

/** An error that maps onto an OpenAI error body with a specific HTTP status. */
export class ProxyError extends Error {
  /**
   * @param status - HTTP status to answer with.
   * @param message - human-readable diagnostic.
   * @param options.code - OpenAI error code (invalid_request_error, not_found, ...).
   * @param options.param - request field that caused the failure, when known.
   * @param options.type - OpenAI error type.
   */
  constructor(status, message, options = {}) {
    super(message)
    this.name = 'ProxyError'
    this.status = status
    this.code = options.code ?? (status === 429 ? 'rate_limit_exceeded' : 'invalid_request_error')
    this.type = options.type ?? this.code
    this.param = options.param
  }
}

/** Flatten one OpenAI content value (string, or content-part array) to text. */
export function textOf(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts = []
    for (const part of value) {
      if (typeof part === 'string') parts.push(part)
      else if (part && typeof part === 'object') {
        if ((part.type === 'text' || part.type === 'input_text') && typeof part.text === 'string') parts.push(part.text)
        else if (typeof part.content === 'string') parts.push(part.content)
      }
    }
    return parts.join('')
  }
  return ''
}

/** Normalize a tool-call arguments value to the raw JSON string the harness stores. */
function argumentsText(value) {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return '{}'
  try { return JSON.stringify(value) } catch { return '{}' }
}

/** Normalize an OpenAI tool list (function-wrapped objects or bare schemas). */
function convertTools(tools) {
  if (tools === undefined) return undefined
  if (!Array.isArray(tools)) throw new ProxyError(400, "'tools' must be an array", { param: 'tools' })
  const out = []
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') throw new ProxyError(400, 'each tool must be an object', { param: 'tools' })
    const fn = tool.function && typeof tool.function === 'object' ? tool.function : tool
    if (typeof fn.name !== 'string' || fn.name.length === 0) throw new ProxyError(400, 'each tool needs a non-empty function name', { param: 'tools' })
    out.push({
      name: fn.name,
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters: fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} },
    })
  }
  return out.length > 0 ? out : undefined
}

/**
 * Split a public model id into a harness provider route and model id.
 *
 * Accepted spellings, most specific first:
 *   provider/model  (split at the first slash)
 *   a key of modelRoutes
 *   the single registered provider (when the deployment has exactly one)
 *   defaultProvider
 * @param raw - the model string from the request.
 * @param defaultProvider - configured fallback route.
 * @param providerIds - provider routes currently registered.
 * @param modelRoutes - explicit alias table from the plugin config.
 * @returns the provider route plus the model id the adapter receives.
 */
export function splitRoute(raw, defaultProvider, providerIds, modelRoutes = {}) {
  const model = String(raw).trim()
  if (Object.prototype.hasOwnProperty.call(modelRoutes, model)) {
    const routed = String(modelRoutes[model])
    const slash = routed.indexOf('/')
    if (slash > 0) return { provider: routed.slice(0, slash), model: routed.slice(slash + 1) }
    return { provider: defaultProvider ?? providerIds[0], model: routed }
  }
  const slash = model.indexOf('/')
  if (slash > 0 && slash < model.length - 1) {
    return { provider: model.slice(0, slash), model: model.slice(slash + 1) }
  }
  if (providerIds.includes(model)) return { provider: model, model }
  return { provider: defaultProvider ?? providerIds[0], model }
}

/**
 * Translate one OpenAI Chat Completions request into a harness call config
 * plus the conversation and tool schemas the harness adapter receives.
 * @param body - the parsed JSON request body.
 * @param route - the provider/model pair resolved for this request.
 * @param options - `toolResultStyle` selects the harness message vocabulary.
 * @returns everything required to build GenerateOptions.
 */
export function convertRequest(body, route, options = {}) {
  const toolResultStyle = options.toolResultStyle === 'user-block' ? 'user-block' : 'tool-role'
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ProxyError(400, 'request body must be a JSON object')
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new ProxyError(400, "'messages' must be a non-empty array", { param: 'messages' })
  }

  const { provider, model } = route
  const provenance = { provider, model }
  const systemParts = []
  const messages = []
  /** Each tool result is its own message, in call order. */
  const flushResults = () => {}

  for (const raw of body.messages) {
    if (!raw || typeof raw !== 'object') throw new ProxyError(400, 'each message must be an object', { param: 'messages' })
    const role = String(raw.role ?? '')
    if (role === 'system' || role === 'developer') {
      const text = textOf(raw.content)
      if (text.length > 0) systemParts.push(text)
      continue
    }
    if (role === 'user') {
      flushResults()
      const text = textOf(raw.content)
      if (text.length === 0) throw new ProxyError(400, 'user messages need non-empty text content', { param: 'messages' })
      messages.push(userMessage([{ type: 'text', text }]))
      continue
    }
    if (role === 'assistant') {
      flushResults()
      const content = []
      const text = textOf(raw.content)
      if (text.length > 0) content.push({ type: 'text', text })
      const calls = Array.isArray(raw.tool_calls) ? raw.tool_calls : []
      for (const call of calls) {
        const fn = call?.function ?? {}
        if (typeof fn.name !== 'string' || fn.name.length === 0) {
          throw new ProxyError(400, 'assistant tool_calls need a function name', { param: 'messages' })
        }
        content.push({
          type: 'tool-call',
          id: String(call.id ?? 'call_' + content.length),
          name: fn.name,
          arguments: argumentsText(fn.arguments),
        })
      }
      // A legacy function_call is the same block with a synthesized id.
      if (raw.function_call && calls.length === 0) {
        const fn = raw.function_call
        if (typeof fn.name === 'string' && fn.name.length > 0) {
          content.push({ type: 'tool-call', id: 'call_legacy_0', name: fn.name, arguments: argumentsText(fn.arguments) })
        }
      }
      if (content.length === 0) continue
      messages.push(assistantMessage(content, provenance))
      continue
    }
    if (role === 'tool' || role === 'function') {
      const text = textOf(raw.content) || '(no output)'
      messages.push(toolResultMessage({
        callId: String(raw.tool_call_id ?? raw.name ?? 'call_0'),
        text,
        isError: raw.is_error === true,
      }, toolResultStyle))
      continue
    }
    throw new ProxyError(400, "unsupported message role '" + role + "'", { param: 'messages' })
  }
  flushResults()

  if (messages.length === 0) {
    throw new ProxyError(400, 'the conversation contains no model-facing messages', { param: 'messages' })
  }

  const call = { provider, model }
  const system = systemParts.length > 0 ? systemParts.join('\n\n') : undefined
  const tools = convertTools(body.tools)
  if (typeof body.temperature === 'number' && Number.isFinite(body.temperature)) call.temperature = body.temperature
  const maxTokens = pickPositiveInteger(body.max_completion_tokens ?? body.max_tokens)
  if (maxTokens !== undefined) call.maxTokens = maxTokens
  const stop = normalizeStop(body.stop)
  if (stop !== undefined) call.stop = stop
  const level = pickReasoningEffort(body.reasoning_effort)

  return {
    call,
    messages,
    system,
    tools,
    reasoningEffort: level,
    stream: body.stream === true,
    streamOptions: body.stream_options && typeof body.stream_options === 'object' ? body.stream_options : undefined,
  }
}

/** Accept the OpenAI stop spellings (a string or a short list of strings). */
function normalizeStop(value) {
  if (value === undefined || value === null) return undefined
  const list = Array.isArray(value) ? value : [value]
  const out = list.filter((item) => typeof item === 'string' && item.length > 0)
  return out.length > 0 ? out.slice(0, 4) : undefined
}

/** Keep only sane positive integers for token caps. */
function pickPositiveInteger(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.floor(value)
}

/** Map OpenAI reasoning_effort onto the adapter's opaque effort ids. */
function pickReasoningEffort(value) {
  if (typeof value !== 'string') return undefined
  const level = value.trim().toLowerCase()
  if (level === 'none' || level === 'minimal' || level === 'off' || level.length === 0) return undefined
  return level
}

/** Map a harness finish reason onto the OpenAI finish_reason vocabulary. */
export function finishReasonOf(reason) {
  switch (reason?.kind) {
    case 'tool-calls': return 'tool_calls'
    case 'max-tokens': return 'length'
    case 'stop': return 'stop'
    default: return 'stop'
  }
}

/** Convert harness TokenUsage into the OpenAI usage object. */
export function usageOf(usage) {
  if (!usage) return undefined
  const cached = usage.cacheReadTokens ?? 0
  const written = usage.cacheWriteTokens ?? 0
  const prompt = (usage.inputTokens ?? 0) + cached + written
  const completion = usage.outputTokens ?? 0
  const out = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
  if (cached + written > 0) out.prompt_tokens_details = { cached_tokens: cached + written }
  if (usage.reasoningTokens !== undefined) out.completion_tokens_details = { reasoning_tokens: usage.reasoningTokens }
  return out
}

/** The OpenAI error envelope. */
export function errorBody(error) {
  const message = error instanceof Error ? error.message : String(error)
  const body = {
    error: {
      message,
      type: error?.type ?? 'invalid_request_error',
      code: error?.code ?? null,
    },
  }
  if (error?.param !== undefined) body.error.param = error.param
  return body
}

/**
 * Translate one DSH model stream into OpenAI chunks.
 *
 * Yields arrays of chunk objects per event so the caller can decide how to
 * frame them (SSE data lines, or a single assembled JSON response). A failing
 * finish becomes a thrown ProxyError: OpenAI clients expect the failure as an
 * error frame rather than a silently empty answer.
 * @param chunks - the harness chunk stream.
 * @param options.id - completion id for this response.
 * @param options.model - model id to echo back.
 * @param options.created - creation timestamp to echo back.
 * @param options.includeUsage - stream a trailing usage chunk (stream_options.include_usage).
 */
export async function* toOpenAiStream(chunks, options) {
  const { id, model, created, includeUsage } = options
  const base = { id, object: 'chat.completion.chunk', created, model }
  const toolIndex = new Map()
  const announced = new Set()
  let toolCount = 0
  let finish = null
  let usage

  yield [{ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }]

  for await (const chunk of chunks) {
    switch (chunk.type) {
      case 'block-start': {
        if (chunk.blockType === 'tool-call') {
          const next = toolCount++
          toolIndex.set(chunk.index, next)
          yield [{ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: next, id: '', type: 'function', function: { name: '', arguments: '' } }] }, finish_reason: null }] }]
        }
        break
      }
      case 'text-delta': {
        if (chunk.text.length === 0) break
        yield [{ ...base, choices: [{ index: 0, delta: { content: chunk.text }, finish_reason: null }] }]
        break
      }
      case 'reasoning-delta': {
        if (chunk.text.length === 0) break
        yield [{ ...base, choices: [{ index: 0, delta: { reasoning_content: chunk.text }, finish_reason: null }] }]
        break
      }
      case 'tool-call-delta': {
        const index = toolIndex.get(chunk.index) ?? toolCount
        // The id and the name describe the call once; only arguments stream on.
        const first = !announced.has(index)
        const call = { index, type: 'function' }
        if (first && chunk.id) call.id = String(chunk.id)
        if (first && chunk.name) call.function = { name: chunk.name }
        if (chunk.argumentsDelta) call.function = { ...(call.function ?? {}), arguments: chunk.argumentsDelta }
        if (first) announced.add(index)
        yield [{ ...base, choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }] }]
        break
      }
      case 'usage': {
        usage = usageOf(chunk.usage)
        break
      }
      case 'finish': {
        finish = chunk.reason
        break
      }
      default:
        break
    }
  }

  if (finish && (finish.kind === 'error' || finish.kind === 'aborted')) {
    const failure = finish.failure ?? {}
    throw new ProxyError(statusForFailure(failure), failure.message ?? 'model call failed', { code: failure.code ?? finish.kind, type: 'api_error' })
  }

  yield [{ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReasonOf(finish) }] }]
  if (includeUsage && usage) yield [{ ...base, choices: [], usage }]
}

/** Assemble a complete (non-streamed) OpenAI response from the harness stream. */
export async function toOpenAiResponse(chunks, options) {
  const { id, model, created } = options
  let text = ''
  let reasoning = ''
  let finish = null
  let usage
  const calls = new Map()

  for await (const chunk of chunks) {
    switch (chunk.type) {
      case 'block-start': {
        if (chunk.blockType === 'tool-call' && !calls.has(chunk.index)) {
          calls.set(chunk.index, { id: 'call_' + calls.size, name: '', arguments: '' })
        }
        break
      }
      case 'text-delta': text += chunk.text; break
      case 'reasoning-delta': reasoning += chunk.text; break
      case 'tool-call-delta': {
        const entry = calls.get(chunk.index) ?? { id: String(chunk.id ?? 'call_' + calls.size), name: '', arguments: '' }
        if (chunk.id) entry.id = String(chunk.id)
        if (chunk.name) entry.name = chunk.name
        if (chunk.argumentsDelta) entry.arguments += chunk.argumentsDelta
        calls.set(chunk.index, entry)
        break
      }
      case 'usage': usage = usageOf(chunk.usage); break
      case 'finish': finish = chunk.reason; break
      default: break
    }
  }

  if (finish && (finish.kind === 'error' || finish.kind === 'aborted')) {
    const failure = finish.failure ?? {}
    throw new ProxyError(statusForFailure(failure), failure.message ?? 'model call failed', { code: failure.code ?? finish.kind, type: 'api_error' })
  }

  const message = { role: 'assistant', content: text.length > 0 ? text : calls.size > 0 ? null : '' }
  if (reasoning.length > 0) message.reasoning_content = reasoning
  if (calls.size > 0) {
    message.tool_calls = [...calls.values()].map((call, index) => ({
      id: call.id || 'call_' + index,
      type: 'function',
      function: { name: call.name, arguments: call.arguments.length > 0 ? call.arguments : '{}' },
    }))
  }

  const response = {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReasonOf(finish), logprobs: null }],
  }
  if (usage !== undefined) response.usage = usage
  return response
}

/** HTTP status for a harness failure, so clients can retry what is retryable. */
export function statusForFailure(failure) {
  const code = String(failure?.code ?? '')
  if (code === 'AUTH' || code === 'MISSING_CREDENTIAL' || code === 'INVALID_CREDENTIAL') return 401
  if (code === 'RATE_LIMIT') return 429
  if (code === 'QUOTA_EXCEEDED') return 402
  if (code === 'CONTEXT_WINDOW_EXCEEDED') return 400
  if (code === 'NO_ADAPTER' || code === 'MODEL_NOT_FOUND') return 404
  const status = Number(failure?.status)
  if (Number.isInteger(status) && status >= 400 && status <= 599) return status
  return 502
}

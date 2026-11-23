/**
 * OpenAI Responses API <-> harness mapping.
 *
 * The Responses API is what Codex and newer OpenAI clients speak; Chat
 * Completions is what most older tools speak. Both encode the same
 * conversation, so this module converts a Responses request into the same
 * intermediate shape convertRequest() already produces, and renders the
 * harness stream as Responses events.
 *
 * Shape differences that matter here:
 * - input items are a flat list (messages AND tool calls/outputs), not nested
 *   messages with tool_calls arrays;
 * - tools are flat objects ({type:'function', name, parameters}), not
 *   wrapped in a `function` field;
 * - streaming is a typed event vocabulary (response.created, ...delta,
 *   ...completed) rather than uniform chat.completion.chunk objects.
 */
import { randomUUID } from 'node:crypto'
import { ProxyError, finishReasonOf, usageOf, textOf } from './wire.js'

const newId = () => 'msg_' + randomUUID().replace(/-/g, '')

/** A user-role message carrying text. */
const userMessage = (content) => ({ id: newId(), role: 'user', content, source: { kind: 'user' } })

/** An assistant message produced by the routed model. */
const assistantMessage = (content, provenance) => ({ id: newId(), role: 'assistant', content, source: { kind: 'model', ...provenance } })

/** One tool-role message answering one call. */
const toolMessage = ({ callId, text, isError }, style) => {
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

/**
 * Flatten one Responses `input` value to the item list it denotes.
 * A bare string is one user message; an array is already a list.
 * @param input - the request's `input` field.
 * @returns the input items.
 */
function inputItems(input) {
  if (typeof input === 'string') return [{ type: 'message', role: 'user', content: input }]
  return Array.isArray(input) ? input : []
}

/** Flatten a Responses content value (string or content-part array) to text. */
function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (typeof part === 'string') { parts.push(part); continue }
    if (part === null || typeof part !== 'object') continue
    // input_text is the Responses spelling; output_text is its reply spelling.
    if ((part.type === 'input_text' || part.type === 'text' || part.type === 'output_text') && typeof part.text === 'string') {
      parts.push(part.text)
      continue
    }
    if (typeof part.content === 'string') parts.push(part.content)
  }
  return parts.join('')
}

/**
 * Normalize Responses tools to the harness ToolSchema list.
 * Functions arrive flat: {type:'function', name, description, parameters}.
 * @param tools - the request's tools array.
 * @returns harness tool schemas, or undefined when none apply.
 */
function convertTools(tools) {
  if (!Array.isArray(tools)) return undefined
  const out = []
  for (const tool of tools) {
    if (tool === null || typeof tool !== 'object') continue
    // Hosted tools (web_search, file_search, ...) have no harness equivalent.
    if (tool.type !== 'function') continue
    const name = typeof tool.name === 'string' ? tool.name : ''
    if (name.length === 0) continue
    out.push({
      name,
      description: typeof tool.description === 'string' ? tool.description : '',
      parameters: tool.parameters && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} },
    })
  }
  return out.length > 0 ? out : undefined
}

/**
 * Translate one Responses request into a harness call.
 * @param body - the parsed JSON request body.
 * @param route - the provider/model pair resolved for this request.
 * @param options - `toolResultStyle` selects the harness message vocabulary.
 * @returns the call config, conversation, and stream flag.
 */
export function convertResponsesRequest(body, route, options = {}) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ProxyError(400, 'request body must be a JSON object')
  }
  const toolResultStyle = options.toolResultStyle === 'user-block' ? 'user-block' : 'tool-role'
  const { provider, model } = route
  const provenance = { provider, model }

  // `instructions` is the system prompt; it may also arrive as a system message.
  const systemParts = []
  if (typeof body.instructions === 'string' && body.instructions.trim().length > 0) systemParts.push(body.instructions)

  const messages = []
  let sawModelFacing = false

  for (const item of inputItems(body.input)) {
    if (item === null || typeof item !== 'object') continue
    const type = typeof item.type === 'string' ? item.type : (item.role ? 'message' : '')

    if (type === 'message' || type === '') {
      const role = String(item.role ?? 'user')
      const text = contentText(item.content)
      if (role === 'system' || role === 'developer') {
        if (text.length > 0) systemParts.push(text)
        continue
      }
      if (role === 'assistant') {
        if (text.length === 0) continue
        messages.push(assistantMessage([{ type: 'text', text }], provenance))
        sawModelFacing = true
        continue
      }
      if (text.length === 0) continue
      messages.push(userMessage([{ type: 'text', text }]))
      sawModelFacing = true
      continue
    }

    // A previous assistant turn's tool call, replayed from history.
    if (type === 'function_call') {
      const callId = String(item.call_id ?? item.id ?? 'call_' + messages.length)
      const name = String(item.name ?? '')
      if (name.length === 0) continue
      const args = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {})
      messages.push(assistantMessage([{ type: 'tool-call', id: callId, name, arguments: args }], provenance))
      sawModelFacing = true
      continue
    }

    // The tool's answer.
    if (type === 'function_call_output') {
      const callId = String(item.call_id ?? 'call_0')
      const text = contentText(item.output) || '(no output)'
      messages.push(toolMessage({ callId, text, isError: false }, toolResultStyle))
      sawModelFacing = true
      continue
    }

    // Reasoning items are replayed state the harness rebuilds itself.
    if (type === 'reasoning') continue
  }

  if (!sawModelFacing) {
    throw new ProxyError(400, "'input' contains no model-facing content", { param: 'input' })
  }

  const call = { provider, model }
  if (typeof body.temperature === 'number' && Number.isFinite(body.temperature)) call.temperature = body.temperature
  const maxTokens = Number.isSafeInteger(body.max_output_tokens) && body.max_output_tokens > 0 ? body.max_output_tokens : undefined
  if (maxTokens !== undefined) call.maxTokens = maxTokens

  return {
    call,
    messages,
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    tools: convertTools(body.tools),
    reasoningEffort: typeof body.reasoning?.effort === 'string' ? body.reasoning.effort : undefined,
    stream: body.stream === true,
  }
}

const statusOf = (id) => ({ id, object: 'response', created_at: Math.floor(Date.now() / 1000) })

/**
 * Render the harness stream as Responses API server-sent events.
 * @param chunks - the harness chunk stream.
 * @param options - response identity plus the model to echo back.
 */
export async function* toResponsesStream(chunks, options) {
  const { id, model, created } = options
  const response = { ...statusOf(id), model, status: 'in_progress', output: [] }
  let sequence = 0
  const next = () => sequence++
  let text = ''
  let reasoning = ''
  let outputIndex = 0
  let textItemOpen = false
  let reasoningItemOpen = false
  let finish = null
  let usage
  const calls = new Map()

  const wrap = (type, extra) => ({ type, sequence_number: next(), ...extra })

  yield wrap('response.created', { response: { ...response } })
  yield wrap('response.in_progress', { response: { ...response } })

  for await (const chunk of chunks) {
    switch (chunk.type) {
      case 'block-start': {
        if (chunk.blockType === 'reasoning' && !reasoningItemOpen) {
          reasoningItemOpen = true
          yield wrap('response.output_item.added', {
            output_index: outputIndex,
            item: { id: 'rs_' + outputIndex, type: 'reasoning', summary: [] },
          })
        }
        if (chunk.blockType === 'text' && !textItemOpen) {
          textItemOpen = true
          yield wrap('response.output_item.added', {
            output_index: outputIndex,
            item: { id: 'msg_' + outputIndex, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
          })
        }
        if (chunk.blockType === 'tool-call') {
          calls.set(chunk.index, { id: 'fc_' + outputIndex, callId: '', name: '', arguments: '' })
        }
        break
      }
      case 'text-delta': {
        if (chunk.text.length === 0) break
        text += chunk.text
        yield wrap('response.output_text.delta', { item_id: 'msg_' + outputIndex, output_index: outputIndex, content_index: 0, delta: chunk.text })
        break
      }
      case 'reasoning-delta': {
        if (chunk.text.length === 0) break
        reasoning += chunk.text
        yield wrap('response.reasoning_summary_text.delta', { item_id: 'rs_' + outputIndex, output_index: outputIndex, summary_index: 0, delta: chunk.text })
        break
      }
      case 'tool-call-delta': {
        const entry = calls.get(chunk.index) ?? { id: 'fc_' + outputIndex, callId: '', name: '', arguments: '' }
        if (chunk.id) entry.callId = String(chunk.id)
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
    const failed = { ...statusOf(id), model, status: 'failed', error: { code: String(failure.code ?? 'server_error'), message: String(failure.message ?? 'model call failed') }, output: [] }
    yield wrap('response.failed', { response: failed })
    return
  }

  const output = []
  if (reasoning.length > 0) {
    output.push({ id: 'rs_0', type: 'reasoning', summary: [{ type: 'summary_text', text: reasoning }] })
    yield wrap('response.reasoning_summary_text.done', { item_id: 'rs_0', output_index: 0, summary_index: 0, text: reasoning })
  }
  if (text.length > 0) {
    const index = output.length
    output.push({ id: 'msg_' + index, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] })
    yield wrap('response.output_text.done', { item_id: 'msg_' + index, output_index: index, content_index: 0, text })
  }
  for (const entry of calls.values()) {
    if (entry.name.length === 0) continue
    const index = output.length
    const callId = entry.callId.length > 0 ? entry.callId : 'call_' + index
    output.push({ id: entry.id, type: 'function_call', call_id: callId, name: entry.name, arguments: entry.arguments.length > 0 ? entry.arguments : '{}', status: 'completed' })
  }

  const completed = {
    ...statusOf(id),
    model,
    status: 'completed',
    output,
    usage: usage === undefined ? null : {
      input_tokens: usage.prompt_tokens,
      output_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
    },
  }
  yield wrap('response.output_item.done', { output_index: output.length > 0 ? output.length - 1 : 0, item: output.at(-1) ?? null })
  yield wrap('response.completed', { response: completed })
}

/** Assemble a complete (non-streamed) Response object. */
export async function toResponsesObject(chunks, options) {
  const { id, model } = options
  let text = ''
  let reasoning = ''
  let finish = null
  let usage
  const calls = new Map()

  for await (const chunk of chunks) {
    switch (chunk.type) {
      case 'block-start': {
        if (chunk.blockType === 'tool-call' && !calls.has(chunk.index)) calls.set(chunk.index, { callId: '', name: '', arguments: '' })
        break
      }
      case 'text-delta': text += chunk.text; break
      case 'reasoning-delta': reasoning += chunk.text; break
      case 'tool-call-delta': {
        const entry = calls.get(chunk.index) ?? { callId: '', name: '', arguments: '' }
        if (chunk.id) entry.callId = String(chunk.id)
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
    throw new ProxyError(502, String(failure.message ?? 'model call failed'), { code: String(failure.code ?? 'server_error'), type: 'api_error' })
  }

  const output = []
  if (reasoning.length > 0) output.push({ id: 'rs_0', type: 'reasoning', summary: [{ type: 'summary_text', text: reasoning }] })
  if (text.length > 0) output.push({ id: 'msg_' + output.length, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] })
  for (const entry of calls.values()) {
    if (entry.name.length === 0) continue
    output.push({ id: 'fc_' + output.length, type: 'function_call', call_id: entry.callId || 'call_' + output.length, name: entry.name, arguments: entry.arguments.length > 0 ? entry.arguments : '{}', status: 'completed' })
  }

  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: 'completed',
    output,
    error: null,
    incomplete_details: finish?.kind === 'max-tokens' ? { reason: 'max_output_tokens' } : null,
    ...(usage === undefined ? {} : { usage: { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, total_tokens: usage.total_tokens } }),
  }
}

/** Map a finish reason onto the Responses `status` vocabulary. */
export { finishReasonOf }

import { apply } from '../lib/index.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function fakeStream(options) {
  const last = [...options.messages].reverse().find((m) => m.role === 'user')
  const text = last?.content?.find?.((b) => b.type === 'text')?.text ?? ''
  return (async function* () {
    if (text.includes('weather')) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: 'call_r1', name: 'get_weather', argumentsDelta: '{"city":"Paris"}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_r1', name: 'get_weather', arguments: '{"city":"Paris"}' } }
      yield { type: 'usage', usage: { inputTokens: 9, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'echo: ' + text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'echo: ' + text } }
    yield { type: 'usage', usage: { inputTokens: 6, outputTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

const routes = []
const ctx = {
  effect: (f) => f(), inject() {},
  webServer: { register: (r) => { routes.push(r); return () => {} }, tapIndex: () => () => {} },
  agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'm1' }) },
  llm: {
    listProviders: () => [{ id: 'fake', name: 'Fake' }],
    listModels: async () => [{ provider: 'fake', id: 'm1', name: 'M1' }],
    stream: fakeStream,
  },
}

const dir = mkdtempSync(join(tmpdir(), 'ms-resp-'))
apply(ctx, { port: 18789, settingsFile: join(dir, 's.json'), logFile: join(dir, 'l.log') })
await new Promise((r) => setTimeout(r, 500))

const base = 'http://127.0.0.1:18789'
const post = async (path, body, key) => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) }, body: JSON.stringify(body) })
  const text = await res.text()
  return { status: res.status, text }
}
const created = await (await fetch(base + '/modelshare/api/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()
const key = created.entry.key

const out = []
const check = (n, ok, d = '') => { out.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' -- ' + d : '')) }

// Non-streaming
const plain = await post('/v1/responses', { model: 'fake/m1', input: 'hello there' }, key)
const parsed = JSON.parse(plain.text)
check('responses: non-streaming returns a response object', plain.status === 200 && parsed.object === 'response' && parsed.status === 'completed', plain.text.slice(0, 200))
check('responses: text is in output', parsed.output?.some((o) => o.type === 'message' && o.content?.[0]?.text === 'echo: hello there'), JSON.stringify(parsed.output))
check('responses: usage reported', parsed.usage?.total_tokens === 9, JSON.stringify(parsed.usage))

// Streaming
const streamed = await post('/v1/responses', { model: 'fake/m1', input: 'hi', stream: true }, key)
const events = streamed.text.split('\n\n').filter((b) => b.includes('data: ')).map((b) => JSON.parse(b.slice(b.indexOf('data: ') + 6)))
const types = events.map((e) => e.type)
check('responses: stream emits created', types.includes('response.created'), JSON.stringify(types.slice(0, 6)))
check('responses: stream emits text deltas', types.includes('response.output_text.delta'))
check('responses: stream completes', types.includes('response.completed'))
const completed = events.find((e) => e.type === 'response.completed')
check('responses: completed carries full text', completed?.response?.output?.some((o) => o.content?.[0]?.text === 'echo: hi'), JSON.stringify(completed?.response?.output))

// Tools
const tools = await post('/v1/responses', {
  model: 'fake/m1',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'weather?' }] }],
  tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }],
}, key)
const toolObj = JSON.parse(tools.text)
const call = toolObj.output?.find((o) => o.type === 'function_call')
check('responses: function_call emitted', call?.name === 'get_weather' && call?.arguments === '{"city":"Paris"}', JSON.stringify(toolObj.output))

// Tool output round-trip
const round = await post('/v1/responses', {
  model: 'fake/m1',
  input: [
    { type: 'message', role: 'user', content: 'weather?' },
    { type: 'function_call', call_id: 'call_r1', name: 'get_weather', arguments: '{"city":"Paris"}' },
    { type: 'function_call_output', call_id: 'call_r1', output: 'SECRET_42' },
  ],
}, key)
// The stub answers any "weather" prompt with a tool call, so the proof that the
// output was accepted is a completed response, not echoed text.
const roundObj = JSON.parse(round.text)
check('responses: function_call_output accepted', round.status === 200 && roundObj.status === 'completed', round.text.slice(0, 150))

// Auth still enforced
const noKey = await post('/v1/responses', { model: 'fake/m1', input: 'hi' })
check('responses: needs a key', noKey.status === 401, String(noKey.status))

rmSync(dir, { recursive: true, force: true })
const failed = out.filter((x) => !x).length
console.log('\n' + (out.length - failed) + '/' + out.length + ' checks passed')
process.exit(failed === 0 ? 0 : 1)

/**
 * End-to-end test with a fake harness context.
 *
 * Runs the real plugin, the real HTTP layer, and the real store against a stub
 * ctx.llm, so the sharing rules (key auth, model allow-list, pause switch) and
 * the OpenAI wire mapping are all exercised without a booted harness.
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { ShareStore, coerceDocument, uniqueModels } from '../lib/store.js'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' -- ' + detail : ''))
}

/** A stub model that echoes the last user text, and can emit a tool call. */
function fakeStream(options) {
  const lastUser = [...options.messages].reverse().find((m) => m.role === 'user')
  const text = lastUser?.content.find((b) => b.type === 'text')?.text ?? ''
  const wantsTool = text.includes('weather')
  return (async function* () {
    if (wantsTool) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'get_weather', argumentsDelta: '{"city":"Paris"}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' } }
      yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'echo: ' + text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'echo: ' + text } }
    yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

const ctx = {
  effect: (factory) => factory(),
  inject() {},
  agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'm1' }) },
  llm: {
    listProviders: () => [{ id: 'fake', name: 'Fake' }, { id: 'other', name: 'Other' }],
    listModels: async (provider) => provider === 'fake'
      ? [{ provider: 'fake', id: 'm1', name: 'Model One' }, { provider: 'fake', id: 'm2', name: 'Model Two' }]
      : [{ provider: 'other', id: 'x1', name: 'X One' }],
    stream: fakeStream,
  },
}

const dir = mkdtempSync(join(tmpdir(), 'modelshare-'))
const settingsFile = join(dir, 'settings.json')
apply(ctx, { port: 18788, settingsFile, logFile: join(dir, 'test.log') })
await new Promise((resolve) => setTimeout(resolve, 500))

const base = 'http://127.0.0.1:18788'
const json = async (path, init) => {
  const res = await fetch(base + path, init)
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { body = { raw: text } }
  return { status: res.status, body }
}

try {
  // --- page API ---
  const settings = await json('/modelshare/api/settings')
  check('settings endpoint answers', settings.status === 200 && settings.body.ok === true)
  check('catalog lists every provider model', settings.body.models.length === 3, JSON.stringify(settings.body.models?.map((m) => m.id)))
  check('base url is advertised', /^http:\/\/[^/]+\/v1$/.test(settings.body.baseUrl ?? ''), settings.body.baseUrl)

  // --- key lifecycle ---
  const created = await json('/modelshare/api/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  const key = created.body.entry?.key ?? ''
  check('a key can be generated', created.status === 200 && key.startsWith('ms-') && key.length > 20, key.slice(0, 12) + '...')
  check('key is persisted to disk', JSON.parse(readFileSync(settingsFile, 'utf8')).keys.length === 1)

  // --- auth ---
  const noKey = await json('/v1/models')
  check('models needs a key', noKey.status === 401)
  const wrongKey = await json('/v1/models', { headers: { authorization: 'Bearer nope' } })
  check('a wrong key is rejected', wrongKey.status === 401)
  const okKey = await json('/v1/models', { headers: { authorization: 'Bearer ' + key } })
  check('the right key lists models', okKey.status === 200 && okKey.body.data.length === 3, JSON.stringify(okKey.body.data?.map((m) => m.id)))

  // --- chat ---
  const chat = await json('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({ model: 'fake/m1', messages: [{ role: 'user', content: 'hi' }] }),
  })
  check('chat completes', chat.status === 200 && chat.body.choices?.[0]?.message?.content === 'echo: hi', JSON.stringify(chat.body).slice(0, 160))

  // --- allow-list ---
  const restricted = await json('/modelshare/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true, baseUrl: '', keys: [{ key, label: '', models: [], createdAt: new Date().toISOString() }], sharedModels: ['fake/m1'] }),
  })
  check('allow-list saves', restricted.status === 200 && restricted.body.settings.sharedModels.length === 1)
  const filtered = await json('/v1/models', { headers: { authorization: 'Bearer ' + key } })
  check('models are filtered by the allow-list', filtered.body.data.length === 1 && filtered.body.data[0].id === 'fake/m1', JSON.stringify(filtered.body.data?.map((m) => m.id)))
  const blocked = await json('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({ model: 'fake/m2', messages: [{ role: 'user', content: 'hi' }] }),
  })
  check('a blocked model is refused', blocked.status === 403 && blocked.body.error?.code === 'model_not_allowed', JSON.stringify(blocked.body).slice(0, 120))
  const allowed = await json('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({ model: 'fake/m1', messages: [{ role: 'user', content: 'hi' }] }),
  })
  check('an allowed model still works', allowed.status === 200)

  // --- pause switch ---
  await json('/modelshare/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false, baseUrl: '', keys: [{ key, label: '', models: [], createdAt: new Date().toISOString() }], sharedModels: [] }),
  })
  const paused = await json('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({ model: 'fake/m1', messages: [{ role: 'user', content: 'hi' }] }),
  })
  check('the pause switch stops sharing', paused.status === 503 && paused.body.error?.code === 'sharing_disabled', JSON.stringify(paused.body).slice(0, 120))

  // --- streaming still works ---
  await json('/modelshare/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true, baseUrl: '', keys: [{ key, label: '', models: [], createdAt: new Date().toISOString() }], sharedModels: [] }),
  })
  const streamRes = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({ model: 'fake/m1', stream: true, messages: [{ role: 'user', content: 'yo' }] }),
  })
  const streamText = await streamRes.text()
  const frames = streamText.split('\n\n').filter((f) => f.startsWith('data: ')).map((f) => f.slice(6))
  const joined = frames.filter((f) => f !== '[DONE]').map((f) => JSON.parse(f)).map((c) => c.choices?.[0]?.delta?.content ?? '').join('')
  check('streaming reassembles', joined === 'echo: yo' && streamText.includes('[DONE]'), JSON.stringify(joined))

  // --- key deletion ---
  const deleted = await json('/modelshare/api/keys?key=' + encodeURIComponent(key), { method: 'DELETE' })
  check('a key can be deleted', deleted.status === 200)
  const afterDelete = await json('/v1/models', { headers: { authorization: 'Bearer ' + key } })
  check('a deleted key stops working', afterDelete.status === 401)

  // --- store unit behaviour ---
  check('uniqueModels dedupes and trims', JSON.stringify(uniqueModels([' a ', 'a', '', 'b'])) === '["a","b"]')
  check('coerceDocument tolerates junk', coerceDocument({ keys: 'nope', sharedModels: null }).keys.length === 0)
  const store = new ShareStore({ file: join(dir, 'unit.json') })
  const entry = store.addKey({ label: 'x' })
  check('a fresh key is unrestricted', store.allowedModels(entry) === undefined && store.permits(entry, 'anything') === true)
  store.replace({ enabled: true, sharedModels: ['a'], keys: [{ key: entry.key, label: '', models: ['b'], createdAt: '' }] })
  check('key models union with shared models', JSON.stringify(store.allowedModels(store.snapshot().keys[0])) === '["a","b"]')
} finally {
  rmSync(dir, { recursive: true, force: true })
  const failed = results.filter((r) => !r.ok)
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed')
  process.exit(failed.length === 0 ? 0 : 1)
}

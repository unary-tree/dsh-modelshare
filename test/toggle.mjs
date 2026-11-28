// End-to-end: flip the switch over HTTP and prove the endpoint honours it.
import { apply } from '../lib/index.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = []
const check = (n, ok, d = '') => { out.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' -- ' + d : '')) }

function fakeStream(options) {
  const last = [...options.messages].reverse().find((m) => m.role === 'user')
  const text = last?.content?.[0]?.text ?? ''
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'echo: ' + text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'echo: ' + text } }
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

const ctx = {
  effect: (f) => f(), inject() {},
  webServer: { register: () => () => {}, tapIndex: () => () => {} },
  agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'm1' }) },
  llm: {
    listProviders: () => [{ id: 'fake', name: 'Fake' }],
    listModels: async () => [{ provider: 'fake', id: 'm1', name: 'M1' }],
    stream: fakeStream,
  },
}

const dir = mkdtempSync(join(tmpdir(), 'ms-toggle-'))
apply(ctx, { port: 18791, settingsFile: join(dir, 's.json'), logFile: join(dir, 'l.log') })
await new Promise((r) => setTimeout(r, 500))

const base = 'http://127.0.0.1:18791'
const created = await (await fetch(base + '/modelshare/api/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()
const key = created.entry.key
const call = async () => {
  const res = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({ model: 'fake/m1', messages: [{ role: 'user', content: 'hi' }] }),
  })
  return { status: res.status, body: await res.json() }
}

const before = await call()
check('sharing on: request succeeds', before.status === 200, String(before.status))

// Turn it off through the same API the page uses.
await fetch(base + '/modelshare/api/settings', {
  method: 'PUT', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ enabled: false, sharedModels: [], baseUrl: '', keys: [{ key, label: '', models: [], createdAt: '' }] }),
})
const off = await call()
check('sharing off: chat is refused', off.status === 503 && off.body.error?.code === 'sharing_disabled', JSON.stringify(off.body).slice(0, 120))

const modelsOff = await fetch(base + '/v1/models', { headers: { authorization: 'Bearer ' + key } })
check('sharing off: the switch survives', (await (await fetch(base + '/modelshare/api/settings')).json()).settings.enabled === false)

// Back on.
await fetch(base + '/modelshare/api/settings', {
  method: 'PUT', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ enabled: true, sharedModels: [], baseUrl: '', keys: [{ key, label: '', models: [], createdAt: '' }] }),
})
const after = await call()
check('sharing back on: request works again', after.status === 200, String(after.status))
check('turning off keeps the key valid', modelsOff.status === 200 || modelsOff.status === 503, String(modelsOff.status))

// The file on disk records the switch.
const doc = JSON.parse((await import('node:fs')).readFileSync(join(dir, 's.json'), 'utf8'))
check('switch persists to the settings file', doc.enabled === true)

rmSync(dir, { recursive: true, force: true })
const failed = out.filter((x) => !x).length
console.log('\n' + (out.length - failed) + '/' + out.length + ' checks passed')
process.exit(failed === 0 ? 0 : 1)

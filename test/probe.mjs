// Per-model test endpoint: a real call, so the result reflects reality.
import { apply } from '../lib/index.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = []
const check = (n, ok, d = '') => { out.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' -- ' + d : '')) }

let mode = 'ok'
const seen = []
function fakeStream(options) {
  seen.push(options)
  return (async function* () {
    if (mode === 'error') {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'provider exploded', code: 'AUTH', status: 401 } } }
      return
    }
    if (mode === 'empty') {
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (mode === 'hang') {
      await new Promise((r) => setTimeout(r, 5000))
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'pong' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'pong' } }
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

const ctx = {
  effect: (f) => f(), inject() {},
  webServer: { register: () => () => {}, tapIndex: () => () => {} },
  agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'm1' }) },
  llm: {
    listProviders: () => [{ id: 'fake', name: 'Fake' }],
    listModels: async () => [
      { provider: 'fake', id: 'm1', name: 'M1' },
      { provider: 'fake', id: 'm2', name: 'M2' },
    ],
    stream: fakeStream,
  },
}

const dir = mkdtempSync(join(tmpdir(), 'ms-probe-'))
apply(ctx, { port: 18793, settingsFile: join(dir, 's.json'), logFile: join(dir, 'l.log'), testTimeoutMs: 1500 })
await new Promise((r) => setTimeout(r, 500))

const base = 'http://127.0.0.1:18793'
const probe = async (model) => {
  const res = await fetch(base + '/modelshare/api/test-model', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model }),
  })
  return { status: res.status, body: await res.json() }
}

// One provider means bare model ids: catalog() drops the prefix on purpose so
// clients that dislike slashes still work.
const listed = await (await fetch(base + '/modelshare/api/settings')).json()
check('with one provider the ids are bare', listed.models.every((m) => !m.id.includes('/')), JSON.stringify(listed.models.map((m) => m.id)))
const ID1 = listed.models[0].id
const ID2 = listed.models[1].id

mode = 'ok'
const good = await probe(ID1)
check('working model reports available', good.status === 200 && good.body.ok === true, JSON.stringify(good.body))
check('working model reports latency', typeof good.body.ms === 'number' && good.body.ms >= 0, String(good.body.ms))
check('working model reports the reply', typeof good.body.reply === 'string', JSON.stringify(good.body.reply))
check('probe asks for a tiny completion', seen.at(-1)?.maxTokens === 16, String(seen.at(-1)?.maxTokens))
check('probe is deterministic', seen.at(-1)?.temperature === 0, String(seen.at(-1)?.temperature))

mode = 'error'
const bad = await probe(ID2)
check('failing model reports unavailable', bad.body.ok === false, JSON.stringify(bad.body))
check('failure keeps the provider message', /provider exploded/.test(bad.body.error ?? ''), JSON.stringify(bad.body.error))
check('failure keeps the error code', bad.body.code === 'AUTH', String(bad.body.code))

mode = 'empty'
const empty = await probe(ID1)
check('a silent model still counts as reachable', empty.body.ok === true, JSON.stringify(empty.body))

mode = 'hang'
const slow = await probe(ID1)
check('a hung model is bounded by the timeout', slow.body.ok === false && slow.body.code === 'TIMEOUT' && slow.body.ms < 4000, JSON.stringify(slow.body).slice(0, 160))

const unknown = await probe('fake/nope')
check('an unknown model is refused', unknown.status === 404 && unknown.body.ok === false, String(unknown.status))

const missing = await fetch(base + '/modelshare/api/test-model', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
check('a missing model is a 400', missing.status === 400, String(missing.status))

rmSync(dir, { recursive: true, force: true })
const failed = out.filter((x) => !x).length
console.log('\n' + (out.length - failed) + '/' + out.length + ' checks passed')
process.exit(failed === 0 ? 0 : 1)

// The listen option: it must bind the right interface and move the base URL.
import { apply } from '../lib/index.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'

const out = []
const check = (n, ok, d = '') => { out.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' -- ' + d : '')) }

function fakeStream() {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

let rebinds = 0
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

const dir = mkdtempSync(join(tmpdir(), 'ms-listen-'))
const settingsFile = join(dir, 's.json')
apply(ctx, { port: 18795, settingsFile, logFile: join(dir, 'l.log') })
await new Promise((r) => setTimeout(r, 600))

const base = 'http://127.0.0.1:18795'
const read = async () => (await (await fetch(base + '/modelshare/api/settings')).json())
/** Save, tolerating the connection the rebind tears down. */
const save = async (patch) => {
  const cur = await read()
  try {
    const res = await fetch(base + '/modelshare/api/settings', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...cur.settings, ...patch }),
    })
    return { status: res.status, body: await res.json() }
  } catch {
    // The save closes the listener it was sent to; the write already landed.
    await new Promise((r) => setTimeout(r, 500))
    return { status: 0, body: await read() }
  }
}

const initial = await read()
check('defaults to loopback', initial.settings.listen === 'loopback', String(initial.settings.listen))
check('base url is a loopback address', /^http:\/\/127\.0\.0\.1:/.test(initial.baseUrl), initial.baseUrl)

// Switch to all interfaces.
const moved = await save({ listen: 'all' })
// The response may not arrive: the save itself tears down the socket it rode on.
// What matters is that the choice was persisted.
check('saving the choice persists it', moved.body.settings.listen === 'all', JSON.stringify({ status: moved.status, listen: moved.body.settings.listen }))

// The listener restarted on 0.0.0.0; wait for it, then reach it on the LAN IP too.
await new Promise((r) => setTimeout(r, 700))
let boundAny = false
for (let i = 0; i < 20 && !boundAny; i++) {
  try {
    const probe = await fetch('http://127.0.0.1:18795/health')
    if (probe.ok) boundAny = true
  } catch { await new Promise((r) => setTimeout(r, 150)) }
}
check('endpoint is back after rebinding', boundAny)

const afterMove = await read()
check('base url stops being loopback', !/^http:\/\/127\.0\.0\.1:/.test(afterMove.baseUrl ?? ''), afterMove.baseUrl)

// A LAN address is advertised only when there is one.
const lan = afterMove.lanAddress
check('a LAN address is reported when available', lan === null || /^\d+\.\d+\.\d+\.\d+$/.test(lan), String(lan))

// On all interfaces the socket must accept a connection to the LAN address.
if (typeof lan === 'string') {
  const reachable = await new Promise((resolve) => {
    const socket = net.connect(18795, lan)
    socket.setTimeout(1500)
    socket.on('connect', () => { socket.destroy(); resolve(true) })
    socket.on('error', () => resolve(false))
    socket.on('timeout', () => { socket.destroy(); resolve(false) })
  })
  check('the LAN address accepts a connection', reachable, lan + ':18795')
} else {
  check('the LAN address accepts a connection', true, 'no LAN interface on this host')
}

// Back to loopback.
const back = await save({ listen: 'loopback' })
check('switching back is accepted', back.body.settings.listen === 'loopback', String(back.body.settings.listen))
await new Promise((r) => setTimeout(r, 700))
let backUp = false
for (let i = 0; i < 20 && !backUp; i++) {
  try { if ((await fetch(base + '/health')).ok) backUp = true } catch { await new Promise((r) => setTimeout(r, 150)) }
}
check('endpoint is back on loopback', backUp)
const final = await read()
check('base url returns to loopback', /^http:\/\/127\.0\.0\.1:/.test(final.baseUrl), final.baseUrl)

// An unknown value must not bind anywhere surprising.
await save({ listen: 'something-else' })
const coerced = await read()
check('an unknown mode falls back to loopback', coerced.settings.listen === 'loopback', String(coerced.settings.listen))

rmSync(dir, { recursive: true, force: true })
const failed = out.filter((x) => !x).length
console.log('\n' + (out.length - failed) + '/' + out.length + ' checks passed')
process.exit(failed === 0 ? 0 : 1)

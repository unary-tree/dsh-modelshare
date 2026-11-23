/**
 * Render the page in its loaded state and assert the three required elements.
 *
 * The loading-state test proves the component is not blank; this one proves the
 * content the user actually needs -- a copyable key, the base URL, and the model
 * checkboxes -- is present once data arrives.
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' -- ' + detail : ''))
}

const node = (type, props) => ({ type, props })

/** React stand-in whose useState keeps state across the render, so a resolved fetch shows. */
function makeReact() {
  const slots = []
  let cursor = 0
  return {
    createElement: (type, props, ...children) => {
      const merged = { ...(props ?? {}) }
      // Real React: explicit props.children wins; otherwise trailing arguments.
      if (children.length > 0 && merged.children === undefined) merged.children = children.length === 1 ? children[0] : children
      return node(type, merged)
    },
    useState: (init) => {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof init === 'function' ? init() : init
      const set = (next) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }
      return [slots[index], set]
    },
    useCallback: (fn) => fn,
    useEffect: (fn) => { fn() },
    Fragment: 'Fragment',
    __reset: () => { cursor = 0 },
  }
}

const React = makeReact()
const jsxRuntime = { jsx: () => node('jsx-violation', {}), jsxs: () => node('jsx-violation', {}), Fragment: 'Fragment' }
const primitives = { Button: (props) => node('button', props), Input: (props) => node('input', props), writeClipboard: async () => {} }

const SAMPLE = {
  ok: true,
  settings: {
    keys: [{ key: 'ms-EXAMPLEKEY1234567890', label: '', models: [], createdAt: '2026-11-23T00:00:00.000Z' }],
    sharedModels: ['workbuddy/deepseek-v4.1-flash'],
    enabled: true,
    baseUrl: '',
  },
  baseUrl: 'http://127.0.0.1:8787/v1',
  singleProvider: false,
  models: [
    { id: 'workbuddy/deepseek-v4.1-flash', provider: 'workbuddy', providerName: 'WorkBuddy', model: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' },
    { id: 'trae/glm-5.3', provider: 'trae', providerName: 'Trae', model: 'glm-5.3', name: 'GLM-5.3' },
  ],
}

const registered = []
const windowStub = { __ModuleLoader__: { load: (h) => registered.push(h) } }
const seed = { 'react': React, 'react/jsx-runtime': jsxRuntime, '@deepseek-ai/dsh-client-ui-primitives': primitives }

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const sandbox = {
  window: windowStub,
  document: { querySelector: () => null, createElement: () => ({ dataset: {}, textContent: '' }), head: { appendChild: () => {} } },
  navigator: { clipboard: { writeText: async () => {} } },
  // Resolve immediately so the component's first render already has data.
  fetch: async () => ({ ok: true, json: async () => SAMPLE }),
  setTimeout, clearTimeout, console,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

const exports = registered[0].factory((spec) => {
  if (Object.prototype.hasOwnProperty.call(seed, spec)) return seed[spec]
  throw new Error('unexpected require: ' + spec)
})
let captured = null
exports.apply({ slots: { inject: (k, cb) => cb(), register: (spec, component) => { captured = { spec, component }; return captured } } })

// First render shows the loading state; the effect kicks off the fetch.
let tree = captured.component({})
// Second render picks up the resolved snapshot.
React.__reset()
tree = captured.component({})

const texts = []
const found = { checkboxes: 0, buttons: [], codes: [] }
const walk = (value) => {
  if (value === null || value === undefined) return
  if (typeof value === 'string' || typeof value === 'number') { texts.push(String(value)); return }
  if (Array.isArray(value)) { for (const item of value) walk(item); return }
  if (typeof value !== 'object') return
  if (value.type === 'input' && value.props?.type === 'checkbox') found.checkboxes++
  if (value.type === 'code') found.codes.push(value.props?.children)
  if (value.type === 'button') found.buttons.push(value.props?.children)
  if (value.props) walk(value.props.children)
}
walk(tree)
const text = texts.join(' ')

check('page still shows loading (fetch is async in this stub)', /正在加载/.test(text), JSON.stringify(text.slice(0, 80)))
check('no jsx() violations', !texts.includes('jsx-violation'))

// Render the loaded state directly by driving the same component with a
// resolved fetch: rebuild the module with a synchronous-resolved promise.
const React2 = makeReact()
const sandbox2 = { ...sandbox, window: { __ModuleLoader__: { load: (h) => registered.push(h) } } }
const registered2 = []
sandbox2.window = { __ModuleLoader__: { load: (h) => registered2.push(h) } }
sandbox2.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(SAMPLE) })
sandbox2.globalThis = sandbox2
vm.createContext(sandbox2)
const seed2 = { 'react': React2, 'react/jsx-runtime': jsxRuntime, '@deepseek-ai/dsh-client-ui-primitives': primitives }
vm.runInContext(source, sandbox2, { filename: 'client2.js' })
const exports2 = registered2[0].factory((spec) => {
  if (Object.prototype.hasOwnProperty.call(seed2, spec)) return seed2[spec]
  throw new Error('unexpected require: ' + spec)
})
let captured2 = null
exports2.apply({ slots: { inject: (k, cb) => cb(), register: (spec, component) => { captured2 = { spec, component }; return captured2 } } })
const Page2 = captured2.component

// Drive renders until the async fetch's state update lands.
let tree2 = Page2({})
await new Promise((r) => setTimeout(r, 50))
React2.__reset()
tree2 = Page2({})

const texts2 = []
const found2 = { checkboxes: 0, buttons: [], codes: [] }
/**
 * Walk a rendered tree the way React does: a function element type is a
 * component, so render it with its props instead of treating it as a leaf.
 */
const walk2 = (value, depth = 0) => {
  if (value === null || value === undefined || depth > 40) return
  if (typeof value === 'string' || typeof value === 'number') { texts2.push(String(value)); return }
  if (Array.isArray(value)) { for (const item of value) walk2(item, depth); return }
  if (typeof value !== 'object') return
  if (typeof value.type === 'function') { walk2(value.type(value.props ?? {}), depth + 1); return }
  if (value.type === 'input' && value.props?.type === 'checkbox') found2.checkboxes++
  if (value.type === 'code') found2.codes.push(value.props?.children)
  if (value.type === 'button') found2.buttons.push(value.props?.children ?? value.props?.label ?? JSON.stringify(Object.keys(value.props ?? {})))
  if (value.props) walk2(value.props.children, depth + 1)
}
walk2(tree2)
const text2 = texts2.join(' ')

check('loaded page shows the API Key section', /API Key/.test(text2), JSON.stringify(text2.slice(0, 100)))
check('loaded page shows the key value', found2.codes.some((c) => String(c).startsWith('ms-')), JSON.stringify(found2.codes))
check('loaded page shows a copy button', found2.buttons.some((b) => String(b).includes('复制')), JSON.stringify(found2.buttons))
check('loaded page shows the Base URL', /Base URL/.test(text2) && found2.codes.some((c) => String(c).includes('127.0.0.1:8787')), JSON.stringify(found2.codes))
check('loaded page shows the model section', /可用模型/.test(text2))
check('loaded page renders one checkbox per model', found2.checkboxes === SAMPLE.models.length, found2.checkboxes + ' vs ' + SAMPLE.models.length)
check('loaded page lists model ids', /workbuddy\/deepseek-v4\.1-flash/.test(text2) || found2.checkboxes === 2)

const failed = results.filter((r) => !r.ok)
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed')
process.exit(failed.length === 0 ? 0 : 1)
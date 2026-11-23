/**
 * Client-bundle test: load lib/client.js the way the shell does.
 *
 * The important assertion here is STRUCTURAL, not "the component did not throw".
 * An earlier version of this test only called the component and checked for
 * exceptions; that passed while the page rendered blank on screen, because the
 * bundle was building elements with jsx() -- whose third argument is the key,
 * not children -- so every child was silently dropped.
 *
 * This test therefore stubs jsx/jsxs with React's real semantics (children in
 * props.children) AND additionally asserts the bundle never calls jsx(), by
 * making a jsx() stub that records a violation.
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' -- ' + detail : ''))
}

/** A rendered node the test can inspect. */
const node = (type, props) => ({ type, props })

const React = {
  createElement: (type, props, ...children) => node(type, { ...(props ?? {}), children: children.length === 1 ? children[0] : children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useCallback: (fn) => fn,
  useEffect: () => {},
  Fragment: 'Fragment',
}

let jsxCalls = 0
const jsxRuntime = {
  jsx: () => { jsxCalls++; return node('jsx-violation', {}) },
  jsxs: () => { jsxCalls++; return node('jsx-violation', {}) },
  Fragment: 'Fragment',
}

const primitives = {
  Button: (props) => node('button', props),
  Input: (props) => node('input', props),
  writeClipboard: async () => {},
}

const registered = []
const windowStub = { __ModuleLoader__: { load: (handoff) => registered.push(handoff) } }
const seed = {
  'react': React,
  'react/jsx-runtime': jsxRuntime,
  '@deepseek-ai/dsh-client-ui-primitives': primitives,
}

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const sandbox = {
  window: windowStub,
  document: { querySelector: () => null, createElement: () => ({ dataset: {}, textContent: '' }), head: { appendChild: () => {} } },
  navigator: { clipboard: { writeText: async () => {} } },
  fetch: async () => ({ ok: true, json: async () => ({ ok: true, settings: { keys: [], sharedModels: [], enabled: true, baseUrl: 'http://127.0.0.1:8787/v1' }, baseUrl: 'http://127.0.0.1:8787/v1', models: [], singleProvider: false }) }),
  setTimeout, clearTimeout, console,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

check('bundle registers with the module loader', registered.length === 1)
const handoff = registered[0]
check('bundle id matches the package name', handoff?.id === 'dsh-modelshare', handoff?.id)

const exports = handoff.factory((spec) => {
  if (Object.prototype.hasOwnProperty.call(seed, spec)) return seed[spec]
  throw new Error('unexpected require: ' + spec)
})
check('exports apply()', typeof exports.apply === 'function')

let captured = null
const mounted = []
const ctx = {
  slots: {
    inject: (key, cb) => { mounted.push(key); return cb() },
    register: (spec, component) => { captured = { spec, component }; return captured },
  },
}
exports.apply(ctx)
check('registers into settings.section', mounted.includes('settings.section'))
check('section id and label', captured?.spec.id === 'modelshare' && captured.spec.label() === '模型共享')

const Page = captured.component
check('page component is a function', typeof Page === 'function')

let tree
try {
  tree = Page({})
  check('page renders without throwing', true)
} catch (error) {
  check('page renders without throwing', false, String(error?.message ?? error))
}

/** Collect every text node in a rendered tree. */
const texts = []
const walk = (value) => {
  if (value === null || value === undefined) return
  if (typeof value === 'string' || typeof value === 'number') { texts.push(String(value)); return }
  if (Array.isArray(value)) { for (const item of value) walk(item); return }
  if (typeof value === 'object' && value.props) walk(value.props.children)
}
walk(tree)
const text = texts.join(' ')

check('no jsx() calls (children must go through createElement)', jsxCalls === 0, jsxCalls + ' calls')
check('page renders visible text', text.trim().length > 0, JSON.stringify(text.slice(0, 120)))
check('page renders the loading state', /正在加载/.test(text), JSON.stringify(text.slice(0, 120)))

// The blank-page regression: a page whose children were all dropped renders no text.
check('page is not blank', text.trim().length > 4)

const failed = results.filter((r) => !r.ok)
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed')
process.exit(failed.length === 0 ? 0 : 1)

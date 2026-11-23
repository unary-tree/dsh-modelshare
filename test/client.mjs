/**
 * Client-bundle test: load lib/client.js the way the shell does.
 *
 * The page code cannot be exercised in a browser here, so this stubs the
 * module loader and the platform seed modules (react, jsx-runtime, UI
 * primitives) and asserts that the bundle registers, exports apply/inject, and
 * that apply() mounts exactly one settings section without throwing.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' -- ' + detail : ''))
}

/** Minimal React stand-in: enough for hooks used at render time. */
const React = {
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useCallback: (fn) => fn,
  useEffect: () => {},
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
}

/** jsx-runtime stand-in producing inspectable elements. */
const jsxRuntime = {
  jsx: (type, props) => ({ type, props }),
  jsxs: (type, props) => ({ type, props }),
  Fragment: 'Fragment',
}

/** UI primitives stand-in. */
const primitives = {
  Button: (props) => ({ type: 'Button', props }),
  Input: (props) => ({ type: 'Input', props }),
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
  globalThis: windowStub,
  document: {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: () => {} },
  },
  navigator: { clipboard: { writeText: async () => {} } },
  setTimeout,
  console,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

check('bundle registers with the module loader', registered.length === 1, String(registered.length))
const handoff = registered[0]
check('bundle id matches the package name', handoff?.id === 'dsh-modelshare', handoff?.id)

const exports = handoff.factory((spec) => {
  if (Object.prototype.hasOwnProperty.call(seed, spec)) return seed[spec]
  throw new Error('unexpected require: ' + spec)
})

check('exports apply()', typeof exports.apply === 'function')
check('exports inject list', Array.isArray(exports.inject) && exports.inject.includes('slots'), JSON.stringify(exports.inject))

const mounted = []
let captured = null
const ctx = {
  slots: {
    inject: (key, cb) => { mounted.push(key); return cb() },
    register: (spec, component) => {
      mounted.push(spec)
      captured = { spec, component }
      return { spec, component }
    },
  },
}
exports.apply(ctx)

check('registers into settings.section', mounted.some((entry) => entry === 'settings.section'), JSON.stringify(mounted.map(String)))
const spec = mounted.find((entry) => typeof entry === 'object' && entry.name === 'settings.section')
check('section has an id and a label', spec?.id === 'modelshare' && typeof spec.label === 'function', JSON.stringify({ id: spec?.id, label: spec?.label?.() }))
check('section renders the page component', typeof captured?.component === 'function', typeof captured?.component)

// Render once with an empty (loading) state to prove the component runs.
const Page = captured?.component
if (Page) {
  let tree
  try {
    tree = Page({})
    check('page renders without throwing', tree !== undefined)
  } catch (error) {
    check('page renders without throwing', false, String(error?.message ?? error))
  }
} else {
  check('page renders without throwing', false, 'no component captured')
}

const failed = results.filter((r) => !r.ok)
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed')
process.exit(failed.length === 0 ? 0 : 1)
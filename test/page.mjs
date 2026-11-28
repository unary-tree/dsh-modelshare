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
    useRef: (init) => ({ current: init }),
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
  if (value.type === 'input' && value.props?.type === 'checkbox' && value.props?.['data-master'] !== 'true') found.checkboxes++
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
const found2 = { checkboxes: 0, masters: 0, buttons: [], codes: [] }
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
  if (value.type === 'input' && value.props?.type === 'checkbox') {
    if (value.props?.['data-master'] === 'true') found2.masters++
    else found2.checkboxes++
  }
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
check('the three selection buttons are gone in favour of one master box', found2.masters === 1 && !found2.buttons.some((b) => ['全选', '全部不选', '不限制'].includes(String(b))), JSON.stringify({ masters: found2.masters, buttons: found2.buttons }))
check('loaded page lists model ids', /workbuddy\/deepseek-v4\.1-flash/.test(text2) || found2.checkboxes === 2)

// --- sharing switch ---
// Render the page twice (enabled and disabled) and assert the control reflects
// each state, then click it and check the PUT that goes out.
async function renderWith(enabled) {
  const sample = {
    ...SAMPLE,
    settings: { ...SAMPLE.settings, enabled },
  }
  const ReactX = makeReact()
  const registered = []
  const calls = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (h) => registered.push(h) } },
    document: { querySelector: () => null, createElement: () => ({ dataset: {}, textContent: '' }), head: { appendChild: () => {} } },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async (url, init) => {
      calls.push({ url, init })
      if (init && init.method === 'PUT') {
        const body = JSON.parse(init.body)
        return { ok: true, json: async () => ({ ok: true, settings: { ...sample.settings, ...body } }) }
      }
      return { ok: true, json: async () => ({ ...sample, settings: { ...sample.settings } }) }
    },
    setTimeout, clearTimeout, console,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'c.js' })
  const seedX = { 'react': ReactX, 'react/jsx-runtime': jsxRuntime, '@deepseek-ai/dsh-client-ui-primitives': primitives }
  const ex = registered[0].factory((spec) => {
    if (Object.prototype.hasOwnProperty.call(seedX, spec)) return seedX[spec]
    throw new Error('unexpected require ' + spec)
  })
  let cap = null
  ex.apply({ slots: { inject: (k, cb) => cb(), register: (spec, component) => { cap = { spec, component }; return cap } } })
  const Page = cap.component
  Page({})
  await new Promise((r) => setTimeout(r, 30))
  ReactX.__reset()
  const tree = Page({})
  return { tree, calls }
}

/** Flatten a tree to text and collect buttons. */
function inspect(tree) {
  const texts = []
  const buttons = []
  const seen = new Set()
  const walk = (v, depth = 0) => {
    if (v === null || v === undefined || depth > 60) return
    if (typeof v === 'string' || typeof v === 'number') { texts.push(String(v)); return }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth); return }
    if (typeof v !== 'object') return
    if (typeof v.type === 'function') {
      if (seen.has(v.type)) return
      seen.add(v.type)
      walk(v.type(v.props ?? {}), depth + 1)
      return
    }
    if (v.type === 'button') buttons.push({ label: v.props?.children, onClick: v.props?.onClick })
    if (v.props) walk(v.props.children, depth + 1)
  }
  walk(tree)
  return { text: texts.join(' '), buttons }
}

const onState = await renderWith(true)
const on = inspect(onState.tree)
check('switch shows the enabled state', /共享开关/.test(on.text) && /已开启/.test(on.text), JSON.stringify(on.text.slice(0, 90)))
check('enabled state offers 关闭共享', on.buttons.some((b) => b.label === '关闭共享'), JSON.stringify(on.buttons.map((b) => b.label)))

const offState = await renderWith(false)
const off = inspect(offState.tree)
check('switch shows the disabled state', /已关闭/.test(off.text), JSON.stringify(off.text.slice(0, 90)))
check('disabled state offers 开启共享', off.buttons.some((b) => b.label === '开启共享'), JSON.stringify(off.buttons.map((b) => b.label)))
check('disabled state explains the consequence', /请求都会被拒绝|503/.test(off.text))

// Clicking must persist the flip.
const toggleButton = off.buttons.find((b) => b.label === '开启共享')
if (toggleButton && typeof toggleButton.onClick === 'function') {
  toggleButton.onClick()
  await new Promise((r) => setTimeout(r, 30))
  const put = offState.calls.find((c) => c.init && c.init.method === 'PUT')
  check('clicking the switch persists enabled=true', put !== undefined && JSON.parse(put.init.body).enabled === true, put ? put.init.body.slice(0, 120) : 'no PUT issued')
} else {
  check('clicking the switch persists enabled=true', false, 'no clickable toggle')
}

// --- refresh button ---
// A refresh must re-read the catalog from the harness while leaving the user's
// checkboxes alone. A catalog that grew by one model proves the refetch landed.
const REFRESHED = {
  ...SAMPLE,
  models: [
    ...SAMPLE.models,
    { id: 'trae/deepseek-v4-pro', provider: 'trae', providerName: 'Trae', model: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
  ],
}

{
  const ReactR = makeReact()
  const registeredR = []
  const callsR = []
  let served = SAMPLE
  const sandbox = {
    window: { __ModuleLoader__: { load: (h) => registeredR.push(h) } },
    document: { querySelector: () => null, createElement: () => ({ dataset: {}, textContent: '' }), head: { appendChild: () => {} } },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async (url, init) => {
      callsR.push({ url, init })
      return { ok: true, json: async () => served }
    },
    setTimeout, clearTimeout, console,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'c.js' })
  const seedR = { 'react': ReactR, 'react/jsx-runtime': jsxRuntime, '@deepseek-ai/dsh-client-ui-primitives': primitives }
  const ex = registeredR[0].factory((spec) => {
    if (Object.prototype.hasOwnProperty.call(seedR, spec)) return seedR[spec]
    throw new Error('unexpected require ' + spec)
  })
  let cap = null
  ex.apply({ slots: { inject: (k, cb) => cb(), register: (spec, component) => { cap = { spec, component }; return cap } } })
  const Page = cap.component
  Page({})
  await new Promise((r) => setTimeout(r, 30))
  ReactR.__reset()
  let tree = Page({})

  const collect = (t) => {
    const buttons = []
    const checkboxes = []
    const seen = new Set()
    const walk = (v, d = 0) => {
      if (v === null || v === undefined || d > 60) return
      if (Array.isArray(v)) { for (const x of v) walk(x, d); return }
      if (typeof v !== 'object') return
      if (typeof v.type === 'function') { walk(v.type(v.props ?? {}), d + 1); return }
      if (v.type === 'button') buttons.push({ label: v.props?.children, onClick: v.props?.onClick, disabled: v.props?.disabled })
      if (v.type === 'input' && v.props?.type === 'checkbox' && v.props?.['data-master'] !== 'true') checkboxes.push(v)
      if (v.props) walk(v.props.children, d + 1)
    }
    walk(t)
    return { buttons, checkboxes }
  }

  const first = collect(tree)
  const refresh = first.buttons.find((b) => b.label === '刷新')
  check('models card offers a refresh button', refresh !== undefined, JSON.stringify(first.buttons.map((b) => b.label)))
  check('model count starts at the served catalog', first.checkboxes.length === SAMPLE.models.length, String(first.checkboxes.length))

  if (refresh && typeof refresh.onClick === 'function') {
    const before = callsR.length
    served = REFRESHED
    await refresh.onClick()
    await new Promise((r) => setTimeout(r, 30))
    ReactR.__reset()
    tree = Page({})
    const after = collect(tree)
    check('refresh re-fetches the catalog', callsR.length > before, callsR.length + ' calls')
    check('refresh shows the new model', after.checkboxes.length === REFRESHED.models.length, after.checkboxes.length + ' vs ' + REFRESHED.models.length)
  } else {
    check('refresh re-fetches the catalog', false, 'no clickable refresh')
    check('refresh shows the new model', false, 'no clickable refresh')
  }
}

// --- per-model test button ---
{
  const ReactT = makeReact()
  const registeredT = []
  const callsT = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (h) => registeredT.push(h) } },
    document: { querySelector: () => null, createElement: () => ({ dataset: {}, textContent: '' }), head: { appendChild: () => {} } },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async (url, init) => {
      callsT.push({ url, init })
      if (String(url).includes('/test-model')) {
        return { ok: true, json: async () => ({ ok: true, ms: 123, model: JSON.parse(init.body).model, reply: 'pong' }) }
      }
      return { ok: true, json: async () => SAMPLE }
    },
    setTimeout, clearTimeout, console,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'c.js' })
  const seedT = { 'react': ReactT, 'react/jsx-runtime': jsxRuntime, '@deepseek-ai/dsh-client-ui-primitives': primitives }
  const ex = registeredT[0].factory((spec) => {
    if (Object.prototype.hasOwnProperty.call(seedT, spec)) return seedT[spec]
    throw new Error('unexpected require ' + spec)
  })
  let cap = null
  ex.apply({ slots: { inject: (k, cb) => cb(), register: (spec, component) => { cap = { spec, component }; return cap } } })
  const Page = cap.component
  Page({})
  await new Promise((r) => setTimeout(r, 30))
  ReactT.__reset()

  const collectT = (t) => {
    const buttons = []
    const texts = []
    const walk = (v, d = 0) => {
      if (v === null || v === undefined || d > 60) return
      if (typeof v === 'string' || typeof v === 'number') { texts.push(String(v)); return }
      if (Array.isArray(v)) { for (const x of v) walk(x, d); return }
      if (typeof v !== 'object') return
      if (typeof v.type === 'function') { walk(v.type(v.props ?? {}), d + 1); return }
      if (v.type === 'button') {
        const kids = Array.isArray(v.props?.children) ? v.props.children : [v.props?.children]
        const hasIcon = kids.some((kid) => kid && typeof kid === 'object' && kid.type && String(kid.type) === 'svg')
        buttons.push({
          label: v.props?.children,
          // The per-model test control is icon-only; its name lives in aria-label.
          ariaLabel: v.props?.['aria-label'],
          iconOnly: hasIcon && typeof v.props?.children !== 'string',
          onClick: v.props?.onClick,
        })
      }
      if (v.props) walk(v.props.children, d + 1)
    }
    walk(t)
    return { buttons, text: texts.join(' ') }
  }

  const first = collectT(Page({}))
  const tests = first.buttons.filter((b) => b.ariaLabel && String(b.ariaLabel).includes('测试'))
  check('every model row has a test button', tests.length === SAMPLE.models.length, tests.length + ' vs ' + SAMPLE.models.length)
  check('the test control is an icon, not a text button', tests.every((b) => b.label === undefined || typeof b.label === 'object'), JSON.stringify(tests.map((b) => typeof b.label)))

  if (tests.length > 0) {
    await tests[0].onClick()
    await new Promise((r) => setTimeout(r, 30))
    ReactT.__reset()
    const after = collectT(Page({}))
    check('the test posts the model id', callsT.some((c) => String(c.url).includes('/test-model') && JSON.parse(c.init.body).model), JSON.stringify(callsT.filter((c) => String(c.url).includes('test-model')).map((c) => c.init?.body)))
    check('a passing test shows 可用 with latency', /可用\s*123ms/.test(after.text), JSON.stringify(after.text.slice(0, 160)))
  } else {
    check('the test posts the model id', false, 'no test buttons')
    check('a passing test shows 可用 with latency', false, 'no test buttons')
  }
}

// --- Clear must not re-tick everything ---
{
  const ReactC = makeReact()
  const registeredC = []
  const puts = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (h) => registeredC.push(h) } },
    document: { querySelector: () => null, createElement: () => ({ dataset: {}, textContent: '' }), head: { appendChild: () => {} } },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async (url, init) => {
      if (init && init.method === 'PUT') {
        puts.push(JSON.parse(init.body))
        return { ok: true, json: async () => ({ ok: true, settings: { ...JSON.parse(init.body) } }) }
      }
      return { ok: true, json: async () => SAMPLE }
    },
    setTimeout, clearTimeout, console,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'c.js' })
  const seedC = { 'react': ReactC, 'react/jsx-runtime': jsxRuntime, '@deepseek-ai/dsh-client-ui-primitives': primitives }
  const ex = registeredC[0].factory((spec) => {
    if (Object.prototype.hasOwnProperty.call(seedC, spec)) return seedC[spec]
    throw new Error('unexpected require ' + spec)
  })
  let cap = null
  ex.apply({ slots: { inject: (k, cb) => cb(), register: (spec, component) => { cap = { spec, component }; return cap } } })
  const Page = cap.component
  Page({})
  await new Promise((r) => setTimeout(r, 30))
  ReactC.__reset()

  const collectC = (t) => {
    const buttons = []
    const boxes = []
    const masters = []
    const walk = (v, d = 0) => {
      if (v === null || v === undefined || d > 60) return
      if (Array.isArray(v)) { for (const x of v) walk(x, d); return }
      if (typeof v !== 'object') return
      // Icon is a component too; a label-based comparison would be lost here.
      if (typeof v.type === 'function') { walk(v.type(v.props ?? {}), d + 1); return }
      if (v.type === 'button') buttons.push({ label: v.props?.children, onClick: v.props?.onClick })
      if (v.type === 'input' && v.props?.type === 'checkbox') {
        if (v.props?.['data-master'] === 'true') masters.push({ checked: v.props?.checked, onChange: v.props?.onChange })
        else boxes.push({ checked: v.props?.checked })
      }
      if (v.props) walk(v.props.children, d + 1)
    }
    walk(t)
    return { buttons, boxes, masters }
  }

  // The master box is the single selection control: ticking it means "all",
  // unticking it means "none". Drive both directions and check the effect.
  const firstRender = collectC(Page({}))
  check('the master box exists', firstRender.masters.length === 1, String(firstRender.masters.length))
  check('the master starts ticked when unrestricted', firstRender.masters[0]?.checked === true, JSON.stringify(firstRender.masters))

  // Untick -> deny all.
  await firstRender.masters[0].onChange({ target: { checked: false } })
  await new Promise((r) => setTimeout(r, 30))
  ReactC.__reset()
  const cleared = collectC(Page({}))
  check('unticking the master clears every model (regression)', cleared.boxes.every((b) => b.checked === false), JSON.stringify(cleared.boxes))
  const lastPut = puts.at(-1)
  check('unticking persists an empty list, not "unrestricted"', lastPut && lastPut.sharedModels.length === 0 && lastPut.unrestricted === false, JSON.stringify(lastPut))

  // Tick again -> all.
  ReactC.__reset()
  const afterClear = collectC(Page({}))
  await afterClear.masters[0].onChange({ target: { checked: true } })
  await new Promise((r) => setTimeout(r, 30))
  ReactC.__reset()
  const reticked = collectC(Page({}))
  check('ticking the master enables every model', reticked.boxes.every((b) => b.checked === true), JSON.stringify(reticked.boxes))
}

// --- listen scope option ---
{
  const ReactL = makeReact()
  const registeredL = []
  const puts = []
  const sample = { ...SAMPLE, settings: { ...SAMPLE.settings, listen: 'loopback' }, lanAddress: '192.168.1.10' }
  const sandbox = {
    window: { __ModuleLoader__: { load: (h) => registeredL.push(h) } },
    document: { querySelector: () => null, createElement: () => ({ dataset: {}, textContent: '' }), head: { appendChild: () => {} } },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async (url, init) => {
      if (init && init.method === 'PUT') {
        const body = JSON.parse(init.body)
        puts.push(body)
        return { ok: true, json: async () => ({ ok: true, settings: body, baseUrl: 'http://127.0.0.1:8787/v1' }) }
      }
      return { ok: true, json: async () => sample }
    },
    setTimeout, clearTimeout, console,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'c.js' })
  const seedL = { 'react': ReactL, 'react/jsx-runtime': jsxRuntime, '@deepseek-ai/dsh-client-ui-primitives': primitives }
  const ex = registeredL[0].factory((spec) => {
    if (Object.prototype.hasOwnProperty.call(seedL, spec)) return seedL[spec]
    throw new Error('unexpected require ' + spec)
  })
  let cap = null
  ex.apply({ slots: { inject: (k, cb) => cb(), register: (spec, component) => { cap = { spec, component }; return cap } } })
  const Page = cap.component
  Page({})
  await new Promise((r) => setTimeout(r, 30))
  ReactL.__reset()

  const collectL = (t) => {
    const radios = []
    const texts = []
    const walk = (v, d = 0) => {
      if (v === null || v === undefined || d > 60) return
      if (typeof v === 'string' || typeof v === 'number') { texts.push(String(v)); return }
      if (Array.isArray(v)) { for (const x of v) walk(x, d); return }
      if (typeof v !== 'object') return
      if (typeof v.type === 'function') { walk(v.type(v.props ?? {}), d + 1); return }
      if (v.type === 'input' && v.props?.type === 'radio') radios.push({ checked: v.props?.checked, onChange: v.props?.onChange })
      if (v.props) walk(v.props.children, d + 1)
    }
    walk(t)
    return { radios, text: texts.join(' ') }
  }

  const first = collectL(Page({}))
  check('the page offers both listen scopes', first.radios.length === 2, String(first.radios.length))
  check('loopback is selected by default', first.radios[0]?.checked === true, JSON.stringify(first.radios.map((r) => r.checked)))
  check('the LAN address is shown', /192\.168\.1\.10/.test(first.text), JSON.stringify(first.text.slice(0, 120)))

  // Switch to LAN: the choice must be persisted.
  const lanRadio = first.radios[1]
  if (lanRadio && typeof lanRadio.onChange === 'function') {
    await lanRadio.onChange()
    await new Promise((r) => setTimeout(r, 30))
    ReactL.__reset()
    const after = collectL(Page({}))
    check('choosing LAN persists listen=all', puts.some((b) => b.listen === 'all'), JSON.stringify(puts.map((b) => b.listen)))
    check('LAN mode warns about exposure', /局域网|任何人/.test(after.text), JSON.stringify(after.text.slice(0, 140)))
  } else {
    check('choosing LAN persists listen=all', false, 'no LAN radio')
    check('LAN mode warns about exposure', false, 'no LAN radio')
  }
}

const failed = results.filter((r) => !r.ok)
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed')
process.exit(failed.length === 0 ? 0 : 1)
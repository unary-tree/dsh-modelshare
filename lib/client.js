/**
 * dsh-modelshare settings page.
 *
 * A hand-written client bundle in the DSH plugin format: the shell loads it
 * through window.__ModuleLoader__, calls factory(require), and mounts whatever
 * apply() registers into the settings slot. require() only answers platform
 * seed words (react, react/jsx-runtime, the UI primitives), so this file
 * carries its own styling and talks to the host over fetch.
 *
 * The page owns three things: a generated API key you can copy, the base URL
 * to paste into another program, and the model allow-list that decides which
 * models that key may call.
 */
window.__ModuleLoader__.load({
  id: 'dsh-modelshare',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    /**
     * Element factory. React.createElement, not jsx(): jsx()'s third argument
     * is the element key, so passing children there silently discards them and
     * renders an empty element -- which is exactly the blank page this
     * replaced.
     */
    const h = React.createElement

    const NS = 'modelshare'
    const CSS = [
      '.ms-root{display:flex;flex-direction:column;gap:18px;padding:4px 0}',
      '.ms-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:12px;background:var(--dsw-alias-bg-layer-3)}',
      '.ms-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0}',
      '.ms-hint{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary);margin:0}',
      '.ms-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.ms-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;color:var(--dsw-alias-label-primary);word-break:break-all;flex:1;min-width:240px}',
      '.ms-key{color:var(--dsw-alias-label-secondary)}',
      '.ms-models{display:flex;flex-direction:column;gap:2px;max-height:420px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:6px}',
      '.ms-model{display:flex;align-items:center;gap:10px;padding:5px 10px;border-radius:8px}',
      '.ms-model:hover{background:var(--dsw-alias-bg-module-platform)}',
      '.ms-model-main{display:flex;align-items:center;gap:10px;flex:1;min-width:0;cursor:pointer}',
      '.ms-model-main input{cursor:pointer}',
      '.ms-model button{flex:none;padding:2px 10px;height:26px;font-size:12px}',
      '.ms-name{font-size:13px;color:var(--dsw-alias-label-primary);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ms-provider{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.ms-badge{font-size:11px;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.ms-badge-ok{background:rgba(46,160,67,.15);color:#2ea043}',
      '.ms-badge-off{background:rgba(248,81,73,.15);color:#f85149}',
      '.ms-err{font-size:12px;color:#f85149;margin:0}',
      '.ms-empty{font-size:12px;color:var(--dsw-alias-label-tertiary);padding:12px;text-align:center}',
      '.ms-switch{border-width:1.5px}',
      '.ms-switch-head{display:flex;align-items:center;gap:12px}',
      '.ms-switch-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}',
      '.ms-switch .ms-title{margin:0}',
      '.ms-switch .ms-hint{margin:0}',
      '.ms-dim .ms-title,.ms-dim .ms-hint,.ms-dim .ms-models,.ms-dim .ms-row{opacity:.45}',
      '.ms-dim .ms-model-main{pointer-events:none}',
      '.ms-refresh{display:inline-flex;align-items:center;gap:6px}',
      '.ms-stamp{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
    ].join('')

    /** Inject the stylesheet once per page, keyed so HMR cannot duplicate it. */
    function installStyles() {
      if (typeof document === 'undefined') return
      const id = 'dsh-modelshare/style'
      if (document.querySelector('style[data-modelshare=' + JSON.stringify(id) + ']') !== null) return
      const tag = document.createElement('style')
      tag.dataset.modelshare = id
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /** Copy text, preferring the clipboard primitive so the page matches the shell. */
    async function copy(text) {
      try {
        if (typeof primitives.writeClipboard === 'function') {
          await primitives.writeClipboard(text)
          return true
        }
      } catch {}
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        return false
      }
    }

    /** One copy button that reports success in place. */
    function CopyButton({ value, label }) {
      const [done, setDone] = React.useState(false)
      const onClick = React.useCallback(async () => {
        const ok = await copy(value)
        if (!ok) return
        setDone(true)
        setTimeout(() => setDone(false), 1400)
      }, [value])
      return h(primitives.Button, {
        variant: 'outline',
        onClick,
        children: done ? '已复制' : (label || '复制'),
      })
    }

    /** A labelled read-only value with its copy button. */
    function CopyField({ label, value }) {
      return h('div', { className: 'ms-card' },
        h('p', { className: 'ms-title' }, label),
        h('div', { className: 'ms-row' },
          h('code', { className: 'ms-mono' }, value || '（尚未生成）'),
          h(CopyButton, { value, label: '复制' }),
        ),
      )
    }

    /** The page. */
    function ModelSharePage() {
      const [state, setState] = React.useState({ status: 'loading', error: '', data: null })
      const [busy, setBusy] = React.useState(false)
      const [refreshing, setRefreshing] = React.useState(false)
      /** When the catalog was last re-read, so the button can confirm it worked. */
      const [refreshedAt, setRefreshedAt] = React.useState(null)
      /** Per-model probe results, keyed by model id: { state, ms, error }. */
      const [probes, setProbes] = React.useState({})

      /**
       * Test one model by calling it.
       *
       * Results are keyed by model id and kept until the next test of that
       * model, so testing one row never disturbs another row's last answer.
       */
      const testModel = React.useCallback(async (modelId) => {
        setProbes((prev) => ({ ...prev, [modelId]: { state: 'running' } }))
        try {
          const res = await fetch('/modelshare/api/test-model', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: modelId }),
          })
          const body = await res.json()
          setProbes((prev) => ({
            ...prev,
            [modelId]: body.ok
              ? { state: 'ok', ms: body.ms, reply: body.reply }
              : { state: 'fail', ms: body.ms, error: body.error ?? ('HTTP ' + res.status) },
          }))
        } catch (error) {
          setProbes((prev) => ({ ...prev, [modelId]: { state: 'fail', error: String(error?.message ?? error) } }))
        }
      }, [])
      const [draft, setDraft] = React.useState({ keys: [], sharedModels: [], enabled: true, baseUrl: '' })
      /**
       * Latest draft, for handlers that need to read it after a state update.
       * A state setter's value is one render behind inside the same callback.
       */
      const draftRef = React.useRef(draft)
      draftRef.current = draft

      const load = React.useCallback(async () => {
        try {
          const res = await fetch('/modelshare/api/settings', { headers: { accept: 'application/json' } })
          if (!res.ok) throw new Error('HTTP ' + res.status)
          const data = await res.json()
          setState({ status: 'ready', error: '', data })
          setDraft({
            keys: data.settings.keys,
            sharedModels: data.settings.sharedModels,
            enabled: data.settings.enabled,
            baseUrl: data.settings.baseUrl,
          })
        } catch (error) {
          setState({ status: 'error', error: String(error?.message ?? error), data: null })
        }
      }, [])

      React.useEffect(() => { load() }, [load])

      /**
       * Re-read the model catalog from the harness without disturbing the draft.
       *
       * Deliberately not load(): load() blanks the page into its loading state
       * and overwrites the draft, which would discard checkboxes the user just
       * clicked. A refresh only replaces the catalog and the base URL.
       */
      const refreshModels = React.useCallback(async () => {
        setRefreshing(true)
        try {
          const res = await fetch('/modelshare/api/settings', { headers: { accept: 'application/json' } })
          if (!res.ok) throw new Error('HTTP ' + res.status)
          const data = await res.json()
          setState((prev) => (prev.data
            ? { ...prev, error: '', data: { ...prev.data, models: data.models, baseUrl: data.baseUrl, settings: { ...prev.data.settings, baseUrl: data.settings.baseUrl } } }
            : { status: 'ready', error: '', data }))
          setRefreshedAt(new Date())
          setState((prev) => ({ ...prev, error: '' }))
        } catch (error) {
          setState((prev) => ({ ...prev, error: String(error?.message ?? error) }))
        } finally {
          setRefreshing(false)
        }
      }, [])

      const save = React.useCallback(async (next) => {
        setBusy(true)
        try {
          const res = await fetch('/modelshare/api/settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(next),
          })
          if (!res.ok) throw new Error('HTTP ' + res.status)
          const body = await res.json()
          setDraft({ keys: body.settings.keys, sharedModels: body.settings.sharedModels, enabled: body.settings.enabled, baseUrl: body.settings.baseUrl })
          setState((prev) => ({ ...prev, data: { ...prev.data, settings: body.settings } }))
          setState((prev) => ({ ...prev, error: '' }))
        } catch (error) {
          setState((prev) => ({ ...prev, error: String(error?.message ?? error) }))
        } finally {
          setBusy(false)
        }
      }, [])

      /**
       * Flip the sharing switch.
       *
       * Only this one field changes, so the handler merges into the current
       * draft instead of sending it: a save that raced a model checkbox click
       * would otherwise undo that click.
       */
      const toggleSharing = React.useCallback(async (next) => {
        setDraft((prev) => ({ ...prev, enabled: next }))
        await save({ ...draftRef.current, enabled: next })
      }, [save])

      const createKey = React.useCallback(async () => {
        setBusy(true)
        try {
          const res = await fetch('/modelshare/api/keys', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ label: '' }),
          })
          if (!res.ok) throw new Error('HTTP ' + res.status)
          await load()
        } catch (error) {
          setState((prev) => ({ ...prev, error: String(error?.message ?? error) }))
        } finally {
          setBusy(false)
        }
      }, [load])

      const removeKey = React.useCallback(async (key) => {
        setBusy(true)
        try {
          const res = await fetch('/modelshare/api/keys?key=' + encodeURIComponent(key), { method: 'DELETE' })
          if (!res.ok) throw new Error('HTTP ' + res.status)
          await load()
        } catch (error) {
          setState((prev) => ({ ...prev, error: String(error?.message ?? error) }))
        } finally {
          setBusy(false)
        }
      }, [load])

      const toggleModel = React.useCallback((id) => {
        setDraft((prev) => {
          const has = prev.sharedModels.includes(id)
          const sharedModels = has ? prev.sharedModels.filter((item) => item !== id) : [...prev.sharedModels, id]
          const next = { ...prev, sharedModels }
          void save({ ...next, keys: prev.keys })
          return next
        })
      }, [save])

      const selectAll = React.useCallback((ids) => {
        setDraft((prev) => {
          const next = { ...prev, sharedModels: ids }
          void save({ ...next, keys: prev.keys })
          return next
        })
      }, [save])

      if (state.status === 'loading') return h('div', { className: 'ms-root' }, h('p', { className: 'ms-hint' }, '正在加载…'))
      if (state.status === 'error') {
        return h('div', { className: 'ms-root' },
          h('div', { className: 'ms-card' },
            h('p', { className: 'ms-title' }, '无法读取共享设置'),
            h('p', { className: 'ms-err' }, state.error),
            h('div', { className: 'ms-row' }, h(primitives.Button, { variant: 'outline', onClick: load, children: '重试' })),
          ),
        )
      }

      const data = state.data
      const models = data.models || []
      const allIds = models.map((row) => row.id)
      const activeKey = draft.keys[0]
      const unrestricted = draft.sharedModels.length === 0
      const allowedCount = unrestricted ? allIds.length : draft.sharedModels.filter((id) => allIds.includes(id)).length

      return h('div', { className: 'ms-root' },
        state.error ? h('p', { className: 'ms-err' }, state.error) : null,

        // 0. Sharing switch
        h('div', { className: 'ms-card ms-switch' },
          h('div', { className: 'ms-switch-head' },
            h('div', { className: 'ms-switch-text' },
              h('p', { className: 'ms-title' }, '共享开关'),
              h('p', { className: 'ms-hint' }, draft.enabled
                ? '共享已打开。外部软件可以用下面的 Key 调用这个接口。'
                : '共享已关闭。所有请求都会被拒绝（503），Key 与模型设置会保留。'),
            ),
            h('span', { className: 'ms-badge ' + (draft.enabled ? 'ms-badge-ok' : 'ms-badge-off') }, draft.enabled ? '已开启' : '已关闭'),
            h(primitives.Button, {
              variant: draft.enabled ? 'outline' : 'primary',
              onClick: () => toggleSharing(!draft.enabled),
              disabled: busy,
              children: draft.enabled ? '关闭共享' : '开启共享',
            }),
          ),
        ),

        // 1. API key
        h('div', { className: 'ms-card' + (draft.enabled ? '' : ' ms-dim') },
          h('p', { className: 'ms-title' }, 'API Key'),
          h('p', { className: 'ms-hint' }, '把这个 Key 填到其它软件的 OpenAI 配置里。它只能调用下面勾选的模型。'),
          activeKey
            ? h('div', { className: 'ms-row' },
                h('code', { className: 'ms-mono ms-key' }, activeKey.key),
                h(CopyButton, { value: activeKey.key, label: '复制 Key' }),
                h(primitives.Button, { variant: 'outline', onClick: createKey, disabled: busy, children: '重新生成' }),
              )
            : h('div', { className: 'ms-row' },
                h(primitives.Button, { variant: 'primary', onClick: createKey, disabled: busy, children: '生成 API Key' }),
                h('p', { className: 'ms-hint' }, '还没有 Key。生成一个之后才能被外部软件调用。'),
              ),
          draft.keys.length > 1
            ? h('div', { className: 'ms-row' },
                h('p', { className: 'ms-hint' }, '另有 ' + (draft.keys.length - 1) + ' 个 Key：'),
                draft.keys.slice(1).map((entry) =>
                  h('span', { key: entry.key, className: 'ms-row' },
                    h('code', { className: 'ms-mono' }, entry.key),
                    h(CopyButton, { value: entry.key, label: '复制' }),
                    h(primitives.Button, { variant: 'outline', onClick: () => removeKey(entry.key), disabled: busy, children: '删除' }),
                  ),
                ),
              )
            : null,
        ),

        // 2. Base URL
        h(CopyField, { label: 'Base URL', value: data.baseUrl }),

        // 3. Models
        h('div', { className: 'ms-card' + (draft.enabled ? '' : ' ms-dim') },
          h('div', { className: 'ms-row' },
            h('p', { className: 'ms-title', style: { flex: 1 } }, '可用模型'),
            h('span', { className: 'ms-badge' }, allowedCount + ' / ' + allIds.length),
            refreshing
              ? h('span', { className: 'ms-stamp' }, '刷新中…')
              : refreshedAt
                ? h('span', { className: 'ms-stamp' }, '已刷新 ' + refreshedAt.toLocaleTimeString())
                : null,
            h(primitives.Button, {
              variant: 'outline',
              onClick: refreshModels,
              disabled: refreshing,
              children: refreshing ? '刷新中' : '刷新',
            }),
            h(primitives.Button, { variant: 'outline', onClick: () => selectAll(allIds), disabled: busy || !draft.enabled, children: '全选' }),
            h(primitives.Button, { variant: 'outline', onClick: () => selectAll([]), disabled: busy || !draft.enabled, children: '清空' }),
          ),
          h('p', { className: 'ms-hint' },
            unrestricted
              ? '当前未限制：这个 Key 可以使用全部模型。勾选任意模型后即变为白名单模式。'
              : '白名单模式：只有勾选的模型能被这个 Key 调用。',
          ),
          models.length === 0
            ? h('p', { className: 'ms-empty' }, '这个 DSH 里还没有可共享的模型。')
            : h('div', { className: 'ms-models' },
                models.map((row) => {
                  const probe = probes[row.id]
                  return h('div', { key: row.id, className: 'ms-model' },
                    // The checkbox row is a label so clicking the name toggles it;
                    // the test control sits outside that label so it does not.
                    h('label', { className: 'ms-model-main' },
                      h('input', {
                        type: 'checkbox',
                        checked: unrestricted || draft.sharedModels.includes(row.id),
                        disabled: busy,
                        onChange: () => toggleModel(row.id),
                      }),
                      h('span', { className: 'ms-name', title: row.id }, row.name && row.name !== row.id ? row.name + ' · ' + row.id : row.id),
                    ),
                    probe && probe.state === 'ok'
                      ? h('span', { className: 'ms-badge ms-badge-ok', title: probe.reply || '' }, '可用 ' + probe.ms + 'ms')
                      : probe && probe.state === 'fail'
                        ? h('span', { className: 'ms-badge ms-badge-off', title: probe.error || '' }, '不可用')
                        : probe && probe.state === 'running'
                          ? h('span', { className: 'ms-badge ms-stamp' }, '测试中…')
                          : h('span', { className: 'ms-provider' }, row.providerName || row.provider),
                    h(primitives.Button, {
                      variant: 'outline',
                      onClick: () => testModel(row.id),
                      disabled: probe?.state === 'running',
                      children: probe?.state === 'running' ? '测试中' : '测试',
                    }),
                  )
                }),
              ),
        ),
      )
    }

    const inject = ['slots']

    /**
     * Mount the page into the settings UI.
     * @param ctx - the client root context.
     */
    function apply(ctx) {
      installStyles()
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'modelshare',
        order: 40,
        label: () => '模型共享',
      }, ModelSharePage))
    }

    exports.apply = apply
    exports.inject = inject
    exports.NS = NS
    return module.exports
  },
})
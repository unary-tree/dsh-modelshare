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
    const jsxRuntime = require('react/jsx-runtime')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = jsxRuntime.jsx
    const Fragment = jsxRuntime.Fragment

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
      '.ms-model{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:8px;cursor:pointer}',
      '.ms-model:hover{background:var(--dsw-alias-bg-module-platform)}',
      '.ms-model input{cursor:pointer}',
      '.ms-name{font-size:13px;color:var(--dsw-alias-label-primary);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ms-provider{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.ms-badge{font-size:11px;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.ms-badge-ok{background:rgba(46,160,67,.15);color:#2ea043}',
      '.ms-badge-off{background:rgba(248,81,73,.15);color:#f85149}',
      '.ms-err{font-size:12px;color:#f85149;margin:0}',
      '.ms-empty{font-size:12px;color:var(--dsw-alias-label-tertiary);padding:12px;text-align:center}',
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
        variant: 'secondary',
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
      const [draft, setDraft] = React.useState({ keys: [], sharedModels: [], enabled: true, baseUrl: '' })

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
            h('div', { className: 'ms-row' }, h(primitives.Button, { variant: 'secondary', onClick: load, children: '重试' })),
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

        // 1. API key
        h('div', { className: 'ms-card' },
          h('p', { className: 'ms-title' }, 'API Key'),
          h('p', { className: 'ms-hint' }, '把这个 Key 填到其它软件的 OpenAI 配置里。它只能调用下面勾选的模型。'),
          activeKey
            ? h('div', { className: 'ms-row' },
                h('code', { className: 'ms-mono ms-key' }, activeKey.key),
                h(CopyButton, { value: activeKey.key, label: '复制 Key' }),
                h(primitives.Button, { variant: 'secondary', onClick: createKey, disabled: busy, children: '重新生成' }),
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
                    h(primitives.Button, { variant: 'secondary', onClick: () => removeKey(entry.key), disabled: busy, children: '删除' }),
                  ),
                ),
              )
            : null,
        ),

        // 2. Base URL
        h(CopyField, { label: 'Base URL', value: data.baseUrl }),

        // 3. Models
        h('div', { className: 'ms-card' },
          h('div', { className: 'ms-row' },
            h('p', { className: 'ms-title', style: { flex: 1 } }, '可用模型'),
            h('span', { className: 'ms-badge' }, allowedCount + ' / ' + allIds.length),
            h(primitives.Button, { variant: 'secondary', onClick: () => selectAll(allIds), disabled: busy, children: '全选' }),
            h(primitives.Button, { variant: 'secondary', onClick: () => selectAll([]), disabled: busy, children: '清空' }),
          ),
          h('p', { className: 'ms-hint' },
            unrestricted
              ? '当前未限制：这个 Key 可以使用全部模型。勾选任意模型后即变为白名单模式。'
              : '白名单模式：只有勾选的模型能被这个 Key 调用。',
          ),
          models.length === 0
            ? h('p', { className: 'ms-empty' }, '这个 DSH 里还没有可共享的模型。')
            : h('div', { className: 'ms-models' },
                models.map((row) =>
                  h('label', { key: row.id, className: 'ms-model' },
                    h('input', {
                      type: 'checkbox',
                      checked: unrestricted || draft.sharedModels.includes(row.id),
                      disabled: busy,
                      onChange: () => toggleModel(row.id),
                    }),
                    h('span', { className: 'ms-name', title: row.id }, row.name && row.name !== row.id ? row.name + ' · ' + row.id : row.id),
                    h('span', { className: 'ms-provider' }, row.providerName || row.provider),
                  ),
                ),
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

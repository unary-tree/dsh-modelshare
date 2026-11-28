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
      '.ms-model{display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:8px}',
      '.ms-model:hover{background:var(--dsw-alias-bg-module-platform)}',
      '.ms-model-main{display:flex;align-items:center;gap:10px;flex:1;min-width:0;cursor:pointer}',
      '.ms-model-main input{cursor:pointer}',
      '.ms-model button{flex:none;font-size:12px}',
      '.ms-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:0;border-radius:4px;background:none;color:var(--dsw-alias-label-tertiary);opacity:.75}',
      '.ms-icon-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);opacity:1;background:var(--dsw-alias-bg-module-platform)}',
      '.ms-icon-btn:disabled{opacity:.5;cursor:default}',
      '.ms-icon-btn svg{flex:none;display:block}',
      '.ms-master{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none;padding:2px 0}',
      '.ms-master input{cursor:pointer;margin:0}',
      '.ms-master:hover{color:var(--dsw-alias-label-primary)}',
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
      '.ms-section{display:flex;flex-direction:column;gap:6px;padding-top:4px;border-top:1px solid var(--dsw-alias-border-l2);margin-top:4px;padding-top:12px}',
      '.ms-label{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary);margin:0 0 2px}',
      '.ms-option{display:flex;align-items:flex-start;gap:9px;cursor:pointer;padding:8px 10px;border:1px solid transparent;border-radius:8px}',
      '.ms-option:hover{background:var(--dsw-alias-bg-module-platform)}',
      '.ms-option-on{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform)}',
      '.ms-option input{cursor:pointer;margin:2px 0 0}',
      '.ms-option-body{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.ms-option-title{font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.ms-option-note{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary);word-break:break-all}',
      '.ms-warn{margin:0;font-size:12px;line-height:1.6;color:#d29922;background:rgba(210,153,34,.12);border-radius:8px;padding:8px 10px}',
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

    /**
     * A small stroke icon, drawn inline.
     *
     * Deliberately not one of the shell's icon components: importing those
     * would bind the page to whichever DSH release those packages resolve to,
     * and a profile whose node_modules is a different version would render
     * nothing. An inline path works in every shell.
     * @param props.path - SVG path data drawn with the current text colour.
     * @param props.size - square edge in px.
     */
    function Icon({ path, size = 14, filled = false }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: filled ? 'currentColor' : 'none',
        stroke: filled ? 'none' : 'currentColor',
        strokeWidth: filled ? undefined : 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        children: h('path', { d: path }),
      })
    }

    /**
     * Play triangle — the "run a test" affordance.
     *
     * A filled triangle, not a stroked one: at this size a 1.6px outline on a
     * small glyph collapses into a smudge, while a solid shape still reads.
     */
    const ICON_PLAY = 'M5 3l8 5-8 5z'

    /** Circular arrow — "in progress", shown while a probe runs. */
    const ICON_SPIN = 'M13 8a5 5 0 1 1-1.6-3.7M13 2.5V5h-2.5'

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
      const [draft, setDraft] = React.useState({ keys: [], sharedModels: [], unrestricted: true, enabled: true, baseUrl: '', listen: 'loopback' })
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
            unrestricted: data.settings.unrestricted !== false,
            enabled: data.settings.enabled,
            baseUrl: data.settings.baseUrl,
            listen: data.settings.listen === 'all' ? 'all' : 'loopback',
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
          setDraft({ keys: body.settings.keys, sharedModels: body.settings.sharedModels, unrestricted: body.settings.unrestricted !== false, enabled: body.settings.enabled, baseUrl: body.settings.baseUrl, listen: body.settings.listen === 'all' ? 'all' : 'loopback' })
          setState((prev) => ({ ...prev, data: { ...prev.data, settings: body.settings } }))
          setState((prev) => ({ ...prev, error: '' }))
        } catch (error) {
          // A listen-mode change closes the listener that carried this request,
          // so the reply can be lost even though the write succeeded. Re-read to
          // learn the real state rather than reporting a failure that may not
          // have happened.
          setState((prev) => ({ ...prev, error: String(error?.message ?? error) }))
          await load()
        } finally {
          setBusy(false)
        }
      }, [])

      /**
       * Move the listener between loopback and all interfaces.
       *
       * The address cannot change under a live socket, so this saves the choice
       * and the host closes and reopens the listener. The reply carries the new
       * base URL, which the success path stores, so the page shows the address
       * that is actually bound.
       */
      const changeListen = React.useCallback(async (mode) => {
        setDraft((prev) => ({ ...prev, listen: mode }))
        await save({ ...draftRef.current, listen: mode })
      }, [save])

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
          // Touching any box is a deliberate narrowing: leave unrestricted mode,
          // otherwise the first click would be invisible (all boxes already on).
          const next = { ...prev, sharedModels, unrestricted: false }
          void save({ ...next, keys: prev.keys })
          return next
        })
      }, [save])

      /**
       * Replace the allow-list wholesale, stating the mode explicitly.
       *
       * The mode is an argument rather than something derived from the list:
       * deriving it made an empty list mean "unrestricted", so clearing ticked
       * every box back on.
       * @param ids - the models to allow.
       * @param mode - 'whitelist' (only ids) or 'unrestricted' (all models).
       */
      const setSelection = React.useCallback((ids, mode) => {
        setDraft((prev) => {
          const next = { ...prev, sharedModels: ids, unrestricted: mode === 'unrestricted' }
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
      // Read the document's own flag: inferring "unrestricted" from an empty
      // list is what made Clear impossible -- clearing re-opened everything.
      const unrestricted = draft.unrestricted !== false
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

        // 2. Base URL + who can reach it
        h('div', { className: 'ms-card' },
          h('p', { className: 'ms-title' }, 'Base URL'),
          h('div', { className: 'ms-row' },
            h('code', { className: 'ms-mono' }, data.baseUrl || '（未知）'),
            h(CopyButton, { value: data.baseUrl, label: '复制' }),
          ),
          h('div', { className: 'ms-section' },
            h('p', { className: 'ms-label' }, '监听范围'),
            // One scope per row: the explanations are sentences, and inline they
            // wrapped mid-phrase into an unreadable line.
            h('label', { className: 'ms-option' + (draft.listen !== 'all' ? ' ms-option-on' : '') },
              h('input', {
                type: 'radio',
                name: 'ms-listen',
                checked: draft.listen !== 'all',
                disabled: busy,
                onChange: () => changeListen('loopback'),
              }),
              h('span', { className: 'ms-option-body' },
                h('span', { className: 'ms-option-title' }, '仅本机'),
                h('span', { className: 'ms-option-note' }, '只有这台电脑上的程序能访问'),
              ),
            ),
            h('label', { className: 'ms-option' + (draft.listen === 'all' ? ' ms-option-on' : '') },
              h('input', {
                type: 'radio',
                name: 'ms-listen',
                checked: draft.listen === 'all',
                disabled: busy,
                onChange: () => changeListen('all'),
              }),
              h('span', { className: 'ms-option-body' },
                h('span', { className: 'ms-option-title' }, '局域网'),
                h('span', { className: 'ms-option-note' }, data.lanAddress
                  ? '同一网络的其他电脑可用 http://' + data.lanAddress + ':' + (data.port || '') + ' 访问'
                  : '同一网络的其他电脑都能访问'),
              ),
            ),
          ),
          draft.listen === 'all'
            ? h('p', { className: 'ms-warn' }, '已对局域网开放：同一网络内任何人只要拿到 Key 就能用你的模型额度。请确认 Key 没有被公开。')
            : null,
          data.lanAddress
            ? h('p', { className: 'ms-hint' }, '本机在这台电脑上仍然用 127.0.0.1 访问，切换不会影响本机程序。')
            : null,
          h('p', { className: 'ms-hint' }, '对方连不上时，先检查 Windows 防火墙是否放行了 DSH 的入站连接。'),
          h('p', { className: 'ms-hint' }, '切换后监听会立即重建，正在进行的请求会中断。'),
        ),

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
            h('label', { className: 'ms-master' },
              h('input', {
                type: 'checkbox',
                'data-master': 'true',
                // Three states, so the box reports the truth instead of showing
                // "unchecked" for "some selected".
                ref: (element) => {
                  if (element) element.indeterminate = !unrestricted && allowedCount > 0 && allowedCount < allIds.length
                },
                // Ticked means "every model", which is also what the default
                // (unrestricted) state means -- so the two look alike, which is
                // the point: the user thinks in terms of "all or a subset".
                checked: unrestricted || (allowedCount === allIds.length && allIds.length > 0),
                disabled: busy || !draft.enabled,
                onChange: (event) => {
                  // On re-enables everything; off narrows to an empty whitelist.
                  // The third state is expressed by ticking models below.
                  void (event.target.checked
                    ? setSelection(allIds, 'unrestricted')
                    : setSelection([], 'whitelist'))
                },
              }),
              h('span', null, '全部模型'),
            ),
          ),
          h('p', { className: 'ms-hint' },
            unrestricted
              ? '当前未限制：这个 Key 可以使用全部模型。勾选任意模型后即变为白名单模式。'
              : allowedCount === 0
                ? '白名单为空：这个 Key 现在调用任何模型都会被拒绝（403）。'
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
                      className: 'ms-icon-btn',
                      onClick: () => testModel(row.id),
                      disabled: probe?.state === 'running',
                      // The glyph carries no text, so the accessible name has to
                      // come from the title/aria-label pair.
                      title: probe?.state === 'running' ? '测试中…' : '测试这个模型是否可用',
                      'aria-label': '测试这个模型是否可用',
                      children: h(Icon, {
                        path: probe?.state === 'running' ? ICON_SPIN : ICON_PLAY,
                        size: 10,
                        filled: probe?.state !== 'running',
                      }),
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
# dsh-modelshare

把 DeepSeek Harness（DSH）这个 profile 里已经接好的**所有模型**，通过一个本地 **OpenAI 兼容接口**分享给其它软件，并在 DSH 设置里提供一个管理页面。

不需要第二套 API Key：每个请求都走 `ctx.llm`，所以 DSH 里能用的 provider 对第三方软件来说就是同一个接口下的不同模型。

## 页面元素

### 共享开关

页面最上方是总开关：

- **开启** —— 外部软件可以用 Key 正常调用
- **关闭** —— 所有请求立即返回 503 `sharing_disabled`，Key 和白名单设置都保留，重新打开即可恢复

关闭时页面上的 Key 和模型区域会变灰，因为此时改它们也不会生效。这个开关存在 `settings.json` 的 `enabled` 字段里，重启 DSH 后保持。

### 另外三个元素

插件在 **设置 → 模型共享** 里提供一页管理界面：

1. **API Key** —— 一键生成、一键复制；可重新生成、可删除
2. **Base URL** —— 直接复制粘贴到其它软件
3. **可用模型** —— 勾选这个 Key 能调用哪些模型（不勾=全部开放）

## 安装

### 方式一：dsh plugin add（推荐）

```bash
dsh plugin --profile desktop add github:unary-tree/dsh-modelshare
```

包声明了 `dsh.bundle.patch`，装好后会自动注册，不需要手改 YAML。

### 方式二：手动安装

```bash
# 1. 克隆到任意位置
git clone https://github.com/unary-tree/dsh-modelshare "$env:USERPROFILE\dsh-plugins\dsh-modelshare"

# 2. 建 junction，让 DSH 按包名找到它
$link   = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-modelshare"
$target = "$env:USERPROFILE\dsh-plugins\dsh-modelshare"
New-Item -ItemType Junction -Path $link -Target $target

# 3. 在 profile 的 cordis.patch.yml 末尾追加：
#    - insert:
#        - id: modelshare
#          name: dsh-modelshare
#          config:
#            host: 127.0.0.1
#            port: 8787
```

改完 `cordis.patch.yml` 会自动热加载。**新增插件的设置页面需要重启一次 DSH** 才会出现。
## 使用

打开 **设置 → 模型共享**：

1. 点「生成 API Key」，复制它
2. 复制 Base URL（形如 `http://127.0.0.1:8787/v1`）
3. 在「可用模型」里勾选要开放的模型；一个都不勾表示全部开放

然后把它填进任意 OpenAI 兼容软件：

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="ms-你的Key")

r = client.chat.completions.create(
    model="workbuddy/deepseek-v4.1-flash",
    messages=[{"role": "user", "content": "你好"}],
)
print(r.choices[0].message.content)
```

模型名写法是 `<provider>/<model>`，页面里勾选的也是这个 id。只有一个 provider 时退化为裸模型名。

## 接口

| 接口 | 说明 |
|---|---|
| `GET /v1/models` | 列出**这个 Key 被允许**的模型 |
| `POST /v1/chat/completions` | 流式 / 非流式、多轮、工具调用、`stop`、`temperature`、`max_tokens`、`reasoning_effort` |
| `POST /v1/responses` | OpenAI Responses API（Codex 等新客户端用这个），支持流式事件与函数调用 |
| `GET /health` | 健康检查（免鉴权） |
| `GET/PUT /modelshare/api/settings` | 页面读写设置（挂在 DSH Web 同源，不是 8787） |
| `POST/DELETE /modelshare/api/keys` | 页面增删 Key |

思考过程通过 `reasoning_content` 返回，与 DeepSeek 官方 API 一致。

## 鉴权与权限

- 所有 `/v1/*` 请求都必须带 `Authorization: Bearer <key>` 或 `x-api-key: <key>`，否则 401
- Key 只能调用白名单内的模型，越权返回 403 `model_not_allowed`
- 白名单为空 = 全部开放（新生成的 Key 的默认状态）
- 页面可以一键暂停共享，此时所有请求返回 503 `sharing_disabled`

## 配置项

```yaml
- insert:
    - id: modelshare
      name: dsh-modelshare
      config:
        host: 127.0.0.1          # 只监听回环；要给局域网用改成 0.0.0.0 并务必保留 Key 校验
        port: 8787
        defaultProvider: ''      # 请求省略 model 时的默认 provider
        defaultModel: ''         # 请求省略 model 时的默认模型
        modelRoutes: {}          # 模型名别名，例如 { gpt-4o: workbuddy/deepseek-v4.1-flash }
        includeUsage: true
        settingsFile: ''         # 默认 ~/.dsh/storages/dsh-modelshare/settings.json
        logFile: ''              # 默认 ~/.dsh/storages/dsh-modelshare/modelshare.log
        toolResultStyle: tool-role  # 旧版 DSH(0.1.x) 用 user-block
```

## 数据存放

| 文件 | 内容 |
|---|---|
| `~/.dsh/storages/dsh-modelshare/settings.json` | Key、白名单、Base URL、开关 |
| `~/.dsh/storages/dsh-modelshare/modelshare.log` | 运行日志（不记录 Key 与密钥） |

## 版本兼容

工具调用的消息格式在 DSH 版本间变过，插件两种都支持：

| DSH 版本 | `toolResultStyle` |
|---|---|
| 0.2.x 及以后 | `tool-role`（默认） |
| 0.1.x | `user-block` |

如果模型收不到工具结果（回答说“没有返回任何结果”），换成 `user-block` 重载再试。

## 开发

```bash
node test/smoke.mjs    # 21 项：鉴权、白名单、暂停、流式、存储
node test/client.mjs   # 8 项：页面 bundle 加载与注册
```

两个测试都不需要启动 DSH：它们用假的 `ctx.llm` 和假的模块加载器。

## 渲染注意（给改这个页面的人）

页面 bundle 里必须用 `React.createElement`，**不能用 `jsx()`**：

```js
// 对：children 是尾随参数
h('div', { className: 'x' }, h('p', null, '文字'))

// 错：jsx 的第三个参数是 key，children 会被静默丢弃 → 页面空白
jsx('div', { className: 'x' }, h('p', null, '文字'))
```

`test/page.mjs` 会断言页面渲染出可见文本，就是为了拦住这类「组件执行了但渲染为空」的 bug。

## 已知限制

- `/v1/completions`（旧版补全）与 `/v1/embeddings` 未实现（返回明确的 400）；`/v1/chat/completions` 与 `/v1/responses` 都已支持
- 图片输入受 DSH 文本适配器限制
- 请求不写入 DSH 会话历史，每次调用都是一次性请求
- **桌面版 DSH 的设置页面**：桌面 App 从前端 dist 加载 UI，不经过 HTTP `/plugins` 路由，因此页面在桌面版里是否可见取决于该版本是否启用 client-modules 路由；Web 模式（`dsh web`）下页面正常工作

## License

MIT

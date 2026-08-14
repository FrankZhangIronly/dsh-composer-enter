# dsh-composer-enter

> [DeepSeek Harness (DSH)](https://github.com/deepseek-ai) Web 插件：让你**自定义回车键**在对话框里的行为——可分别指定哪个组合键「发送消息」、哪个「插入换行」、哪个「插话(另一行为)/ 立即发送排队消息」。

插件为**双面 DSH 插件**:宿主(Node)侧负责设置命名空间与 loopback RPC 通道,浏览器侧在「设置 → 通用」渲染键位录制行,并在 document 捕获阶段拦截回车事件。

---

## 功能特性

- **设置 → 通用 中新增一行**「回车键映射」:三个键位录制框,分别对应 *发送消息*、*插入换行*、*插话(另一行为)*。
- **配置持久化到 `<dsh home>/settings.yaml`** 的 `ui-composer-enter` 命名空间。直接编辑文件,UI 会在保存时自动刷新。
- **document 捕获阶段拦截回车**,在 React 根容器监听之前执行;对输入法组合期(`isComposing` / keyCode 229)和只读态一律放行。
- **不变式自动维护**:发送与换行必须恰好一个为单独 `Enter`;插话键必须是与前两者不同的组合键。冲突的选择会被自动纠正。
- **零修改 DSH 主干**,作为普通插件安装,`@deepseek-ai/dsh` 升级不影响。

---

## 安装

```sh
dsh plugin --profile web add dsh-composer-enter
```

安装后重启 `dsh web`,在 **设置 → 通用** 中即可看到新增的「回车键映射」一行。

从本地 checkout 安装:

```sh
dsh plugin --profile web add /path/to/dsh-composer-enter
```

---

## 配置项

命名空间 `ui-composer-enter` 暴露三个字段,均须匹配 `^(?:enter|(shift|ctrl|alt|meta)(\+(shift|ctrl|alt|meta))*+enter)$`:

| 字段          | 默认值        | 含义                                                       |
| ------------- | ------------- | ---------------------------------------------------------- |
| `sendCombo`   | `enter`       | **发送消息** 的组合键。                                    |
| `newlineCombo`| `shift+enter` | **插入换行** 的组合键。                                    |
| `steerCombo`  | `ctrl+enter`  | **插话(另一行为)** 的组合键:空闲时等同发送,智能体运行时插话或立即发送排队消息。必须与前两者不同,且不能是单独的 `Enter`。 |

可以在「设置」UI 改,也可以直接改 `settings.yaml`:

```yaml
ui-composer-enter:
  sendCombo: enter
  newlineCombo: shift+enter
  steerCombo: ctrl+enter
```

插件监听 `settings/document-updated` 事件,文件被外部修改后会自动重读。

---

## 拦截原理

当映射等于应用默认值(`enter` / `shift+enter` / `ctrl+enter`)时,**完全不拦截**,DSH 原生行为原样保留。

其他任意映射下:

- **插话组合** → 合成一个 `Ctrl+Enter` 事件,沿用应用自带的 busy/queue 逻辑(空闲时立即发送,智能体运行时插话)。
- **发送组合** → 合成一个普通 `Enter` 事件,沿用应用自带的弹层仲裁 / 队列提交逻辑。
- **其他所有 Enter 变体** → 通过 `document.execCommand('insertText', false, '\n')` 插入换行。

合成事件用 `dispatching` 标志防重入(否则合成的 Enter 会再次落入「其他→换行」分支)。监听器在 **捕获阶段** 执行并调用 `stopPropagation()`,确保先于根容器监听器。输入法组合期与只读输入框一律放行。

---

## 仓库结构

```
composer-enter/
├── cordis.patch.yml       # 宿主 bundle patch:插入 composer-enter 行
├── lib/
│   ├── index.js           # 宿主半(Node):设置命名空间 + /composer-enter RPC
│   └── client.js          # 浏览器半:设置行 + 回车拦截
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
└── README.md / README.zh-CN.md
```

`cordis.patch.yml` 向宿主组合树插入一行,声明 `inject: [connection]`,确保 RPC 通道在宿主连接服务就绪后才注册。

---

## RPC 协议(宿主侧)

通道:`/composer-enter` · 权限:`loopback`(非本机调用方自动 403)。

| 端点    | 入参                | 返回                                                          |
| ------- | ------------------- | ------------------------------------------------------------- |
| `get`   | `{}`                | `{ ok: true, value: <已解析命名空间> }`                       |
| `set`   | 部分命名空间对象    | 合并写回 `settings.yaml` 后 `{ ok: true, value: <已解析值> }`;校验失败返回 `{ ok: false, error }`。 |
| `status`| `{}`                | `{ ok: true, value: { exitAvailable } }`(健康探针,同 `dsh-system-control`)。 |

handler 走宿主 `settings` 服务(`dsh-settings-file`),绕过浏览器侧的 `WEB_SETTINGS_NAMESPACES` 白名单——这是插件能托管第三方命名空间 `ui-composer-enter` 的关键。

---

## 兼容性

- `@deepseek-ai/dsh` 当前 web profile(插件消费 `connection`、`slots`、`locale`、`remote`,以及可选的 `settings` 服务)。
- Node ≥ 18(与 DSH 宿主运行时一致)。
- 浏览器:Chromium 内核(使用 `KeyboardEvent` 合成与 `document.execCommand`)。

---

## 许可证

MIT
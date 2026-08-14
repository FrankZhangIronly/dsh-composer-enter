# dsh-composer-enter

> A [DeepSeek Harness (DSH)](https://github.com/deepseek-ai) web plugin that lets you remap how the **Enter** key behaves in the chat composer — pick which key combination sends the message, which one inserts a newline, and which one triggers the **interject** (queue / steer) action.

The plugin is shipped as a **two-sided DSH plugin**: a host (Node) half that owns the settings namespace and a loopback RPC channel, and a browser half that renders the key-mapping row in *Settings → General* and intercepts Enter at the document capture phase.

> 🌏 **[中文版本 / Chinese version](./README.zh-CN.md)** is also available.

---

## Features

- **Settings row in General settings** with three key recorders: *Send message*, *Insert newline*, *Interject (other)*.
- **Persistent configuration** stored in `<dsh home>/settings.yaml` under the namespace `ui-composer-enter`. Edit the file directly and the UI refreshes on save.
- **Document-capture Enter interceptor** that runs *before* React's listeners, with full respect for IME composition (`isComposing` / keyCode 229) and readonly states.
- **Invariant enforcement**: send and newline are always complementary (exactly one of them is plain Enter); the interject key is always a distinct combination. Conflicting selections are auto-corrected.
- **Zero changes to DSH core** — installed as an ordinary plugin, survives `@deepseek-ai/dsh` updates.

---

## Installation

```sh
dsh plugin --profile web add dsh-composer-enter
```

After installation, restart `dsh web`. The new row *"回车键映射" / "Enter key mapping"* will appear in **Settings → General**.

To install from a local checkout:

```sh
dsh plugin --profile web add /path/to/dsh-composer-enter
```

---

## Configuration

The namespace `ui-composer-enter` exposes three fields, all matching `^(?:enter|(shift|ctrl|alt|meta)(\+(shift|ctrl|alt|meta))*+enter)$`:

| Field          | Default        | Meaning                                                       |
| -------------- | -------------- | ------------------------------------------------------------- |
| `sendCombo`    | `enter`        | The combination that **sends** the message.                   |
| `newlineCombo` | `shift+enter`  | The combination that **inserts a newline** into the composer.|
| `steerCombo`   | `ctrl+enter`   | The combination that **interjects / flushes queued messages**. Must differ from both above and may not be plain `Enter`. |

You can change these in the Settings UI, or by hand in `settings.yaml`:

```yaml
ui-composer-enter:
  sendCombo: enter
  newlineCombo: shift+enter
  steerCombo: ctrl+enter
```

The plugin watches `settings/document-updated` and reloads automatically whenever the file changes.

---

## How the interceptor works

When the mapping matches the app default (`enter` / `shift+enter` / `ctrl+enter`) the plugin **does not intercept at all** — DSH's native handling is preserved.

For any other mapping:

- The **interject combination** is translated into a synthesized `Ctrl+Enter` keydown so the app's built-in busy/queue logic fires identically.
- The **send combination** is translated into a synthesized plain `Enter`, again preserving the app's overlay/queue arbitration.
- **All other Enter variants** are turned into a newline (`document.execCommand('insertText', false, '\n')`).

Synthesis uses a `dispatching` flag to prevent the synthesized event from re-entering the same handler. Listeners run in the *capture* phase and call `stopPropagation()`, so they beat any root-container listener. IME composition and readonly composers are never intercepted.

---

## Repository layout

```
composer-enter/
├── cordis.patch.yml       # bundle patch: insert the composer-enter row
├── lib/
│   ├── index.js           # host half (Node): settings namespace + /composer-enter RPC
│   └── client.js          # browser half: settings row + Enter interceptor
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
└── README.md
```

The `cordis.patch.yml` adds a single row to the host composition tree that injects `connection` so the RPC channel can register itself once the host connection service exists.

---

## RPC contract (host half)

Channel: `/composer-enter` · authority: `loopback` (non-local callers get `403`).

| Endpoint | Payload           | Returns                                         |
| -------- | ----------------- | ----------------------------------------------- |
| `get`    | `{}`              | `{ ok: true, value: <resolved namespace> }`     |
| `set`    | partial namespace | `{ ok: true, value: <resolved namespace> }` after merge-persisting to `settings.yaml`; `{ ok: false, error }` on validation failure. |
| `status` | `{}`              | `{ ok: true, value: { exitAvailable } }` (sanity probe — same shape as `dsh-system-control`). |

The handler reads and writes through the host settings service (`dsh-settings-file`), bypassing the browser's `WEB_SETTINGS_NAMESPACES` whitelist — that is the only reason the plugin can own a third-party namespace like `ui-composer-enter`.

---

## Compatibility

- `@deepseek-ai/dsh` ≥ current web profile (the plugin consumes `connection`, `slots`, `locale`, `remote`, and the optional `settings` service).
- Node ≥ 18 (matches DSH host runtime).
- Browser: Chromium-based (the plugin uses `KeyboardEvent` synthesis and `document.execCommand`).

---

## License

MIT
// dsh-composer-enter — 宿主半（node half）
// 1) 注册用户设置命名空间 `ui-composer-enter`（sendCombo / newlineCombo / steerCombo），
//    持久化到 <dsh home>/settings.yaml（dsh-settings-file 提供者），外部编辑热发布。
// 2) 提供 loopback RPC 通道 `/composer-enter`：
//      get  -> 返回命名空间的已解析值（含 schema 默认值），即 settings.yaml 生效值
//      set  -> 合并写回用户层并持久化，返回新的已解析值
//    走宿主侧 settings 服务（不经 api-proxy 的 WEB_SETTINGS_NAMESPACES 白名单），
//    因此第三方命名空间也能被浏览器读写 —— 前端改动写 settings.yaml，
//    直接改 settings.yaml 同样生效，以文件配置为准。
// 固定逻辑由客户端 UI 强制：发送与换行必须恰好一个为单独的 Enter；
// 插话键必须为组合键且不与前两者相同。

import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by this plugin. */
const NS = 'ui-composer-enter'
/** Loopback RPC channel carrying get/set for the namespace. */
const CHANNEL = '/composer-enter'
/** Field carrying the send-key combination. */
const SEND_COMBO_FIELD = 'sendCombo'
/** Field carrying the newline-key combination. */
const NEWLINE_COMBO_FIELD = 'newlineCombo'
/** Field carrying the interject (other behavior) key combination. */
const STEER_COMBO_FIELD = 'steerCombo'
/** Default send combination (plain Enter, current app behavior). */
const DEFAULT_SEND_COMBO = 'enter'
/** Default newline combination (Shift+Enter, current app behavior). */
const DEFAULT_NEWLINE_COMBO = 'shift+enter'
/** Default interject combination (Cmd/Ctrl+Enter, current app behavior). */
const DEFAULT_STEER_COMBO = 'ctrl+enter'
/**
 * Accepted combination shapes: plain `enter`, or one or more of
 * shift/ctrl/alt/meta followed by `+enter` (any modifier order).
 */
const COMBO_PATTERN = /^(?:enter|(?:shift|ctrl|alt|meta)(?:\+(?:shift|ctrl|alt|meta))*\+enter)$/

/** Durable composer-enter schema; also the wire envelope the RPC responses carry. */
const ComposerEnterSchema = z.object({
  [SEND_COMBO_FIELD]: z.string().pattern(COMBO_PATTERN).default(DEFAULT_SEND_COMBO),
  [NEWLINE_COMBO_FIELD]: z.string().pattern(COMBO_PATTERN).default(DEFAULT_NEWLINE_COMBO),
  [STEER_COMBO_FIELD]: z.string().pattern(COMBO_PATTERN).default(DEFAULT_STEER_COMBO),
})

const rpcError = (message) => ({ ok: false, error: { code: 'internal', message, details: {} } })

/**
 * Register the namespace (when a settings provider exists) and the loopback
 * RPC channel that reads/writes it through the host settings service.
 * @param ctx - Host context.
 */
function apply(ctx) {
  let scope = undefined
  ctx.inject(['settings'], (settingsCtx) => {
    scope = settingsCtx.settings.register(settingsNamespace(NS), ComposerEnterSchema)
  })

  const connection = ctx.get('connection')
  if (connection === undefined) return

  const handler = async (endpoint, payload) => {
    if (endpoint === 'get') {
      if (scope === undefined) return rpcError('settings service unavailable')
      return { ok: true, value: scope.get() }
    }
    if (endpoint === 'set') {
      if (scope === undefined) return rpcError('settings service unavailable')
      const patch = payload !== null && typeof payload === 'object' ? payload : {}
      try {
        await scope.update(patch)
      } catch (error) {
        return rpcError(error instanceof Error ? error.message : String(error))
      }
      return { ok: true, value: scope.get() }
    }
    return rpcError(`unknown endpoint ${String(endpoint)}`)
  }

  ctx.effect(
    () => connection.rpc.handle(CHANNEL, handler, { authority: 'loopback' }),
    'composer-enter: settings rpc channel',
  )
}

export { apply, NS, CHANNEL, SEND_COMBO_FIELD, NEWLINE_COMBO_FIELD, STEER_COMBO_FIELD, DEFAULT_SEND_COMBO, DEFAULT_NEWLINE_COMBO, DEFAULT_STEER_COMBO, COMBO_PATTERN }
export default { apply }

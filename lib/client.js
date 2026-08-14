// dsh-composer-enter — 浏览器半（client half）
// 1) 在「通用设置」注册一行「回车键映射」：三个键位录制框（发送消息 / 插入换行 / 插话），
//    点击后按下新的组合键即可录制（Esc 取消）。
//    固定逻辑：
//      - 发送与换行必须恰好一个为单独的 Enter（录成组合键 → 另一项变 Enter；
//        录成 Enter → 另一项保留原组合，否则用默认组合键）；
//      - 插话键必须为组合键且不与发送/换行相同（默认 Ctrl+Enter）；
//        空闲时插话键等同发送（加速提交），智能体运行时为 busyEnter 偏好的
//        「另一行为」/ 立即发送排队消息 —— 完整保留内置 Cmd/Ctrl+Enter 语义。
// 2) 持久化走宿主 RPC 通道 /composer-enter（宿主侧 settings 服务直写
//    <dsh home>/settings.yaml，不经浏览器设置白名单）：
//      - 初始与外部改动通过 `settings/document-updated` 事件触发重读；
//      - 前端改动经 RPC set 写回 settings.yaml —— 直接改文件同样生效，以文件为准。
// 3) document 捕获阶段拦截输入框（[data-composer-card] 内的 textarea）的 Enter：
//      - 映射等于原生默认（发送=Enter、换行=Shift+Enter、插话=Ctrl+Enter）：完全不拦截；
//      - 其他映射：插话组合 → 合成 Ctrl+Enter（加速语义）；发送组合 → 合成普通 Enter
//        （弹层仲裁、忙碌队列等与今天按 Enter 完全一致）；其余 Enter 变体插入换行；
//      - 合成事件用 dispatching 标志防重入（否则合成 Enter 会再次落入「其余→换行」）。
//    拦截先于 React 根容器监听执行（捕获阶段 + stopPropagation），
//    输入法组合期（isComposing / keyCode 229）与只读态（提交瞬间、工作区选择）一律放行。
window.__ModuleLoader__.load({
	id: "dsh-composer-enter",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let runtimeClient = require("@deepseek-ai/dsh-client-runtime/client");

		const inject = ["slots", "locale", "connection", "remote"];

		const NS = "ui-composer-enter";
		const CHANNEL = "/composer-enter";
		const SEND_COMBO_FIELD = "sendCombo";
		const NEWLINE_COMBO_FIELD = "newlineCombo";
		const STEER_COMBO_FIELD = "steerCombo";
		const DEFAULT_SEND_COMBO = "enter";
		const DEFAULT_NEWLINE_COMBO = "shift+enter";
		const DEFAULT_STEER_COMBO = "ctrl+enter";
		// 某一项被录成单独 Enter 时，另一项的兜底组合键
		const FALLBACK_SEND_COMBO = "ctrl+enter";
		const FALLBACK_NEWLINE_COMBO = "shift+enter";
		// 组合键候选（冲突时依次选用，避开已占用项）
		const COMBO_FALLBACKS = ["ctrl+enter", "shift+enter", "alt+enter", "meta+enter"];

		// 设置行样式（布局镜像官方 EnterBehaviorRow，类名加前缀避免冲突）
		const CSS = ".cmpen_row{border-bottom:1px solid var(--dsw-alias-border-l2);flex-direction:column;gap:12px;padding:16px 0;display:flex}.cmpen_head{flex-direction:column;gap:4px;min-width:0;display:flex}.cmpen_title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}.cmpen_desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}.cmpen_map{display:flex;gap:12px}.cmpen_group{box-sizing:border-box;flex:1;flex-direction:column;gap:6px;min-width:0;display:flex}.cmpen_groupLabel{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}.cmpen_recorder{box-sizing:border-box;background:var(--dsw-alias-bg-module-platform);width:100%;height:36px;font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;justify-content:center;align-items:center;gap:8px;padding:0 12px;font-size:13px;line-height:22px;display:inline-flex}.cmpen_recorder:hover{background:var(--dsw-alias-interactive-bg-hover)}.cmpen_recorderArmed{border-color:var(--dsw-alias-brand-primary)}";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify("dsh-composer-enter/ui.css") + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-composer-enter";
			tag.dataset.pluginCss = "dsh-composer-enter/ui.css";
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/** 按键修饰键组合（严格精确匹配）：shift/ctrl/alt/meta 的排列 + enter。 */
		const comboOf = (e) => {
			const parts = [];
			if (e.shiftKey) parts.push("shift");
			if (e.ctrlKey) parts.push("ctrl");
			if (e.altKey) parts.push("alt");
			if (e.metaKey) parts.push("meta");
			parts.push("enter");
			return parts.join("+");
		};

		/** "ctrl+shift+enter" -> "Ctrl+Shift+Enter"。 */
		const displayCombo = (combo) => combo.split("+").map((part) => part === "enter" ? "Enter" : part.charAt(0).toUpperCase() + part.slice(1)).join("+");

		/** 从候选组合键里挑一个未被排除的（优先 prefer，否则按顺序取第一个可用）。 */
		const pickCombo = (excluded, prefer) => {
			if (prefer !== undefined && !excluded.includes(prefer)) return prefer;
			return COMBO_FALLBACKS.find((c) => !excluded.includes(c)) ?? "shift+enter";
		};

		/** 归一化三项键位的不变式：发送/换行恰有一个为 Enter；插话为组合键且不与前两者相同。 */
		const normalize = (next) => {
			if (next.sendCombo === "enter" && next.newlineCombo === "enter") {
				// 防御分支（正常由 setter 处理）：发送回 Enter 时尽量恢复默认布局
				if (next.steerCombo === "shift+enter" || next.steerCombo === "ctrl+enter") {
					next.newlineCombo = DEFAULT_NEWLINE_COMBO;
					next.steerCombo = DEFAULT_STEER_COMBO;
				} else {
					next.newlineCombo = pickCombo([next.sendCombo, next.steerCombo], FALLBACK_NEWLINE_COMBO);
				}
			} else if (next.sendCombo !== "enter" && next.newlineCombo !== "enter") {
				next.newlineCombo = "enter";
			}
			if (next.steerCombo === "enter" || next.steerCombo === next.sendCombo || next.steerCombo === next.newlineCombo) {
				next.steerCombo = pickCombo([next.sendCombo, next.newlineCombo], DEFAULT_STEER_COMBO);
			}
			return next;
		};

		/** 键位录制器：点击进入录制，下一次 Enter 组合键即提交，Esc 取消；accept 为 false 的组合忽略（保持录制）。 */
		function KeyRecorder({ value, onCommit, t, accept }) {
			const [armed, setArmed] = react.useState(false);
			react.useEffect(() => {
				if (!armed) return;
				const onKey = (e) => {
					if (e.key === "Escape") {
						e.preventDefault();
						e.stopPropagation();
						setArmed(false);
						return;
					}
					if (e.key !== "Enter") return;
					e.preventDefault();
					e.stopPropagation();
					const combo = comboOf(e);
					if (accept !== undefined && !accept(combo)) return;
					onCommit(combo);
					setArmed(false);
				};
				document.addEventListener("keydown", onKey, true);
				return () => document.removeEventListener("keydown", onKey, true);
			}, [armed, onCommit, accept]);
			return react.createElement("button", {
				type: "button",
				className: "cmpen_recorder" + (armed ? " cmpen_recorderArmed" : ""),
				title: t("recorder.hint"),
				onClick: () => setArmed((v) => !v),
			}, armed ? t("recorder.armed") : displayCombo(value));
		}

		/** 通用设置行：发送 / 换行 / 插话三个键位录制框。 */
		function EnterMappingRow({ useMapping, setSendCombo, setNewlineCombo, setSteerCombo, t }) {
			const send = useMapping((value) => value.sendCombo);
			const newline = useMapping((value) => value.newlineCombo);
			const steer = useMapping((value) => value.steerCombo);
			return react.createElement("div", { className: "cmpen_row" },
				react.createElement("div", { className: "cmpen_head" },
					react.createElement("div", { className: "cmpen_title" }, t("settings.title")),
					react.createElement("div", { className: "cmpen_desc" }, t("settings.description")),
				),
				react.createElement("div", { className: "cmpen_map" },
					react.createElement("div", { className: "cmpen_group" },
						react.createElement("div", { className: "cmpen_groupLabel" }, t("field.send")),
						react.createElement(KeyRecorder, { value: send, onCommit: setSendCombo, t }),
					),
					react.createElement("div", { className: "cmpen_group" },
						react.createElement("div", { className: "cmpen_groupLabel" }, t("field.newline")),
						react.createElement(KeyRecorder, { value: newline, onCommit: setNewlineCombo, t }),
					),
					react.createElement("div", { className: "cmpen_group" },
						react.createElement("div", { className: "cmpen_groupLabel" }, t("field.steer")),
						react.createElement(KeyRecorder, { value: steer, onCommit: setSteerCombo, t, accept: (combo) => combo !== "enter" }),
					),
				),
			);
		}

		function apply(ctx) {
			const slots = ctx.get("slots");
			const locale = ctx.get("locale");
			const connection = ctx.get("connection");
			const remote = ctx.get("remote");
			if (slots === undefined || locale === undefined || connection === undefined) return;

			const store = runtimeClient.createSnapshotStore({
				sendCombo: DEFAULT_SEND_COMBO,
				newlineCombo: DEFAULT_NEWLINE_COMBO,
				steerCombo: DEFAULT_STEER_COMBO,
			});

			// 从宿主 RPC 重读并采纳（初始加载 / 外部 settings.yaml 改动后）
			const reload = async () => {
				try {
					const result = await connection.rpc.call(CHANNEL, "get", {});
					if (result !== undefined && result.ok === true && result.value !== null && typeof result.value === "object") {
						adopt(result.value);
					}
				} catch (_err) {
					/* 宿主未就绪时保持默认 */
				}
			};

			// 采纳值并归一化不变式
			const adopt = (section) => {
				const cur = store.getSnapshot();
				const next = normalize({
					sendCombo: typeof section[SEND_COMBO_FIELD] === "string" ? section[SEND_COMBO_FIELD] : cur.sendCombo,
					newlineCombo: typeof section[NEWLINE_COMBO_FIELD] === "string" ? section[NEWLINE_COMBO_FIELD] : cur.newlineCombo,
					steerCombo: typeof section[STEER_COMBO_FIELD] === "string" ? section[STEER_COMBO_FIELD] : cur.steerCombo,
				});
				if (next.sendCombo !== cur.sendCombo || next.newlineCombo !== cur.newlineCombo || next.steerCombo !== cur.steerCombo) store.set(next);
			};

			// 乐观更新 + RPC 写回 settings.yaml；宿主返回的已解析值用于校准
			const persist = async (next) => {
				store.set(next);
				try {
					const result = await connection.rpc.call(CHANNEL, "set", next);
					if (result !== undefined && result.ok === true && result.value !== null && typeof result.value === "object") {
						adopt(result.value);
					}
				} catch (_err) {
					/* 写失败保持乐观值，会话内仍生效 */
				}
			};
			// 写发送键：组合键 → 换行变 Enter；单独 Enter → 换行让位（尽量恢复默认布局）
			const setSendCombo = (combo) => {
				const cur = store.getSnapshot();
				if (cur.sendCombo === combo) return;
				const next = { ...cur, sendCombo: combo };
				if (combo === "enter" && next.newlineCombo === "enter") {
					if (next.steerCombo === "shift+enter" || next.steerCombo === "ctrl+enter") {
						next.newlineCombo = DEFAULT_NEWLINE_COMBO;
						next.steerCombo = DEFAULT_STEER_COMBO;
					} else {
						next.newlineCombo = pickCombo([next.sendCombo, next.steerCombo], FALLBACK_NEWLINE_COMBO);
					}
				}
				persist(normalize(next));
			};
			// 写换行键：组合键 → 发送变 Enter；单独 Enter → 发送让位为组合键（避开插话键）
			const setNewlineCombo = (combo) => {
				const cur = store.getSnapshot();
				if (cur.newlineCombo === combo) return;
				const next = { ...cur, newlineCombo: combo };
				if (combo === "enter" && next.sendCombo === "enter") {
					next.sendCombo = pickCombo([next.steerCombo, next.newlineCombo], FALLBACK_SEND_COMBO);
				}
				persist(normalize(next));
			};
			// 写插话键：必须为组合键；冲突（与发送/换行相同）时由 normalize 让位
			const setSteerCombo = (combo) => {
				if (combo === "enter") return;
				const cur = store.getSnapshot();
				if (cur.steerCombo === combo) return;
				persist(normalize({ ...cur, steerCombo: combo }));
			};

			ctx.effect(() => locale.register(NS, {
				zh: {
					"settings.title": "回车键映射",
					"settings.description": "点击后按下组合键即可录制，配置保存在 settings.yaml。发送与换行必须恰好一个为单独的 Enter；插话键（另一行为）须为组合键且不与前两者相同：空闲时等同发送，智能体运行时插话或立即发送排队消息",
					"field.send": "发送消息",
					"field.newline": "插入换行",
					"field.steer": "插话（另一行为）",
					"recorder.hint": "点击后按下新的组合键（Esc 取消）",
					"recorder.armed": "按下组合键…（Esc 取消）",
				},
				en: {
					"settings.title": "Enter key mapping",
					"settings.description": "Click, then press a key combination to record it; config is saved to settings.yaml. Send and newline must be complementary: exactly one is plain Enter. The interject key (other behavior) must be a distinct combination: it sends when idle and interjects / flushes queued messages while the agent is running",
					"field.send": "Send message",
					"field.newline": "Insert newline",
					"field.steer": "Interject (other)",
					"recorder.hint": "Click, then press the new key combination (Esc to cancel)",
					"recorder.armed": "Press a combination… (Esc to cancel)",
				},
			}), "composer-enter: dictionaries");

			slots.inject("settings.general.item", () => slots.register({
				name: "settings.general.item",
				id: "composer-enter-behavior",
				order: 25,
				locale: NS,
				inject: () => ({
					hooks: { mapping: store },
					setSendCombo,
					setNewlineCombo,
					setSteerCombo,
				}),
			}, EnterMappingRow));

			// 外部（settings.yaml 文件编辑 / 其他页面）改动 → 重读
			if (remote !== undefined) {
				ctx.effect(() => remote.$on("settings/document-updated", (ns) => {
					if (ns === NS) reload();
				}), "composer-enter: settings document watcher");
			}

			reload();

			// 捕获阶段拦截：先于 React 根容器监听执行
			let dispatching = false; // 合成事件防重入
			const onKeyDown = (e) => {
				if (dispatching) return; // 我们派发的合成事件直接放行给输入框原有逻辑
				if (e.key !== "Enter") return;
				if (e.isComposing || e.keyCode === 229) return; // 输入法组合期放行
				const target = e.target;
				if (!(target instanceof HTMLTextAreaElement)) return;
				if (target.readOnly) return; // 提交瞬间 / 工作区选择态放行
				if (target.closest("[data-composer-card]") === null) return; // 仅输入框
				const { sendCombo, newlineCombo, steerCombo } = store.getSnapshot();
				// 原生默认（发送=Enter、换行=Shift+Enter、插话=Ctrl+Enter）：不拦截，保持应用原行为
				if (sendCombo === "enter" && newlineCombo === "shift+enter" && steerCombo === "ctrl+enter") return;
				const combo = comboOf(e);
				if (combo === steerCombo) {
					// 插话键 → 合成 Ctrl+Enter（加速语义：空闲=加速发送；运行时=另一行为/立即插话）
					e.preventDefault();
					e.stopPropagation();
					if (e.repeat) return;
					dispatching = true;
					try {
						target.dispatchEvent(new KeyboardEvent("keydown", {
							key: "Enter",
							code: "Enter",
							keyCode: 13,
							which: 13,
							ctrlKey: true,
							bubbles: true,
							cancelable: true,
						}));
					} finally {
						dispatching = false;
					}
					return;
				}
				if (combo === sendCombo) {
					if (sendCombo === "enter") return; // 单独 Enter 发送：放行给原逻辑
					// 组合键发送 → 翻译成普通 Enter，交给输入框原有逻辑（弹层仲裁 / 发送）
					e.preventDefault();
					e.stopPropagation();
					if (e.repeat) return;
					dispatching = true;
					try {
						target.dispatchEvent(new KeyboardEvent("keydown", {
							key: "Enter",
							code: "Enter",
							keyCode: 13,
							which: 13,
							bubbles: true,
							cancelable: true,
						}));
					} finally {
						dispatching = false;
					}
					return;
				}
				// 其余 Enter 变体（含换行组合与未绑定组合）→ 插入换行
				e.preventDefault();
				e.stopPropagation();
				if (e.repeat) return;
				target.focus();
				try {
					document.execCommand("insertText", false, "\n");
				} catch (_err) {
					/* 只读等异常环境静默 */
				}
			};
			ctx.effect(() => {
				document.addEventListener("keydown", onKeyDown, true);
				return () => document.removeEventListener("keydown", onKeyDown, true);
			}, "composer-enter: keydown interceptor");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

# Local Network Diagnostics — Handoff（开发交接笔记）

面向继续开发此工程的开发者与 AI 代理：记录结构约定、边界与已知决策。

## 分层约定

- `lib/` 是可复用核心，**不得包含作品特定逻辑**。改动它意味着所有继承该模板的工程都受影响。
- **例外（本工程）**：`lib/diagnostics.js` 承载本工程的作品语义（诊断指标 + 状态机 + 事件日志）——本工程的作品本身就是网络诊断，且该模块是纯逻辑（无 timer / socket / IO，可单测），见决策记录。
- `server.js` 只做编排（协议挂载、广播、生命周期），不含业务算法。
- `public/shared.js` 是浏览器与 server 的**单一事实来源**（事件名、客户端上限、诊断状态文案 `statusCopy`、诊断词汇表 `diagPhases`/`diagEvents`），必须保持 UMD 形态（浏览器全局 `window.PNDS` + Node `module.exports`）。
- **本工程无音频**：没有 `audio/`、`supercollider/`、`lib/audio-engine.js`、`lib/osc-transport.js`；server 恒为 `none` 模式。

## 端口约定

端口只在 `manifest.json` 定义（`scoreServer.performerPort` / `monitorPort`）。`shared.js` 在 Node 端从 manifest 读取，浏览器端通过 server 注入的 `__config.js` 获取。创作者改端口只需改 manifest.json，无需手动同步任何文件。

## PNDS 契约要点（必须遵守）

- `scoreServer.entry` 指向 `server.js`，路径必须在工程根内；禁止绝对路径与 `../`。
- manifest 的 `audio` 块只声明 `defaultMode: "none"` 与 `supportedModes: ["none"]`（App 按 defaultMode 传 `--audio-mode`；server 接受该参数但忽略其值）。
- health ready 前无任何前置条件（无音频引擎可等）：HTTP server 监听成功即 `setAudioDisabled()`，按运行契约返回 `audio.status: "disabled"`、`audio.target: null`。
- 退出时释放全部资源（Socket.IO、HTTP server）——见 `lib/lifecycle.js`。

## 决策记录

- **本工程是纯网络测试工具（无音频）**：删除模板的音频链路（audio/、supercollider/、audio-engine/osc-transport、control/set-out 事件、lastControls、freqRange）。`PlayerRegistry` 上限改为 `shared.maxClients`（16）。health 恒报告 `audioMode: "none"` + `audio.status: "disabled"`（运行契约对 none 模式的要求；模板原来在 none 模式误报 "ready"，本工程修正）。
- **performer 端极简**：只显示 "Connected, testing…"（英文，与全站一致；自动 join + 应答探针 + claim token 恢复身份），无任何演奏 UI。
- **monitor 端居中设计**：参照 "Multichannel Signal Generator" 示例的前端（浅色主题、居中 flex 列、圆角白卡片、accent `#5a4ff3`）；纯 DOM，**不再使用 p5**。卡片网格由诊断名册（`diag.clients`）驱动（断开客户端保留为红卡）；详情为居中模态弹窗。**无 Start/Stop 按钮——打开页面即自动开始测试**（`diagStart` 事件保留，server 对重复 start 幂等）；**不显示 Burst/Calm 阶段徽章**（`diagPhases` 仍由 server 使用，仅 UI 不展示）。
- **`lib/diagnostics.js` 是"lib/ 不含作品逻辑"的例外**：本工程的作品即网络诊断，指标与状态机是作品核心；保留在 lib/ 是因为它是纯函数模块（无 IO），与 `health.js` / `players.js` 一样可独立单测。阈值（100/50/25/10 ms、5%、3 次、200/500 ms、2 s 阶段）与规则优先级都在此文件，改作品行为改这里。
- **探针只发给已 join 的 performer**；monitor 页面（不 join）不参与探测——spec 的测试范围是"Server ↔ Wi-Fi 连接的移动客户端"，monitor 运行在操作主机上。
- **1–2 次连续 timeout 判 Yellow**：spec 只规定"连续 3 次 → Red"，未规定 1–2 次；为避免"正在超时的客户端显示 Green 并累计 hysteresis 恢复计数"，补为 Yellow（"Recent probe timeouts"）。
- **断开即 Red 已生产接线（#6）**：客户端断开时卡片**保留并立即转 Red**（`disconnectClient`，绕开 warm-up gray 守卫），事件日志记录 Disconnected；重连凭 claim token 恢复原 id（`addClient` 对已存在 id 走"重连"路径：重置指标与状态机、追加 Reconnected 事件、重新 warm-up）。
- **卡片展示 p50/p95/jitter + 最近事件；详情弹窗（#8）展示 p95、丢包率、处理耗时与完整事件日志**（最多 20 条/客户端，环形）；详情指标只读展示，不参与状态判定。
- **Burst 循环（#5）**：测试启动即进入 burst 阶段（无预热延迟），`[2 s burst @ 30 msg/s，200 ms 超时] → [2 s calm @ 1 Hz，500 ms 超时]` 持续交替。30 msg/s 下同一客户端可同时存在多个 in-flight 探针，`pendings` 因此从"每客户端单 pending"改为"每客户端 per-seq Map"。
- **burst 超时率按"完成的 burst 窗口"冻结**（`endBurstWindow`）：calm 期间沿用上一窗口的值；空窗口记 0。冻结延迟 `BURST_TIMEOUT_MS`（200 ms）执行，把窗口尾部（最后 200 ms 内发出的探针，其超时在 phase 切换后才触发）计入本窗口而不是下一个。这样坏 burst 的 Red 会持续到 hysteresis 恢复，不会在 calm 中被稀释。
- **Overall 只统计在线客户端（#7）**：spec 原文"取所有在线客户端中最差的状态"，断开（离线）客户端不参与 Overall，但其红色卡片保留可见；无在线客户端时 Overall = Gray。
- **Monitor 卡片网格由诊断名册（`diag.clients`）驱动，而非音频快照**：断开时卡片继续显示 "Disconnected 5s ago" 并可打开详情（#6 验收）。state 广播只含 `diag`（无音频快照）。
- **phase / 事件类型词汇表进 shared.js**（`diagPhases` / `diagEvents`）：server（lib）产生、monitor 消费的字符串协议，与 `statusCopy` 同一 SSOT 文化；改词汇只需改 shared.js 一处。
- **30 msg/s 下连续超时规则先于 burst 超时率规则触发**（spec 优先级 2 > 3）：一次丢 3+ 个连续 probe 即 Red；burst 规则覆盖"散布丢包"场景。E2E 用孤立丢包（每 5 丢 1）隔离 burst 规则。
- **丢包率 = timeouts / (acks + timeouts)**（生命周期计数，滑动窗口裁剪不影响），仅详情面板。
- QR 码由 `lib/qr.js` 生成（`qrcode` npm 包，`GET /qr` 挂在 monitor server），monitor 页面底部展示。
- 本工程**不预装 node_modules**（`.gitignore` 排除）；首次使用按 creator-guide 执行 `npm install`。发布包必须预装。

## 验证命令

```sh
npm run check   # 全部 JS 语法检查
npm test        # node --test（config / players / diagnostics / E2E）
```

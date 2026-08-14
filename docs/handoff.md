# Local Network Diagnostics — Handoff（开发交接笔记）

面向继续开发此工程的开发者与 AI 代理：记录结构约定、边界与已知决策。

## 分层约定

- `lib/` 是可复用核心，**不得包含作品特定逻辑**。改动它意味着所有继承该模板的工程都受影响。
- **例外（本工程）**：`lib/diagnostics.js` 承载本工程的作品语义（诊断指标 + 状态机）——本工程的作品本身就是网络诊断，且该模块是纯逻辑（无 timer / socket，可单测），见决策记录。
- `audio/controller.js` 是作品语义层：id → voice、声道分配、external OSC 协议。
- `server.js` 只做编排（协议挂载、广播、生命周期），不含业务算法。
- `public/shared.js` 是浏览器与 server 的**单一事实来源**（事件名、频率范围、诊断状态文案 `statusCopy`），必须保持 UMD 形态（浏览器全局 `window.PNDS` + Node `module.exports`）。

## 端口约定

端口只在 `manifest.json` 定义（`scoreServer.performerPort` / `monitorPort`）。`shared.js` 在 Node 端从 manifest 读取，浏览器端通过 server 注入的 `__config.js` 获取。创作者改端口只需改 manifest.json，无需手动同步任何文件。

## PNDS 契约要点（必须遵守）

- `scoreServer.entry` 指向 `server.js`，路径必须在工程根内；禁止绝对路径与 `../`。
- Internal 模式只加载 `supercollider/synthdefs/*.scsyndef`（编译产物），`.scd` 只是创作期文件。
- 读取 `PNDS_AUDIO_OUTPUT_BUS`（首个输出 bus）、`PNDS_AUDIO_OUTPUT_CHANNELS`（离散输出数）。
- health ready 前创建项目 group（`GROUP_ID = 1000`）；所有动态 synth 放在 group 内。
- 不使用 App 保留的 node ID 范围 `2147480000..=2147483647`（本工程 node id = `1000 + clientId`）。
- 退出时释放全部资源（Socket.IO、OSC socket、HTTP server）——见 `lib/lifecycle.js`。
- 每个 voice 的 `out` 指向 `PNDS_AUDIO_OUTPUT_BUS + channel - 1`。

## 外部 OSC 协议（作品自定义，非平台标准）

```
/c<id>/amp  [float 0..1]
/c<id>/freq [float, range defined in public/shared.js freqRange]
/c<id>/out  [float 1..16]
```

`supercollider/debug/template-debug.scd` 是创作期 bridge，App 不启动、不打包。

## 决策记录

- 每客户端一个**单声道** voice；上限 = `audio.outputChannels`（16）。
- 声道可重叠，冲突由创作者自行管理（本工程不阻止）。
- AMP 推子映射 audio taper 曲线（`value²`），在 server 端完成（`audio/controller.js` 的 `mapAmp`）。
- 平滑（`Lag.kr`：amp 50ms / freq 100ms）在 SynthDef 内实现，通过 `lagAmp` / `lagFreq` control 暴露，创作者可调。
- 每 voice -6 dB 上限在 SynthDef 内实现（`amp * 0.5`），推子全范围可用。
- 超过上限的新客户端**拒绝加入**（`PlayerRegistry`，含 reason）。
- 断开连接立即释放 voice 与 id；重连凭 localStorage 中的 claim token 恢复 id 与最后状态（`lastControls` 按 token 键控）。
- QR 码由 `lib/qr.js` 生成（`qrcode` npm 包，`GET /qr` 挂在 monitor server），monitor 页面 `<img src="/qr">` 显示。
- 本工程**不预装 node_modules**（`.gitignore` 排除）；首次使用按 creator-guide 执行 `npm install`。发布包必须预装。
- p5 是本工程沿用的默认视觉方案（继承自模板），不是平台组件。
- **`lib/diagnostics.js` 是"lib/ 不含作品逻辑"的例外**：本工程的作品即网络诊断，指标与状态机是作品核心；保留在 lib/ 是因为它是纯函数模块（无 IO），与 `health.js` / `players.js` 一样可独立单测。阈值（100/50/25/10 ms、5%、3 次）与规则优先级都在此文件，改作品行为改这里。
- **Monitor 端移除了模板遗留的"声道分配"下拉 UI**（#3 起）：监视端只做诊断（Overall + 卡片 + Start/Stop）。`set-out` 事件与 server 端处理保留（模板核心，performer 推子控制仍走 `control`）。
- **探针只发给已 join 的 performer**；monitor 页面（不 join）不参与探测——spec 的测试范围是"Server ↔ Wi-Fi 连接的移动客户端"，monitor 运行在操作主机上。
- **1–2 次连续 timeout 判 Yellow**：spec 只规定"连续 3 次 → Red"，未规定 1–2 次；为避免"正在超时的客户端显示 Green 并累计 hysteresis 恢复计数"，补为 Yellow（"Recent probe timeouts"）。
- **Disconnected → Red 规则已实现于纯函数并单测**（`decideStatus` 最高优先级）；生产接线（断开后保留红色卡片、事件日志）随断开/事件日志 issue（#6）落地，当前断开即移除卡片。
- **卡片展示 p50/p95/jitter**；spec 中"最近一次事件"、丢包率等详细数据随详情面板 issue（#8）与事件日志 issue（#6）补充。

## 验证命令

```sh
npm run check   # 全部 JS 语法检查
npm test        # node --test（config / audio 契约 / players / diagnostics / E2E）
npm run build:synthdef   # 重新编译 SynthDef
```

# Local Network Diagnostics — Creator Guide（创作者开始指南）

这是一个**纯网络测试**的 PNDS 工程：**无音频、无 SuperCollider**，server 恒以 `none` 模式（音频禁用）运行。功能按 GitHub issues（自 #2 起）逐步落地，本指南随之更新。

## 快速开始

### 1. 安装依赖

PNDS App **不执行 npm install**，所以工程必须自带可用的 `node_modules/`。首次使用：

```sh
npm install
```

依赖只有三个：`express`、`socket.io`、`qrcode`。

### 2. 运行

脱离 App 单独调试：

```sh
npm start    # 不需要任何音频参数；恒为无音频模式
```

在 PNDS App 中运行：App 中点击 **Open**，选择本文件夹。App 会按 `manifest.json` 的 `audio.defaultMode: "none"` 启动 server（`--audio-mode none` 被接受但忽略）。

### 3. 两个页面

| 页面 | 地址 | 用途 |
|---|---|---|
| Performer | `http://<Host-LAN-IP>:6868/` | 手机客户端：自动加入并应答探针，只显示 "Connected, testing…" |
| Monitor | `http://<Host-LAN-IP>:6869/` | 监视端：居中显示的网络诊断控制台（打开即自动开始测试；Overall、卡片网格、详情弹窗） |

默认端口来自 `manifest.json` 的 `scoreServer.performerPort` / `monitorPort`——这是**唯一来源**。`public/shared.js` 和浏览器都会自动读取，不需要手动同步。

## 网络诊断功能（issues #3–#8）

本工程的作品语义是**网络诊断**，Monitor 页面即为诊断控制台：

- **自动开始**：打开 Monitor 页面即自动开始测试（页面连接后发送 `diagStart`；server 对重复 start 幂等）。只有未 join 的 socket（即 monitor 页面本身）能启停测试，joined performer 不能；`diagStart`/`diagStop` 事件保留，供调试与测试使用。
- **探针回路**：测试运行期间，server 向每个已 join 的 performer 发送 `pnds:diag:probe`；performer 页面收到后立即回 `pnds:diag:ack`（附带 `performance.now()` 收发时间戳）。RTT 由 server 端计算；monitor 页面不参与探测。**双阶段循环**：`[2 s burst @ 30 msg/s，超时 200 ms] → [2 s calm @ 1 Hz，超时 500 ms]` 持续交替，模拟高密度作品负载；同一客户端可同时有多个 in-flight 探针（per-seq 追踪）。
- **指标**（server 端，`lib/diagnostics.js` 纯逻辑）：RTT p50/p95（滑动窗口 10 个样本）、jitter = 窗口内相邻 RTT 差的 p95、timeout 总数与连续 timeout 数、**丢包率**（timeouts / (acks + timeouts)，仅详情面板）、**burst 窗口超时率**（每个 burst 窗口结束时冻结，喂给状态机）、客户端处理时间（t1−t0，仅详情面板）。
- **状态机**（优先级从高到低）：Disconnected → Red（立即，跳过 warming up）；连续 3 次 timeout → Red；burst 超时率 > 5% → Red；jitter p95 > 25 ms → Yellow；RTT p95 > 100 ms → Yellow；**1–2 次连续 timeout → Yellow**（spec 缺口补齐：正在超时的客户端不得显示 Green，也不能累计恢复计数）；其余满足 Green 条件（jitter < 10 ms 且 RTT p95 < 50 ms）→ Green；介于两者之间 → Yellow。
- **Gray / 迟加入**：新加入（或重连）客户端先进入 Gray（warming up，约 2 个探针周期），不参与 Overall；测试中途加入的客户端自动被纳入探测。
- **Hysteresis**：从 Red/Yellow 恢复到 Green 需要连续 10 个良好周期；任一坏周期重置计数；恶化立即生效。
- **Overall**：所有**在线**且非 Gray 客户端中最差状态（Red > Yellow > Green）。断开（离线）客户端不参与 Overall，但其红色卡片保留可见。
- **断开与事件日志**：客户端断开时卡片**保留并立即转 Red**；每个客户端记录事件（Connected / Disconnected / Reconnected，带时间戳，最多 20 条）；重连凭 claim token 恢复原 id，重新经过 Gray warming up 回到 Green。卡片与详情弹窗展示最近事件（如 "Disconnected 5s ago"）。
- **Monitor 展示**（参照 Multichannel Signal Generator 的居中浅色卡片设计，纯 DOM，无 p5）：居中 Overall 横幅 + 每客户端一张卡片（状态色、状态文案、原因、Typical Response = RTT p50、Worst-case Response = RTT p95、Stability (Timing Variation) = jitter、最近事件）。**点击卡片打开详情弹窗**：p95、丢包率、处理耗时、完整事件日志（这些指标不参与状态判定）。Red 卡片文案固定为 **"Not suitable for performance"**。页面底部有 performer 页面 QR 码。无 Start/Stop 按钮（打开即自动测试），不显示 Burst/Calm 阶段。
- **Performer 页面**：手机端极简视图——自动加入（凭 localStorage 中的 claim token 恢复身份）、自动应答探针，只显示 **"Connected, testing…"**。
- **状态文案单一来源**：`public/shared.js` 的 `statusCopy`（Gray/Green/Yellow/Red 四档），server 的 reason 与 monitor 的卡片/横幅都从它读取。

## 目录结构

```
manifest.json             PNDS 工程契约（App 只认它和 server 入口；audio 仅声明 none）
server.js                 作品主 server：编排协议（通常不用改）
lib/                      可复用核心，任何 PNDS 工程通用（template 骨架，通常不用改）
  config.js               manifest / CLI / 端口解析
  network.js              LAN IPv4 枚举
  health.js               /__pnds/health（无音频工程报告 audio.status "disabled"）
  players.js              客户端 id 分配与重连恢复（claim token）
  lifecycle.js            优雅关闭
  qr.js                   performer 页面 QR 码（GET /qr）
  diagnostics.js          网络诊断：指标 + 状态机 + 事件日志（纯逻辑，见"网络诊断功能"）
public/                   浏览器端（performer + monitor 双角色单页）
  index.html              双角色入口（按端口加载不同脚本；无 p5）
  shared.js               浏览器与 server 共用的常量：事件名 / 状态文案 / 诊断词汇表（单一事实来源，见下文）
  performer.js            手机端：自动加入 + 应答探针，显示"已连接，正在测速"（DOM）
  monitor.js              监视端：居中卡片控制台 + 详情弹窗（DOM）
  style.css               设计语言（浅色主题，参照 Multichannel Signal Generator）
test/                     node --test 回归测试
docs/                     本指南与交接文档
```

## 创作时改什么

| 想做什么 | 改哪里 |
|---|---|
| 换作品名 / 端口 | `manifest.json`（改端口只需改这里） |
| 改监视端 | `public/monitor.js`（DOM）+ `public/style.css` |
| 改 performer 端 | `public/performer.js`（DOM） |
| 改诊断阈值 / 规则 | `lib/diagnostics.js`（状态机、阈值、窗口） |
| 改状态文案（含 Red 文案） | `public/shared.js` 的 `statusCopy`（唯一一处） |
| 加 Socket.IO 事件 | `public/shared.js`（事件名）+ `server.js`（处理） |
| 改客户端上限 | `public/shared.js` 的 `maxClients` |

## 单一事实来源（Single Source of Truth）

`public/shared.js` 是浏览器页面与 Node server **共用同一份常量**的模块：

- 它用 UMD 包装：浏览器里挂到 `window.PNDS`（页面脚本里 `const P = window.PNDS` 取别名），Node 里走 `module.exports`（server 端 `require`）。
- **Socket.IO 事件名**（`events`）、**客户端上限**（`maxClients`）、**localStorage token 键名**（`tokenKey`）、**诊断状态文案**（`statusCopy`）、**诊断词汇表**（`diagPhases` / `diagEvents`）都在这里定义。
- **端口**的单一来源是 `manifest.json`（App 工程契约）。`shared.js` 在 Node 端自动从 manifest 读取，浏览器端由 server 动态注入——创作者只需改 manifest.json。
- 本工程的 `tokenKey` 与工程 id 一致（`local-network-diagnostics-token`）。若由此 fork 出新的工程，记得同步修改这个键，避免不同工程共用同一个 localStorage 键。

## 音频

本工程**无音频**：没有 `audio/`、没有 `supercollider/`，manifest 只声明 `audio.supportedModes: ["none"]`，server 不加载任何音频引擎。`--audio-mode` 参数仅为 App 兼容而接受、值被忽略。

## 健康检查

两个端口都提供：

```sh
curl http://127.0.0.1:6868/__pnds/health
```

PNDS App 以 JSON 中 `status === "ready"` 为显示条件。无音频工程按运行契约返回 `audio.status: "disabled"`、`audio.target: null`。

## test/ 文件夹

`test/` 是给 AI 编程助手用的回归测试。创作者不需要手动运行，也不需要理解它们。当你通过 AI 修改工程时，AI 会用它来验证改动没有破坏已有功能（如客户端加入、重连恢复、诊断状态机、burst 循环、E2E 探测等）。

## 发布

带生产依赖的发布包由 `.github/workflows/package.yml` 构建（ALLOWLIST 裁剪，`node_modules` 预装）。详见 `docs/handoff.md`。

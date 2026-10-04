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

| 页面      | 地址                         | 用途                                                                     |
| --------- | ---------------------------- | ------------------------------------------------------------------------ |
| Performer | `http://<Host-LAN-IP>:6868/` | 手机客户端：自动加入并应答探针，显示设备编号、连接状态与网络结论         |
| Monitor   | `http://<Host-LAN-IP>:6869/` | 监视端：仪器面板（打开即自动开始测试；整体网络结论、设备读数、详情窗口） |

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
- **Monitor 展示**（v0.6.1 仪器面板）：与 Multichannel Gen 共用字体、灰绿表面和克制的分隔线。顶部呈现 server 的整体结论、在线数及就绪 / 需要关注 / 预热统计（离线记录不参与）；卡片突出设备编号、典型 RTT（p50）、最差 RTT（p95）、时间抖动（p95）和最近事件。点击卡片打开原生详情窗口，查看丢包率、客户端处理时间和完整事件日志（最多 20 条，最新在前）。卡片随实时快照原位更新，键盘焦点保留；关闭详情返回原卡片。底部展开「设备加入」二维码，手机自动加入。宽屏三列、中屏两列、窄屏单列，窄屏统计移至结论下方。
- **Performer 页面**：手机端极简视图——自动加入（凭 localStorage 中的 claim token 恢复身份）、自动应答探针，只显示 **"Connected, testing…"**。
- **文案单一来源（双语）**：`public/shared.js` 的 `copy` 表（`en` / `zh-CN` 两套，含状态文案、原因文案、事件文案与 monitor 界面文案）。server 的 state 只携带语言中立的 reason key（`lib/diagnostics.js`），monitor 页按当前语言（`public/locale.js`）查表渲染；Red 卡片文案在两套语言里都固定显式（"Not suitable for performance" / "不适合现场演出"）。

## 主题跟随（App 集成）

在 PNDS App（≥ v1.2.3）中运行时，monitor 页通过跨域 `postMessage` 接收 App 推送的主题（score project spec §5.3：`pnds:theme` 消息，含最终颜色值 palette），幂等地写入页面 CSS 变量——App 打开 monitor、切换主题、窗口重获焦点时都会重推，页面始终与 App 一致（Pond / Sand / Stage / Brutal 全部四套）。加载时支持 `?theme=<name>` 查询参数作为首帧初值（App 目前不携带该参数，缺席时用工程自带的灰绿配色）。状态色（绿/黄/灰）没有 App 对应物，按调色板明暗推导两档，四套主题下均保持 ≥4.5:1 可读。Brutal 同步为方角硬阴影，减少动态效果设置会关闭过渡。performer 页不参与、恒用工程自带配色。实现见 `public/theme.js`。

## 语言跟随（App 集成）

在 PNDS App（≥ v1.3.0）中运行时，monitor 页同样通过跨域 `postMessage` 接收 App 推送的语言（网络参考文档 "Locale Following" 一节：`pnds:locale` v1 消息，负载为解析后的语言代码 `en` / `zh-CN`），页面按当前语言从 `shared.js` 的双语 `copy` 表渲染全部界面文案——App 打开 monitor、切换语言、窗口重获焦点时都会重推，monitor 即时整页重渲染。语义与主题桥一致：单向、尽力而为、最新值胜、幂等；未实现或不认识的消息静默忽略、页面不报错。加载时支持 `?lang=<code>` 查询参数作为首帧初值（App 在 monitor URL 上携带；缺席或未知时默认英文，行为与从前完全一致）。

- monitor 全部文案（横幅、卡片指标、详情弹窗、事件日志、时间表述、二维码说明）双语；`<html lang>` 随语言同步。
- **server 无语言**：state 广播里的 `reason` 是语言中立 key（如 `consecutiveTimeouts`），由 monitor 查当前语言的表得到展示文案。
- performer 页不参与（它开在演奏者手机浏览器里，不在 App 内，没有推送通道），恒为英文。
- 实现见 `public/locale.js`（桥与当前语言状态）；文案表见 `public/shared.js` 的 `copy`。

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
  shared.js               浏览器与 server 共用的常量：事件名 / 诊断词汇表 / 双语文案表 copy（单一事实来源，见下文）
  theme.js                主题跟随（仅 monitor 分支加载）：监听 App 的 pnds:theme 消息，写入 CSS 变量
  locale.js               语言跟随（仅 monitor 分支加载）：监听 App 的 pnds:locale 消息，维护当前语言并通知重渲染
  performer.js            手机端：自动加入 + 应答探针，设备编号与连接 / 测量状态（DOM）
  monitor.js              监视端：仪器面板 + 原生详情窗口（DOM）
  style.css               仪器面板语言（默认灰绿，Monitor 跟随 App 主题）
test/                     node --test 回归测试
docs/                     本指南与交接文档
```

## 创作时改什么

| 想做什么                  | 改哪里                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 换作品名 / 端口           | `manifest.json`（改端口只需改这里）                                                                                 |
| 改监视端                  | `public/monitor.js`（DOM）+ `public/style.css`                                                                      |
| 改主题跟随                | `public/theme.js`（palette → CSS 变量映射、状态色推导、`?theme=` 初值）                                             |
| 改语言跟随 / 加新语言     | `public/locale.js`（支持的语言代码）+ `public/shared.js` 的 `copy` 表（两套语言同形状，`test/locale.test.js` 会拦） |
| 改 performer 端           | `public/performer.js`（DOM）                                                                                        |
| 改诊断阈值 / 规则         | `lib/diagnostics.js`（状态机、阈值、窗口）                                                                          |
| 改界面文案（含 Red 文案） | `public/shared.js` 的 `copy` 双语表（en / zh-CN 各一处，含 Red 文案；server 端 reason 只用 key）                    |
| 加 Socket.IO 事件         | `public/shared.js`（事件名）+ `server.js`（处理）                                                                   |
| 改客户端上限              | `public/shared.js` 的 `maxClients`                                                                                  |

## 单一事实来源（Single Source of Truth）

`public/shared.js` 是浏览器页面与 Node server **共用同一份常量**的模块：

- 它用 UMD 包装：浏览器里挂到 `window.PNDS`（页面脚本里 `const P = window.PNDS` 取别名），Node 里走 `module.exports`（server 端 `require`）。
- **Socket.IO 事件名**（`events`）、**客户端上限**（`maxClients`）、**localStorage token 键名**（`tokenKey`）、**双语文案表**（`copy`：状态 / 原因 / 事件 / monitor 界面文案，en 与 zh-CN 同形状）、**诊断词汇表**（`diagPhases` / `diagEvents`）都在这里定义。
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

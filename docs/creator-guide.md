# PNDS Template — Creator Guide（创作者开始指南）

这是一个可直接运行的 PNDS 数字乐谱工程骨架，带最小功能实现，适合作为新作品的起点。

## 快速开始

### 1. 安装依赖

PNDS App **不执行 npm install**，所以工程必须自带可用的 `node_modules/`。首次使用本模板：

```sh
npm install
```

依赖只有四个：`express`、`socket.io`、`osc-min`、`qrcode`。

### 2. 运行

脱离 App 单独调试：

```sh
npm run dev:none    # 无音频模式（只测试页面与网络）
npm run dev         # Internal 模式（需本机 scsynth 在 57110 端口）
```

在 PNDS App 中运行：App 中点击 **Open**，选择本文件夹，音频模式选 **Internal Synth**。

### 3. 两个页面

| 页面 | 地址 | 用途 |
|---|---|---|
| Performer | `http://<Host-LAN-IP>:6868/` | 演奏者触摸界面（手机横屏） |
| Monitor | `http://<Host-LAN-IP>:6869/` | 监视端：客户端列表与声道分配 |

默认端口来自 `manifest.json` 的 `scoreServer.performerPort` / `monitorPort`——这是**唯一来源**。`public/shared.js` 和浏览器都会自动读取，不需要手动同步。

## 作品规格（本模板实现的功能）

- 演奏者界面：**手机横屏**触摸；竖屏时提示旋转。左半屏是 **AMP 推子**，右半屏是 **FREQ 推子**。
- 推子值经 Socket.IO 发到 score server，由 server 转为 OSC 控制 SuperCollider。
- 每个加入的客户端获得一个 sine voice（一个 `templateSine` synth）。
- FREQ 推子映射频率在 `public/shared.js` 的 `freqRange` 定义（**单一事实来源**）：performer 页面用它显示 Hz，server 的 `audio/controller.js` 从同一对象读取并映射为 OSC 频率，改一处两边同步。
- AMP 推子使用 **audio taper 曲线**（`value²`）：推子下半段控制更细腻。
- 推子值在 scsynth 端做 **平滑**（`Lag.kr`，amp 50ms / freq 100ms），推子移动是滑动的，不产生突变/zipper noise。
- **每个 voice 输出上限 -6 dB**（在 SynthDef 内 `amp * 0.5` 实现）。
- 客户端上限 16 个；满员时新客户端被拒绝。
- 默认声道：**奇数 id → 声道 1，偶数 id → 声道 2**（相对 `PNDS_AUDIO_OUTPUT_BUS`）。
- Monitor 端可把任意客户端的输出声道改为 1–16；允许重叠。Monitor 页下方显示 **performer 页面的 QR 码**（`GET /qr`，由 `lib/qr.js` 生成）。
- 客户端断开后，重连（同一浏览器，token 保存在 localStorage）会**恢复原 id 与最后推子状态**。

## 目录结构

```
manifest.json             PNDS 工程契约（App 只认它和 server 入口）
server.js                 作品主 server：编排协议（通常不用改）
lib/                      可复用核心，任何 PNDS 工程通用（template 骨架，通常不用改）
  config.js               manifest / CLI / 端口 / 环境变量解析
  network.js              LAN IPv4 枚举
  health.js               /__pnds/health
  osc-transport.js        UDP OSC 传输（osc-min + dgram）
  audio-engine.js         scsynth 会话生命周期（bus / group / synthdef 加载）
  players.js              客户端 id 分配与重连恢复（claim token）
  lifecycle.js            优雅关闭
  qr.js                   performer 页面 QR 码（GET /qr）
audio/                    作品音频语义层：推子 → synth 参数的映射（创作时改这里）
  controller.js           每客户端一个 voice，声道分配，外部 OSC 协议
public/                   浏览器端（performer + monitor 双角色单页）
  index.html              双角色入口（按端口加载不同脚本）
  shared.js               浏览器与 server 共用的常量：事件名 / 频率范围（单一事实来源，见下文）
  performer.js            演奏者横屏推子界面（p5）
  monitor.js              监视端：列表 + 声道分配
  style.css
  libraries/p5.min.js     p5 库（本地文件，演出离线可用）
supercollider/
  source/                 SynthDef 创作源码（.scd）
    template-sine.scd     本模板的 sine voice 定义
    build-synthdef.scd    编译脚本：.scd → .scsyndef
  debug/                  External debug bridge（创作期工具）
  synthdefs/              已编译 .scsyndef（运行时 artifact，manifest 引用）
test/                     node --test 回归测试
docs/                     本指南与交接文档
```

## 创作时改什么

| 想做什么 | 改哪里 |
|---|---|
| 换作品名 / 端口 / 声道数 | `manifest.json`（改端口只需改这里） |
| 改推子 → 声音的映射 | `audio/controller.js` |
| 改声音本身（波形、效果） | `supercollider/source/template-sine.scd`，然后重新编译 |
| 改演奏者界面 | `public/performer.js`（p5） |
| 改监视端 | `public/monitor.js` |
| 加 Socket.IO 事件 | `public/shared.js`（事件名）+ `server.js`（处理） |
| 改推子频率范围 | `public/shared.js` 的 `freqRange`（页面显示与 server 发声自动同步，无需改 `audio/controller.js`） |
| 改客户端上限 | `manifest.json` 的 `audio.outputChannels`（id 上限 = 输出声道数） |

## 单一事实来源（Single Source of Truth）

`public/shared.js` 是浏览器页面与 Node server **共用同一份常量**的模块：

- 它用 UMD 包装：浏览器里挂到 `window.PNDS`（页面脚本里 `const P = window.PNDS` 取别名），Node 里走 `module.exports`（server 端 `require`）。
- **Socket.IO 事件名**（`events`）、**频率范围**（`freqRange`）、**客户端上限**（`maxClients`）、**localStorage token 键名**（`tokenKey`）都在这里定义。
- **端口**的单一来源是 `manifest.json`（App 工程契约）。`shared.js` 在 Node 端自动从 manifest 读取，浏览器端由 server 动态注入——创作者只需改 manifest.json。
- 修改频率范围只需改 `freqRange.min / max` 一处：performer 页面的 Hz 显示与 server 端 `audio/controller.js` 的 `mapFreq()`（`FREQ_MIN/FREQ_MAX` 从 shared 读取）自动同步。
- 基于模板创建新作品时，建议修改 `tokenKey` 为与作品 id 一致的名称（如 `”my-work-token”`），避免不同工程共用同一个 localStorage 键。

## 声音：编辑与编译 SynthDef

`.scd` 是创作期源码，`.scsyndef` 是运行时 artifact。改完 `.scd` 后必须重新编译，否则 App 加载的是旧声音：

```sh
npm run build:synthdef
# 等价于: sclang supercollider/source/build-synthdef.scd
```

编译产物写入 `supercollider/synthdefs/template-sine.scsyndef`。

## 音频模式

| 模式 | 说明 |
|---|---|
| `internal` | App 托管 scsynth，加载编译好的 `.scsyndef`（演出模式） |
| `external` | 向自定义 OSC target 发送作品协议（`/c<id>/amp`、`/c<id>/freq`、`/c<id>/out`） |
| `none` | 不建立音频输出（只测试页面与网络） |

External 模式调试：在 SuperCollider IDE 中先运行 `supercollider/source/template-sine.scd`，再运行 `supercollider/debug/template-debug.scd`，然后：

```sh
node server.js --audio-mode external --osc-target 127.0.0.1:57120
```

## 健康检查

两个端口都提供：

```sh
curl http://127.0.0.1:6868/__pnds/health
```

PNDS App 以 JSON 中 `status === "ready"` 为显示条件。

## test/ 文件夹

`test/` 是给 AI 编程助手用的回归测试。创作者不需要手动运行，也不需要理解它们。当你通过 AI 修改工程时，AI 会用它来验证改动没有破坏已有功能（如客户端加入、推子映射、重连恢复等）。

## 发布

带生产依赖的发布包由 `.github/workflows/package.yml` 构建（ALLOWLIST 裁剪，`node_modules` 预装）。详见 `docs/handoff.md`。

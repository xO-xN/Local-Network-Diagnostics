# PNDS Template — Handoff（开发交接笔记）

面向继续开发此模板的开发者与 AI 代理：记录结构约定、边界与已知决策。

## 分层约定

- `lib/` 是可复用核心，**不得包含作品特定逻辑**。改动它意味着所有基于模板的工程都受影响。
- `audio/controller.js` 是作品语义层：id → voice、声道分配、external OSC 协议。
- `server.js` 只做编排（协议挂载、广播、生命周期），不含业务算法。
- `public/shared.js` 是浏览器与 server 的**单一事实来源**（事件名、频率范围、常量），必须保持 UMD 形态（浏览器全局 `window.PNDS` + Node `module.exports`）。

## 端口约定

端口只在 `manifest.json` 定义（`scoreServer.performerPort` / `monitorPort`）。`shared.js` 在 Node 端从 manifest 读取，浏览器端通过 server 注入的 `__config.js` 获取。创作者改端口只需改 manifest.json，无需手动同步任何文件。

## PNDS 契约要点（必须遵守）

- `scoreServer.entry` 指向 `server.js`，路径必须在工程根内；禁止绝对路径与 `../`。
- Internal 模式只加载 `supercollider/synthdefs/*.scsyndef`（编译产物），`.scd` 只是创作期文件。
- 读取 `PNDS_AUDIO_OUTPUT_BUS`（首个输出 bus）、`PNDS_AUDIO_OUTPUT_CHANNELS`（离散输出数）。
- health ready 前创建项目 group（`GROUP_ID = 1000`）；所有动态 synth 放在 group 内。
- 不使用 App 保留的 node ID 范围 `2147480000..=2147483647`（本模板 node id = `1000 + clientId`）。
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
- 声道可重叠，冲突由创作者自行管理（模板不阻止）。
- AMP 推子映射 audio taper 曲线（`value²`），在 server 端完成（`audio/controller.js` 的 `mapAmp`）。
- 平滑（`Lag.kr`：amp 50ms / freq 100ms）在 SynthDef 内实现，通过 `lagAmp` / `lagFreq` control 暴露，创作者可调。
- 每 voice -6 dB 上限在 SynthDef 内实现（`amp * 0.5`），推子全范围可用。
- 超过上限的新客户端**拒绝加入**（`PlayerRegistry`，含 reason）。
- 断开连接立即释放 voice 与 id；重连凭 localStorage 中的 claim token 恢复 id 与最后状态（`lastControls` 按 token 键控）。
- QR 码由 `lib/qr.js` 生成（`qrcode` npm 包，`GET /qr` 挂在 monitor server），monitor 页面 `<img src="/qr">` 显示。
- 本模板**不预装 node_modules**（`.gitignore` 排除）；首次使用按 creator-guide 执行 `npm install`。发布包必须预装。
- p5 是模板的默认视觉方案，不是平台组件。

## 验证命令

```sh
npm run check   # 全部 JS 语法检查
npm test        # node --test（config / audio 契约 / players）
npm run build:synthdef   # 重新编译 SynthDef
```

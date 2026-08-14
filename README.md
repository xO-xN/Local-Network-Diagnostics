# Local Network Diagnostics

[English](#english) | [中文](#中文)

---

## English

A PNDS score project that continuously diagnoses the local Wi-Fi network between the score server and its performer clients, and tells you — in plain language — whether the network is fit for a live performance. Network-only: no audio, no SuperCollider; the server always runs with audio disabled (`none` mode). Stack: Node.js, Express, Socket.IO.

### Features

- **Automatic test**: opening the monitor page starts the test immediately — no button to press
- **Baseline probing**: 1 Hz probes to every connected client measure typical responsiveness
- **Burst probing**: 2-second bursts at 30 msg/s alternating with calm periods simulate high-density works
- **Status system**: per-client Green/Yellow/Red status (Gray while warming up) with descriptive copy — no number-crunching required
- **Overall banner**: the worst status among online clients, shown prominently at the top of the monitor
- **Disconnect handling**: instant Red on disconnect, with an event log and reconnect recovery
- **Details panel**: worst-case response (RTT p95), loss rate and client processing time
- **Minimal performer page**: mobile clients just show "Connected, testing…" while answering probes automatically

### Getting Started

```sh
npm install
npm start    # http://<Host-LAN-IP>:6868/ performer · :6869/ monitor
```

Full documentation: [`docs/creator-guide.md`](docs/creator-guide.md) (creator guide) and
[`docs/handoff.md`](docs/handoff.md) (developer handoff notes).

### Structure

```
lib/            Reusable core (shared across all PNDS projects)
public/         Browser side (performer + monitor dual-role single page)
test/           Regression tests
docs/           Creator guide and handoff notes
```

### License

MIT — see [LICENSE](LICENSE).

---

## 中文

一个 PNDS 数字乐谱工程：持续诊断 score server 与演奏者客户端之间的本地 Wi-Fi 网络，并用直白的方式告诉你当前网络是否适合现场演出。纯网络工具：无音频、无 SuperCollider，server 恒以 none 模式（音频禁用）运行。技术栈：Node.js, Express, Socket.IO。

### 功能

- **自动测试**：打开 monitor 页即自动开始测试，无需按钮
- **基线探测**：以 1 Hz 向每个已连接客户端发送 probe，测量常态响应
- **突发探测**：2 秒 30 msg/s 突发与平静期交替，模拟高密度作品
- **状态系统**：每客户端绿/黄/红状态（加入初期为 Gray warming-up），配文字说明，无需解读数字
- **Overall 横幅**：页面顶部显著显示所有在线客户端中最差的状态
- **断线处理**：断开立即 Red，事件日志记录，重连后恢复
- **详情面板**：最差响应（RTT p95）、丢包率、客户端处理耗时
- **极简 performer 页**：手机客户端只显示 "Connected, testing…"，自动应答探针

### 开始

```sh
npm install
npm start    # http://<Host-LAN-IP>:6868/ performer · :6869/ monitor
```

完整说明见 [`docs/creator-guide.md`](docs/creator-guide.md)（创作指南）与
[`docs/handoff.md`](docs/handoff.md)（开发交接笔记）。

### 结构

```
lib/            可复用核心（PNDS 工程通用）
public/         浏览器端（performer + monitor 双角色单页）
test/           回归测试
docs/           指南与交接文档
```

### 许可证

MIT — 详见 [LICENSE](LICENSE)。

# Unified Host entry / 统一池主演奏入口

## English

Version 0.7.2 implements PNDS browser participation protocol 1 and runtime ports
protocol 1. Open the Host's full public LAN URL from its bottom network control,
then explicitly enter the displayed Local Network Diagnostics performance. The
page's local scripts, queried resources and Socket.IO polling/WebSocket use the
same immutable confirmed prefix; no hardcoded internal port is used by a device.
The server explicitly labels performer and monitor responses. Inherited App
listeners, startup reports and health share the actual assigned ports/run ID;
standalone use keeps the manifest's preferred ports.

The performer reports page preparation after the real service accepts its join.
This says nothing about a successful network diagnosis: the monitor still starts
and observes the real baseline/burst probe loop, acknowledgments, loss, warming
up and reconnections. LAN-only measurements need no WAN access after local
resources and exact shared libraries are prepared. This release introduces no
Worker or remote runtime dependency.

Public browser claims are scoped to the stable Host and project, not a grant or
performance. Native private origins retain recovery from an older local claim;
public shared origins never import that legacy unscoped key. Re-entry into a new
performance still requires confirmation. Stop/replacement retires old network
access at the Host while the existing page can remain visible. HTTPS and native
private-source behavior are retained; a saved icon does not grant extra browser
permissions. Different browser origins or saved-app instances do not promise
claim migration.

The source tests exercise actual inherited descriptors, health/report identity,
HTTP roles, real Socket.IO polling/WebSocket measurements and the served
performer's admission/preparation and storage API. App install/public-entry
checks and physical-device diagnosis are separate acceptance boundaries. A local
candidate package is not a published release and must not change the App's remote
pin until its exact release artifact is actually obtainable.

## 中文

0.7.2 适配 PNDS 浏览器接入协议 1 与运行端口协议 1。使用池主底栏网络区显示的
完整 LAN 网址，并明确进入所显示的 Local Network Diagnostics 演出。页面本地
脚本、带查询资源以及 Socket.IO polling／WebSocket 都保留同一已确认 URL 前缀，
设备不再硬编码内部端口。服务端明确标记演奏端和监视端；App 交接的实际监听器、
原子启动报告与 health 使用相同的实际端口和运行身份。独立运行保留 manifest 首选端口。

演奏端只有在真实服务接纳加入后才报告页面准备完成，这不等于真实网络诊断已经成功。
监视端继续启动并观察原有基线／突发探针、应答、丢包、预热和断线重连。所需本地
资源及确切共享库准备好后，局域网测量不需要 WAN；本版没有新增 Worker 或远端依赖。

公开浏览器凭据按稳定池主／工程区分，不绑定当次演出或授权。原生私有来源可恢复
旧本地凭据；公开共享来源不会导入旧的无命名空间键。每次新演出仍需明确进入。
Stop／换演出由池主撤销旧网络接纳，旧页面可保留显示。既有 HTTPS 和原生私有来源
行为保留；保存图标不会授予额外浏览器权限。跨地址、浏览器或图标实例不承诺迁移凭据。

源码测试覆盖真实继承 descriptor、health／报告身份、HTTP 角色、真实 polling／
WebSocket 探针测量以及实际演奏端脚本的接纳、准备和存储接口。App 安装／公开入口
验证及实体设备诊断是独立验收。本地候选包不等于已发布；确切远端发行物可获取前，
不得改写 App 的远端固定来源。

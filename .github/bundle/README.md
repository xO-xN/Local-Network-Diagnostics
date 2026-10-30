# Local Network Diagnostics

[中文](README.zh-CN.md) | **English**

A PNDS utility that checks a local Wi-Fi network before a performance: it continuously measures round-trip time, jitter and loss between this Mac and every connected phone or tablet, and tells you — in plain language — whether the network is fit for a live show. Network-only: no audio, no SuperCollider; the project always runs with audio disabled (`none` mode).

## How to use

1. In the PNDS App, press **⌘O** (Open) and select this `.pnds` bundle or its
   unzipped folder, then **Load** it. Don't have the App yet? Download it from
   https://github.com/xO-xN/PNDS-App/releases/latest (macOS) — no Node.js
   installation is required, the App bundles everything this tool needs.
2. Put the Mac and the performer devices (phones / tablets) on the same local
   network.
3. Click the App performer QR button and scan the code on
   each device. Devices join and answer measurement probes automatically —
   keep their pages open.
4. The monitor starts testing the moment it opens: the overall verdict on top
   (the worst status among online devices), per-device cards with typical and
   worst-case round-trip time, timing variation and recent events. Select a
   device for its loss rate, processing time and the full event log.

Disconnected devices stay visible as red cards; the overall verdict covers
online devices. Testing is automatic — there are no start/stop buttons. The
device page stays English; the monitor follows the App language and theme.


Runtime requirements: PNDS App v1.6.2 or a Host supporting the exact shared libraries in manifest.json. The project bundle carries references and project assets; standalone development can still use npm ci. See docs/shared-libraries.md in the source repository.

## App performer QR migration

This version removes the project QR interface and `/qr` endpoint. In PNDS App with built-in performer QR, use the bottom bar in performance mode or the Performers button in creation mode to open this project’s performer page. Standalone browsers and older Apps retain the project pages without an in-page QR entry.

# DSH Desktop Linux / 信创（麒麟、统信 UOS）移植方案

> 基于 2025-09 对本仓库（dsh-desktop 0.1.1，Electron 43.4.0 / electron-builder 26.15.3 / 内嵌 Node 24.9.0）的逐文件审计。
> 结论先行：**x86_64 / aarch64 的 Linux 版（覆盖麒麟 V10、UOS 通用版）属于低-中难度改造；loongarch64（新龙芯）受制于 Electron 官方不发布 loong64 构建，需单独立项评估；mips64el（老龙芯 3A4000 及以前）建议明确不支持。**

---

## 一、架构现状分析（为什么大部分代码天然可移植）

### 1.1 Harness 启动机制（移植核心，Linux 路径已存在）

- Harness 不是跑在 Electron 里，而是由**独立内嵌 Node 二进制**启动的子进程（HTTP 服务在 `127.0.0.1:<port>`），渲染层只是 WebView 客户端：
  - `src/main/index.ts:575-578` `bundledNodePath()` → `node_modules/node/bin/node`（npm `node@24.9.0` 包，npm install 时从 nodejs.org 下载当前平台二进制，随 `files: node_modules/**/*` 进包）。
  - `src/main/index.ts:603` 打包后入口 `process.resourcesPath/harness-node-entry.mjs`（`build/harness-node-entry.mjs` 本身跨平台通用，注释已写明 "Bundled-Node hosts (Windows, Linux) skip it"）。
  - `src/main/index.ts:2699-2703`：**macOS 走 `utilityProcess.fork()`（disclaim TCC），Windows/Linux 走普通 `spawn(node)`** —— Linux 直接复用 Windows 分支即可。
- 启动参数、端口预留、就绪探测、日志（`src/main/runtime/harness-runtime.ts`）全部平台无关；仅环境捕获分平台（见 1.3）。

### 1.2 全部平台分支清单（`src/` 共约 60 处，Linux 需要动的不多）

| 文件:行 | 现状 | Linux 处理 |
|---|---|---|
| `desktop-service/service.ts:19-24` | `desktopPlatform()` 只认 mac/mac-intel/windows，**其余直接 throw**，导致崩溃遥测/更新策略整体失效 | **必改**：增加 `linux-x64/linux-arm64/linux-loong64` 映射 |
| `update/update-policy.ts:7` | `supportsAutoUpdates = isPackaged && (darwin\|\|win32)` | **必改**：按 Linux 包格式分支（见第四节） |
| `index.ts:901,917-957` | 窗口 chrome：win32 `titleBarOverlay`、darwin 隐藏标题栏+窗口按钮 API | Linux 落在"非 darwin 非 win32"分支 = 原生边框，基本免改；如需自绘标题栏另评 |
| `index.ts:2675` | `app.dock?.setIcon` 仅 darwin | Linux 走 `.desktop` 文件 + hicolor 图标，无需代码 |
| `index.ts:901` | 托盘仅 Windows 创建 | Linux 可选择不创建（推荐先不做），或做 AppIndicator 实测 |
| `close-to-tray.ts:5` | 关窗驻留仅 Windows | Linux 关闭即退出（符合惯例），行为已正确 |
| `launchd-guard.ts:11` | `XPC_SERVICE_NAME` 判断 launchd 守护启动 | 用 `INVOCATION_ID`（systemd 用户服务）等价实现，低难度 |
| `state/launch-agent-audit.ts`、`state/plugin-component-cleanup.ts:439-447,845,911`、`state/launchctl-service-state.ts` | `/bin/launchctl bootout/print/bootstrap/disable` 审计/隔离 LaunchAgent | **一期空实现**（现有 darwin 短路模式即安全默认）；二期换 systemd 用户单元（`systemctl --user stop/disable/mask`） |
| `gpu-fallback.ts:91` | 渲染进程崩溃降级仅 win32 | 不移植，Linux 走普通 reload，行为已正确 |
| `window-navigation.ts:25-34`、`preload/index.ts:317`、`windows-menu-view.ts` | Windows 自绘标题栏参数/菜单 | 整条链路不移植（Linux 用原生标题栏） |
| `mobile/cloudflared-tunnel.ts:24-50` | `CLOUDFLARED_ASSETS` 已含 `linux-x64/linux-arm64`（GitHub 直链+sha256），**无 loong64 条目 → 抛 "Unsupported platform/architecture"** | loong64 上降级为功能禁用；x64/arm64 可用；代码已优先 PATH 探测，系统装了 cloudflared 即可用 |
| `mobile/pinggy-tunnel.ts` | 只依赖系统 `ssh`/`ssh-keygen`（麒麟/UOS 自带 openssh-client） | **零改动** |
| `runtime/profile-plugin-command.ts:112-138,266-279` | 非 win32 分支已写 `#!/bin/sh` shim + `chmod 755`；kill 走进程组 SIGTERM | **Linux 已覆盖，零改动** |
| `harness-runtime.ts:66-113` | win32 用 powershell 捕获环境；mac/Linux 用 `$SHELL -l -i -c env` | Linux 已覆盖；从 .desktop 启动时 SHELL 可能未设，建议回退改为读 `getent passwd` 登录 shell（小优化） |
| `harness-runtime.ts:408` | 启动超时 win32 120s / 其他 45s | 无需改（可按信创机器性能放宽） |
| `desktop-service` 其余、`security*.ts`、`safe-mode*.ts`、`src/shared/*` | 无平台分支 | 零改动（`shell.openExternal` 依赖 xdg-open，极简环境需实测） |

**原生模块与外部命令**：项目自身不加载任何 `.node`；harness vendor tgz 均为纯 JS。外部命令仅 `launchctl`（mac）、`powershell`/`taskkill`/`where`（win）、`which`/`ssh`/`tar`（Linux 可用）。无 osascript/defaults/reg/schtasks。

**依赖二进制盘点（Linux 关键）**：

| 组件 | linux-x64 | linux-arm64 | loong64 | 说明 |
|---|---|---|---|---|
| Electron 43.4.0 | ✅官方 | ✅官方 | ❌ **Loongnix 最高仅 v31.7.7-lsx** | 最大风险项 |
| npm `node@24.9.0`（内嵌 Harness 运行时） | ✅ | ✅ | ❌ 需 Loongnix/自编译 node | `verify-target.mjs` 也会拦 |
| `koffi` 3.1.5（override） | ✅ | ✅ | ✅ 已有 loong64 预编译 | 好消息 |
| `@vscode/ripgrep` 1.18.0 | ✅ | ✅ | ❌ | 需回退系统 `rg` 或 vendor 二进制 |
| `@esbuild/*`（仅构建链，不进包） | ✅ | ✅ | ✅ | 只影响构建机 |

### 1.3 更新与发布链路现状

- electron-builder 无 `linux` 段；target 仅 dmg/zip/nsis。
- 自动更新：electron-updater + generic feed `https://dshdesktop.com/updates/latest/`。generic provider 按平台取 `latest.yml`（win）/`latest-mac.yml`/`latest-linux.yml` —— **feed 上目前没有 latest-linux.yml**。
- `versions.json`（`scripts/build-version-index.mjs:53-66`）只编码版本号 + archive 目录 URL，**不编码 os/arch**：Linux 接入现有回滚体系只需在同目录补 `latest-linux.yml`，索引格式零改动。
- CI（`.github/workflows/release.yml`）：mac arm64/x64（签名公证）、win x64（UKey 签名）、publish（GitHub Release + ModelScope 镜像 + 飞书）。缺 Linux job。
- `scripts/verify-release-assets.mjs` 的 `REQUIRED_ASSETS`/文件头魔数校验（MZ/PK/koly）需补 deb（`!<arch>`）、rpm（`0xEDABEEDB`）、tar.gz、AppImage（ELF）分支。

---

## 二、总体策略（三阶段）

| 阶段 | 目标 | 覆盖 |
|---|---|---|
| **P1（1-2 周）** | Linux x64 + arm64 通跑：deb/rpm/tar.gz + CI + 更新元数据 | 麒麟 V10（x86_64、飞腾/鲲鹏 arm64）、UOS 通用版 |
| **P2（3-5 天）** | 信创落地适配：软件商店包、自启动/托盘实测、离线安装包集、GPG 签名 | 麒麟软件商店 / UOS 应用仓库上架 |
| **P3（单独立项，2-4 周起）** | loongarch64（新龙芯 3A5000/3C5000/3A6000） | 基于 Loongnix Electron ≤31 移植版做 PoC，**先验证 Electron 降级可行性再排期** |

明确不做：mips64el（老龙芯）、FreeBSD 系（如需可后续评估）。

---

## 三、P1 详细步骤：Linux x64/arm64 移植

### 步骤 1：解锁主进程平台分支（约半天）

1. `src/main/desktop-service/service.ts:19-24`：
   ```ts
   if (platform === 'linux' && arch === 'x64') return 'linux-x64'
   if (platform === 'linux' && arch === 'arm64') return 'linux-arm64'
   ```
   （`DesktopPlatform` 类型与遥测服务端 `/v1/updates/check` 同步扩枚举。）
2. `src/main/update/update-policy.ts:7`：`supportsAutoUpdates` 增加 linux 分支（见步骤 6）。
3. `src/main/launchd-guard.ts`：`isDaemonLaunch` 增加 `INVOCATION_ID in process.env`（systemd 用户服务启动）判断，避免服务实例与用户实例抢单例锁。
4. `src/main/state/launch-agent-audit.ts:272-275,343-346`：确认非 darwin 短路在 Linux 生效（现有代码即空结果，**一期不改**，二期补 systemd 版）。
5. `src/main/mobile/cloudflared-tunnel.ts:96-107`：把"无资产条目"从抛异常改为返回不可用（功能降级提示），x64/arm64 保留现有下载。

### 步骤 2：electron-builder 增加 linux 配置（半天）

`package.json` build 段新增：

```jsonc
"linux": {
  "icon": "build/icon.png",
  "category": "Development",
  "maintainer": "DataElement",
  "target": [
    { "target": "deb", "arch": ["x64", "arm64"] },
    { "target": "rpm", "arch": ["x64", "arm64"] },
    { "target": "tar.gz", "arch": ["x64", "arm64"] }
  ]
},
"deb": {
  "artifactName": "dsh-desktop-linux-${arch}.deb",
  "depends": ["libgtk-3-0", "libnss3", "libasound2", "libgbm1"]
},
"rpm": { "artifactName": "dsh-desktop-linux-${arch}.rpm" }
```

- 全局 `artifactName: dsh-desktop-${os}-${arch}.${ext}` 与 `${os}=linux` 组合天然成立，沿用现有命名习惯。
- `asar: false` + `files: node_modules/**/*` 会把 `node_modules/node/bin/node`（Linux 二进制）一并打进包 —— **正是 Harness 运行时，无需额外处理**。
- extraResources 中的 Windows 专用小文件（`windows-hidden-console.mjs` 等）Linux 带上无害，不必清理（如在意体积可按 arch 过滤）。
- **不推荐 AppImage 作为主通道**：国产 OS 上 FUSE 兼容性差；deb（主）+ rpm（麒麟服务器版）+ tar.gz（无 root 兜底）即可。

### 步骤 3：新增构建脚本（半天）

```jsonc
"package:linux:x64":   "node scripts/verify-target.mjs linux x64   && npm run build && electron-builder --linux deb rpm tar.gz --x64   --publish never",
"package:linux:arm64": "node scripts/verify-target.mjs linux arm64 && npm run build && electron-builder --linux deb rpm tar.gz --arm64 --publish never"
```

`scripts/verify-target.mjs` 已完全可复用（platform/arch 校验 + `node_modules/node/bin/node` 探针），零改动。

### 步骤 4：CI 矩阵（1 天，`.github/workflows/release.yml`）

1. 新增两个 job，结构抄 `windows-x64` 去掉签名：
   - `linux-x64`：`runs-on: ubuntu-24.04`
   - `linux-arm64`：`runs-on: ubuntu-24.04-arm`（GitHub 免费原生 arm runner，勿用 QEMU 交叉，electron-builder 打 deb/rpm 不建议交叉构建）
2. job 内容：`npm ci` → `npm test` → `npm run typecheck` → `npm run package:linux:x64|arm64` → 打包冒烟（见步骤 7）→ upload-artifact（deb/rpm/tar.gz/latest-linux.yml + sha256）。
3. `inputs.target.options` 加 `linux`，各 job `if` 同步；`publish` job 的 `needs`、`download-artifact` pattern、飞书通知清单加 linux。
4. 国内/离线构建环境统一加：
   ```
   ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
   NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node/
   ```
   （接管 `install-electron`、`node-bin-setup`、`@vscode/ripgrep` 三处下载。）
5. Linux 无签名步骤；如需仓库签名，仿 `sign-windows` 加 GPG detached-sign job（P2）。

### 步骤 5：更新元数据与发布校验（1 天）

1. `latest-linux.yml` 由 electron-builder 直接产出，无需仿 `finalize-windows-release.mjs`。
2. **per-arch feed**：x64 与 arm64 的 `latest-linux.yml` 若放同一目录会互相覆盖 —— 二选一：
   - feed 目录按 arch 分层 `updates/latest/linux-x64/`、`updates/latest/linux-arm64/`，`src/main/update/version-catalog.ts` 的 feedUrl 拼接平台/arch 后缀；
   - 或仿 `merge-mac-update-metadata.mjs` 写合并脚本（electron-updater 的 linux yml 支持 `files` 多条目 + path 区分 arch，需实测）。
3. `scripts/verify-release-assets.mjs`：`REQUIRED_ASSETS` 增加 `dsh-desktop-linux-x64.deb / -arm64.deb / .rpm / .tar.gz / latest-linux.yml`；`assetKind()` 与文件头校验加 deb（`!<arch>`）、rpm（`0xEDABEEDB`）、tar.gz（`1F 8B`）、AppImage（ELF `7F 45 4C 46`）分支与最小体积档位。
4. ModelScope 镜像是整目录 `upload_folder`，Linux 产物放同目录自动镜像，**零改动**；`latest-linux.yml` 要同时出现在 `releases/latest/` 与 `releases/archive/<ver>/`（backfill-archive.yml 同理）。

### 步骤 6：Linux 更新策略（1-2 天）

- **deb/rpm 安装**：electron-updater 不支持静默更新。改 `update-manager.ts`：检测到新版本时不走 `quitAndInstall`，而是提示 + `shell.openExternal` 跳转下载页/引导 `sudo apt install ./dsh-desktop-linux-x64.deb`；P2 接麒麟软件商店/UOS 仓库后改为"去商店更新"。
- **tar.gz**：可保留 electron-updater generic 流程或自实现覆盖更新（P2 决定）。
- UI 文案：`update-manager.ts:104-110,122-127` 的"仅在 macOS/Windows 构建中可用"分支同步更新。

### 步骤 7：Linux 冒烟测试（1 天）

仿 Windows job 的 RPC 冒烟，写 `test/linux-package-smoke.mjs`（或复用现有 `scripts/check-recovery-ui.mjs` 思路）：
- `xvfb-run electron .` headless 启动，验证：主窗口创建、`node_modules/node/bin/node -p process.arch` 探针、koffi 原生加载、Harness HTTP 端口就绪（`127.0.0.1:<port>` 健康检查）、`.desktop` 桌面条目与图标。
- 麒麟 V10 / UOS 实机回归清单：窗口显示（X11 与 Wayland 各一遍，Wayland 需 `--ozone-platform-hint=auto`）、托盘（可选）、`xdg-open` 外链、字体（思源/文泉驿）、高 DPI。

### 步骤 8：deb/rpm 桌面集成细节（半天）

- electron-builder 自动生成 `/usr/share/applications` 的 `.desktop` 与 hicolor 图标（用 `build/icon.png`，建议补 512x512）。
- 自启动（如 Harness 侧安装器需要）：Linux 惯例是 `~/.config/autostart/*.desktop`，对应 mac 的 LaunchAgent；一期同审计逻辑一起空缺，二期补审计。

---

## 四、P2 详细步骤：信创落地（3-5 天）

1. **麒麟软件商店 / UOS 应用仓库上架**：按各自规范调整 deb（控制文件、包名 `dsh-desktop`、分类、隐私声明），提交审核；上架后应用内更新引导改为商店。
2. **GPG 签名**：新增 `scripts/finalize-linux-release.mjs` 生成 `.sha256` + detached `.sig`，并（可选）重写 latest-linux.yml 的校验字段。
3. **离线安装包集**：脚本产出 `deb + 依赖清单（apt-offline 格式或 README）+ sha256 + GPG 签名` 的 zip，供内网交付。
4. **托盘（可选）**：Kylin/UOS 的 DDE 走 AppIndicator（StatusNotifier）；若产品需要"关窗驻留"，实现 `close-to-tray.ts` 的 linux 分支 + `index.ts:901` 托盘创建，GNOME 上无扩展时自动禁用降级。
5. **systemd 用户单元审计（二期）**：把 `launch-agent-audit.ts` 的 `LaunchDefinition` 抽象成接口，新增 `systemd-unit-audit.ts`（扫描 `~/.config/systemd/user/*.service`，`systemctl --user stop/disable/mask` 等价 bootout/disable），复用现有测试结构。
6. **`@vscode/ripgrep` 下载镜像化**：确认信创构建机可配 `GITHUB_MIRROR` 或 vendor 离线二进制。

---

## 五、P3：loongarch64（新龙芯）——高风险项，先 PoC 再排期

**硬约束**：Electron 官方发布矩阵只有 linux x64/arm64/armv7l/ia32；[Loongnix 官方 Electron 移植最高为 v31.7.7（含 lsx 优化版）](https://docs.loongnix.cn/electron/download/)，而本项目用 Electron 43。

**PoC 步骤（约 1 周出结论）**：

1. 在 Loongnix/UOS 龙芯版实机上装 Loongnix Electron 31，用 dsh 的渲染端（Vite 产物）跑通 UI —— 验证渲染层对 Electron 31 的兼容面（`utilityProcess`、`titleBarOverlay` 等 43 特有 API 在 Linux 本来就不用，风险集中在 Chromium/Electron 主进程 API 差异与 Node 子进程协议）。
2. Node 运行时：[Loongnix Node.js 仓库](https://www.loongnix.cn/zh/api/nodejs/)取 node 20/22 loong64 二进制；新增 `scripts/install-node-runtime.mjs`，按平台/arch 从镜像取 node 放入 `node_modules/node/bin/`（替代 npm `node` 包的自动下载；loong64 时覆盖），`verify-target.mjs` 探针逻辑不变。
3. electron-builder：`package:linux:loong64`，用 `electronDist` 指向本地解压的 Loongnix Electron 目录（绕过官方下载校验）；deb 的 arch 名在 config 里覆写为 `loongarch64`（UOS/麒麟仓库规范）。
4. `@vscode/ripgrep` 无 loong64：dsh 侧回退系统 `rg` 或 vendor [Loongnix 的 ripgrep 包](https://www.loongnix.cn)。
5. koffi 已有 loong64 预编译（已核实），Windows 冒烟已覆盖其加载路径，风险低。
6. cloudflared：禁用下载通道（步骤 1.5 已改为优雅降级），走 pinggy/系统 ssh。
7. PoC 通过后，评估"双轨 Electron"（x64/arm64 用 43、loong64 用 31）的代码分支成本，再决定是否立项全量适配。

**明确不支持**：mips64el（老龙芯 3A4000 及以前，无可用的现代 Electron 移植）。

---

## 六、工作量与风险汇总

| 项 | 难度 | 预估 | 关键文件 |
|---|---|---|---|
| desktopPlatform/update-policy 解锁 | 低 | 0.5 天 | desktop-service/service.ts:19、update-policy.ts:7 |
| electron-builder linux 段 + 构建脚本 | 低 | 1 天 | package.json、verify-target.mjs（复用） |
| CI linux job + 发布校验扩展 | 中 | 2 天 | .github/workflows/release.yml、verify-release-assets.mjs |
| 更新策略（deb/rpm 引导安装 + per-arch feed） | 中 | 2 天 | update-manager.ts、version-catalog.ts、新 finalize-linux-release.mjs |
| Linux 冒烟 + 麒麟/UOS 实机回归 | 中 | 2-3 天 | 新 smoke 脚本 |
| 托盘/自启动（可选） | 中 | 2 天 | close-to-tray.ts、index.ts:901 |
| LaunchAgent→systemd 审计（二期） | 中 | 3 天 | launch-agent-audit.ts、plugin-component-cleanup.ts |
| **loongarch64 PoC→适配** | **高** | 1 周 PoC + 2-4 周 | Electron 降级兼容面、node/ripgrep loong64 运行时供给 |

| 风险 | 影响 | 缓解 |
|---|---|---|
| Electron 43 无 loong64（Loongnix 最高 31.7.7） | loongarch 可能整体不可行 | 先 PoC；双轨 Electron；或龙芯版只出 tar.gz 实验通道 |
| npm `node` 包无 loong64 | Harness 起不来（verify-target 直接拦） | Loongnix node 二进制 + install-node-runtime.mjs |
| deb/rpm 无自动更新 | 更新体验降级 | 版本检查+引导安装；商店/仓库渠道 |
| @vscode/ripgrep 无 loong64 | 搜索功能缺失 | 回退系统 rg / vendor |
| cloudflared 资产表缺条目 | 新 arch 隧道报错 | 优雅降级 + PATH 探测（pinggy 零改动兜底） |
| 国产 DE 差异（Wayland/HiDPI/字体/托盘） | 体验问题 | 实机回归清单（步骤 7） |

## 七、验收标准（P1 出口）

- [ ] `npm run package:linux:x64|arm64` 在 Ubuntu 24.04（含 arm runner）产出 deb/rpm/tar.gz + latest-linux.yml + sha256
- [ ] 麒麟 V10 x86_64 / UOS arm64 实机安装启动，Harness 端口就绪、会话完整跑通一轮
- [ ] `verify-release-assets.mjs` 全绿；GitHub Release + ModelScope 镜像含全部 Linux 资产
- [ ] deb/rpm 安装下"检查更新"正确降级为引导安装，不崩溃（desktopPlatform 不再 throw）
- [ ] Wayland/X11、1x/2x HiDPI、中文字体、外链打开通过回归清单

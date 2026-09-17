# dsh-desktop 项目全面分析

> 基于对仓库（v0.1.1，Electron 43.4.0，上游 Harness 0.1.5-rc.2）的逐目录审计：主进程 71 个 TS 文件、23 个 patch、106 个测试文件、全部 scripts/workflows/docs。Linux/信创移植专案见 `docs/linux-xinchuang-porting-plan.md`。

---

## 1. 项目定位一句话

**dsh-desktop 是 DeepSeek Harness（dsh CLI）的跨平台桌面壳**：Electron 只负责窗口、更新、移动桥、故障恢复等"壳"职责；AI Agent 的全部能力（会话、UI、插件、工具）由**独立 Node 子进程里跑的 Harness HTTP 服务**提供，渲染窗口加载的是 `http://127.0.0.1:<port>` 的 Web UI。Electron 渲染层完全不打包业务代码。

## 2. 总体架构

```
┌─ Electron 主进程 (out/main/index.js, ~3200 行 bootstrap) ─────────────┐
│  窗口/托盘/菜单/单实例锁   安全策略(security.ts)   自动更新(electron-updater) │
│  GPU 降级/窗口自愈        安全模式+插件恢复 UI     手机桥(LanMobileBridge)  │
│  遥测(desktop-service)    profile/插件状态机(state/)  launchd 审计(mac)   │
└──────────────┬───────────────────────────────────────────┘
               │ spawn node（mac 走 UtilityProcess disclaim）/ 或加载
               ▼
┌─ Harness 子进程（内嵌 node@24.9.0, 127.0.0.1:43129）───────────────────┐
│  dsh CLI --patch dsh-desktop.patch.yml --profile <p>                  │
│  Web GUI（dsh-client-ui-* combo bundle）+ token 认证 RPC API            │
│  插件系统（cordis loader + pnpm generation 安装）+ PPT/市场/预设 插件     │
└───────────────────────────────────────────────────────────────────────┘
               ▲ loadURL(token URL)          ▲ 手机扫码经 /desktop 代理
┌─ BrowserWindow（渲染层=纯 Harness Web UI）┐   └─ LAN 私网 或 cloudflared/pinggy 隧道
```

关键设计决策：

| 决策 | 实现 | 价值 |
|---|---|---|
| UI 不进 Electron | 窗口加载 Harness 本地 HTTP 服务 | 壳与引擎解耦，升级 Harness 不动壳；网页版/桌面版同一套 UI |
| 独立 Node 运行时 | npm `node@24.9.0` 包随包分发（`index.ts:575`） | 不依赖用户机器的 node |
| 双层定制 | patch-package（改依赖源码）+ `--patch` yml（运行时插件组合） | 功能定制与插件挂载分离；safe 模式有最小化 patch |
| macOS 权限剥离 | Harness 在 disclaimed UtilityProcess 里跑（`index.ts:2699`） | 插件的 TCC 权限请求不归咎主应用 |
| 不可变插件安装 | generation 目录 + 原子 rename 晋升（market-installer） | 规避 Windows rename-over-existing 死穴 |
| 插件故障溯源协议 | loader 补丁输出结构化 `dshPluginFailure` JSON | 恢复 UI 精准定位坏插件，而非猜测 |

## 3. 目录地图

| 目录 | 内容 |
|---|---|
| `src/main/`（~30 文件） | `index.ts`（bootstrap+IPC+恢复流程）、`runtime/`（Harness 启动/插件命令 shim）、`state/`（22 个 profile/插件状态机：修复、迁移、清算、LaunchAgent 审计）、`update/`（electron-updater+版本目录+灰度）、`mobile/`（手机桥+双隧道）、`desktop-service/`（遥测/灰度客户端）、安全/安全模式/GPU 降级/窗口恢复 |
| `src/preload/` | contextIsolation 桥：目录选择器、openInFinder、桌面存储、更新页/失败页/恢复页、Windows 自绘标题栏（双入口构建为 CJS） |
| `src/shared/` | 主/渲染共享契约（零平台分支） |
| `packages/` | 4 个自有插件：`dsh-desktop-client-ui`（品牌 slot）、`dsh-desktop-hmr-fallback`（签名态 HMR 兜底）、`dsh-desktop-market-installer`（pnpm generation 安装器）、`dsh-desktop-preset-transfer`（.dshpreset 导入导出）；`ppt-runtime`+`ppt-bundles`（内置 AI PPT 模板运行时，`ppt:build` 流水线产出 16 套模板 tgz，sha512 记入 artifacts.json）；GIS 样例插件 |
| `patches/` | 23 个 patch-package 补丁，约 +4300 行（见 §5） |
| `build/` | extraResources：splash/恢复页/安全模式页、`harness-node-entry.mjs`（Node 引导）、`dsh-desktop(.safe).patch.yml`（--patch 层）、Windows 隐藏控制台钩子、图标 |
| `scripts/` | 打包/签名/发布校验/版本索引/PPT 模板流水线/recovery UI 冒烟 |
| `test/` | 106 个 vitest 文件（见 §7） |
| `docs/` | architecture、development、release-runbook、rollout 诊断契约、6 份 Harness 升级记录、PPT 来源考证、网页→桌面迁移、信创移植方案 |

## 4. 启动流程（bootstrap 主链）

1. `requestSingleInstanceLock()`（`index.ts:3152`）→ 拿到锁后才初始化遥测；`launchd-guard` 识别 launchd 拉起的守护实例并令其退出（防抢单例锁）。
2. `createWindow()` → `showSplash()`；`HarnessRuntime.start()`：
   - `reserveLoopbackPort(43129)`（被占则临时端口）；
   - `resolveShellEnvironment()`：mac `$SHELL -l -i -c env` / win PowerShell 加载 $PROFILE（补 GUI 启动缺 PATH 的坑，含 CJK 代码页处理）；
   - `spawn(node, [--expose-internals, harness-node-entry.mjs, dshEntry, web, --patch, dsh-desktop.patch.yml, --no-open, --host, 127.0.0.1, --port, N])`；
   - stdout 抓 `?token=` 认证令牌；健康探测（回环响应+稳定期）通过 → `openHarness()` 用 `desktopHarnessUrl()` 首航加载，清 stale auth cookie（防换端口后 431）。
3. 失败路径分级：runtime failed → `showRuntimeFailure`；插件启动失败 → `showPluginRecovery`（loader 溯源/日志轮询/renderer 上报三来源）；持续坏 → `showSafeMode`（safe patch 最小 profile）。
4. 自愈：GPU 崩溃降级（win 专属退出码判定）、渲染进程崩溃 reload（5s 冷却×3 次）、正常 profile 启动 60s 未确认健康则回 safe。
5. 手机桥 `LanMobileBridge.start()`（43127，dev 43128）：私网限定 + 配对 token + 扫码确认；公网走 cloudflared→pinggy 回退。

## 5. 定制面：23 个补丁分六类

1. **manifest 注入**（`+dsh+`）：把 4 个 desktop 插件 + `dsh-ppt-composer` 塞进 harness CLI 依赖闭包——自有插件进入 profile 的关键一环。
2. **删除会话功能链**（上游无此 RPC，跨 6 个包 2000+ 行）：persistence 基类→jsonl 实现（进程内 tracker+跨进程目录 lease）→workspace→`session/delete` Remote→RPC 注册→侧栏 UI（含未读红点、Finder 打开）。
3. **桌面外观适配**：Windows 自绘标题栏安全区/平台侧栏宽度、目录选择器改走原生 dialog IPC。
4. **上游 bug 修复**：打包态裸包名 `import()` 解析兜底（签名应用无 internal loader）+ 结构化插件故障溯源；401/403 错误分类改 quota 优先（403→FORBIDDEN）；Windows symlink 修复；两处性能修复（bundle 重复哈希、逐码点换行统计）。
5. **UI 增强**：模型选择器搜索、模型设置页大改（820 行）、conversation 两个新 slot（`hero.modeActions`/`input.accessory`，PPT 挂载点）、预设导入导出 UI。
6. **杂项**：deliverables 本地路径引用解析（`file.ts#L12` 风格）。

维护策略：`docs/harness-0.1.5-patch-refactor.md` 将补丁分级（L0 可上游化提 PR…），逐步还给上游。所有 patch 文件名带精确版本号，升级 Harness 需逐个迁移重验（历史升级文档记录了核对流程）。

## 6. 插件市场与安全模型

- **安装**：每插件独立 staging 全新 `pnpm install` → 原子 rename 晋升到 generationId 目录（只读不可变）；删除与宿主冲突的传递依赖（react/react-dom/@deepseek-ai/* 上溯宿主共享副本，保证单 React）；peer 未满足则无条件提升。安全约束：包名白名单、git 源限 pinned sha、构建脚本审批白名单、90s 超时。
- **pnpm-runner**：所有 profile 包操作统一入口；Windows EPERM rename 重试/让位策略 + idle 超时。
- **恢复**：坏插件从 patch 层剪除 + 清理遗留目录 + 恢复页 UI；核心 bundle（dsh-base/web-app/dshmarket）受保护。
- **LaunchAgent 审计**（mac）：修复"插件装的 Agent 缺 ELECTRON_RUN_AS_NODE 导致 launchd 拉起完整 GUI"缺陷；更新器替换 .app 前强制停掉引用 bundle 内可执行文件的 Agent。
- **安全**：`secureWindow()` 仅放行受信 URL，外链转系统浏览器；禁 webview attach；权限仅 `clipboard-sanitized-write`；API 全 token 认证；遥测需每条原生弹窗批准（默认拒绝）、脱敏、队列≤50、失败即弃。
- **版本锁定**：217 个 dsh 依赖同版本精确 pin + lockfile integrity（`release.test.ts` 强制）；node/pnpm/electron/react 全 pin；唯一 override 是 koffi 3.1.5（native 收敛，配合 npmRebuild:false + asar:false）。

## 7. 测试与发布

- **测试**（vitest，60s 超时，CI 弱机关并行）：主进程单测/集成（更新、profile/插件状态机、generation 安装器、移动桥、launchd、GPU/窗口自愈）；~20 个 `*-patch.test.ts` 直接对应上游补丁；脚本测试；PPT 集成测试；最接近 e2e 的是 `recovery-ui-smoke`（真实启动 Electron 截图断言）。**无打包级 e2e 框架**。
- **发布链**：mac ARM64（公证）→ mac Intel → win（NSIS，未签名）→ **sign-windows（self-hosted mac runner + Jsign + SafeNet UKey，签名失败则发布不启动）** → GitHub Release → ModelScope 国内镜像 → dshdesktop.com 版本索引重建（灰度 rollout 契约：`/crash/v1/updates/check`）。回滚体系：`releases/archive/<v>/` + `versions.json`（`backfill-archive.yml` 可补录）。

## 8. 质量评价

**优点**：
- 架构边界清晰（壳/引擎/插件三层解耦），失败路径处理极其完备（safe 模式、插件恢复、GPU 降级、窗口自愈、更新回滚、灰度）——工程成熟度明显高于典型 Electron 应用。
- 测试覆盖与实现同步（状态机类模块几乎一文件一测试），发布校验/签名门禁严密。
- 插件系统的不可变安装 + 溯源协议 + Windows rename 规避，说明对跨平台文件系统坑有系统性认识。

**短板/风险**：
- `index.ts` ~3200 行承担 bootstrap+全部 IPC+恢复流程，是最大的可维护性债；`state/` 22 个状态机缺少一张总览文档。
- patch 层 +4300 行与上游版本强耦合，升级成本高（已有分级上游化计划但依赖上游配合）。
- `desktop-service/service.ts:20` 的 `desktopPlatform()` 对未知平台直接 throw（Linux 移植第一拦截点）。
- 无打包级自动化 e2e；Windows 签名依赖单台 self-hosted UKey 机器（单点）。
- 版本 0.1.x 阶段 API/插件协议变动频繁（6 份升级记录），patch 迁移流程目前靠人工核对清单。

## 9. 与 Linux/信创移植的衔接

本报告 §2/§4 的启动链在 Linux 上唯一缺的是运行时二进制供给（内嵌 node/ripgrep 的 loong64）与打包/更新链（deb/rpm/CI/latest-linux.yml）；代码级平台分支约 60 处中 Linux 需要动的只有 3 处硬拦截 + 若干可选体验项。详细步骤、工作量与风险表见 `docs/linux-xinchuang-porting-plan.md`。

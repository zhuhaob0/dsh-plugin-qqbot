# qqbot-supervisor

> DSH 插件 · 托管 `qq-bridge` 与 `SnowLuma` 两个外部进程，让「打开 DeepSeek Harness 就自动上线 QQ 机器人」

## 这个插件解决什么问题

`qq-bridge`（QQ ↔ DSH 桥接）和 `SnowLuma`（OneBot 实现的 QQ 客户端）都是**独立进程**，
传统做法要靠一个启动脚本按顺序拉起它们、盯端口、处理崩溃重启，
而且 DSH 桌面版**每次启动端口都不同**，桥接的 `dsh.baseUrl` 永远追不上。

本插件把这件事搬进 DSH 宿主内部：

| 痛点 | 插件的做法 |
|---|---|
| 每次开 DSH 要手动跑脚本 | 插件加载即自动拉起 SnowLuma → 等就绪 → 拉起 qq-bridge |
| 桌面版端口每次变 | 插件在宿主内读自己的监听端口，通过 `DSH_BASE_URL` 环境变量注入给子进程，**从不写配置文件** |
| 进程挂了没人管 | 30 秒看门狗自动重启（SnowLuma / 桥接都管） |
| 关 DSH 留一堆僵尸进程 | 插件卸载 / 宿主退出时 `taskkill /T` 收掉整棵进程树 |
| 插件开关不生效 | 插件每 2 秒读一次 profile 的 `bundles`，被移出就自杀、被加回就复活（见下文「开关机制」） |

一句话：**插件是保姆，不是重写**——桥接和 SnowLuma 仍是独立进程，插件只负责它们的生命周期。

## 架构

```
DSH 宿主进程（Electron-as-Node）
├── qqbot-supervisor 插件（本包，in-process）
│     ├─ 读宿主端口（argv / 活动句柄 / env）→ 组 DSH_BASE_URL
│     ├─ spawn SnowLuma（node.exe index.mjs），等 3001 就绪
│     ├─ spawn qq-bridge（node src/bridge.js），注入 DSH_BASE_URL
│     └─ 30s 看门狗 + 退出清理
├── SnowLuma 子进程        监听 3000(HTTP) / 3001(WS)
├── qq-bridge 子进程       监听 3100(控制台)
└── MCP servers（qq-bridge 提供，独立于本插件）
```

桥接通过 `DSH_BASE_URL` 连回宿主；端口每次启动都重新探测，**无需人工同步**。

## 前置条件

| 依赖 | 说明 |
|---|---|
| DSH | 已在用桌面版或 web 版，且 profile 内有 `@deepseek-ai/dsh-base` |
| `qq-bridge` | 已安装并配置好 `config.json`（白名单、SnowLuma 路径等） |
| `SnowLuma` | 已安装、已登录 QQ，OneBot HTTP/WS 服务开启 |
| Node ≥ 22.13 | 用于跑桥接（默认用 PATH 里的 `node`，也可在配置里指定） |

> 本插件只负责**启动/停止**这两个程序，不修改它们的业务配置。

## 安装

### 从本地目录安装（开发/自用）

```powershell
dsh plugin --profile desktop add <本地插件目录路径>
```

`dsh plugin add` 会：写入 `dependencies`（`link:` 本地路径）→ 追加到 `dsh.profile.bundles` → 跑 pnpm 安装依赖。
装完**重启 DSH** 生效。

### 从 npm 安装（发布后）

```powershell
# 默认（web profile）
dsh plugin --profile web add qqbot-supervisor

# 桌面版（本插件主要使用场景）
dsh plugin --profile desktop add qqbot-supervisor
```

### 卸载

```powershell
dsh plugin --profile desktop remove qqbot-supervisor
```

卸载会触发插件 `dispose()`，SnowLuma 与桥接会被一起停掉。

## 配置

插件在 DSH 插件管理页展示以下配置（`Config` schema，保存在 profile 里）：

| 配置项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | **总开关**：取消勾选会立即停掉 SnowLuma 与桥接，勾上则重新拉起 |
| `manageSnowLuma` | boolean | `true` | 是否托管 SnowLuma。关闭后只托管 qq-bridge（适合你自己管理 SnowLuma 的场景） |
| `bridgeDir` | string | `<你的 qq-bridge 目录>` | qq-bridge 所在目录，**必须改成本机实际路径** |
| `snowLumaDir` | string | `<你的 SnowLuma 目录>` | SnowLuma 所在目录（内部使用其中的 `node.exe`），**必须改成本机实际路径** |
| `consolePort` | number | `3100` | 桥接控制台端口（用于判断桥接是否已在外运行） |
| `snowLumaPort` | number | `3001` | SnowLuma OneBot WS 端口（用于判断是否已就绪） |

## 提供的工具

插件会为每个 agent 注册三个工具（会话里直接可用，也可让 agent 自己调用）：

| 工具 | 作用 |
|---|---|
| `qqbot_status` | 返回结构化状态：桥接状态/PID/重启次数/宿主地址、SnowLuma 状态/PID、最近日志尾部 |
| `qqbot_restart` | 杀掉桥接进程树后重新拉起（不动 SnowLuma） |
| `qqbot_logs` | 读 `bridgeDir/state/bridge.log` 尾部 N 行 |

示例返回：

```json
{
  "state": "ready",
  "host": "http://127.0.0.1:61213",
  "pid": 26880,
  "restarts": 0,
  "snowluma": { "state": "ready", "pid": 25540, "port": 3001 }
}
```

## 生命周期

**启动顺序**（`apply()` → `ensure()`）：

1. 探测宿主端口（优先级：配置 `hostPort` → `--port` 参数 → 本进程监听句柄 → `DSH_WEB_URL` → 3080）
2. 若 `3001` 未监听 → spawn SnowLuma，最多等 90 秒就绪
3. 若 `3100` 未监听 → spawn qq-bridge（`DSH_BASE_URL` 指向第 1 步的端口）
4. 注册工具（按 agent 注册，见下文「踩坑记录」）

**运行中**：每 30 秒看门狗检查一次，SnowLuma 或桥接掉线自动重启。
桥接退出若返回 `code=2`（单实例锁冲突），会转为「认领外部实例」而不是无限重试。

**卸载 / 宿主退出**：`ctx.on('dispose')` → 清定时器 → `taskkill /PID <pid> /T /F` 收掉桥接与 SnowLuma。

## 开关机制（重要）

DSH 插件页的开关，实现上改的是 profile `package.json` 的 `dsh.profile.bundles` 列表。

- **带浏览器半侧的插件**（如 `dsh-pet`）可以走 HMR **实时**卸载/加载
- **只有宿主半侧的插件**（本插件）会被判定为 `restart-required`，DSH **只改列表、不卸载运行中的实例**

所以本插件自己盯着那个列表：

```js
// 每 2 秒
const now = isBundleEnabled()        // 读 profile 的 package.json
if (now !== lastEnabled) {
  now ? sup.revive() && sup.ensure()  // 被加回 → 重新拉起
      : sup.dispose()                 // 被移除 → 杀掉子进程
}
```

效果：开关拨下后约 2 秒内，SnowLuma 与桥接会被停掉/拉起，**无需重启 DSH**。

> 注意：这意味着插件在“已被移出 bundles”的状态下仍会短暂存在（直到下次重启）。
> 重启后它就不会加载了，行为与开关一致。

## 排错

插件日志落在 `bridgeDir/state/launcher/plugin.log`（宿主 stderr 在桌面版里看不到，所以单独落盘）：

```powershell
Get-Content '<你的 bridgeDir>\state\launcher\plugin.log' -Tail 30
```

常见日志：

| 日志 | 含义 |
|---|---|
| `宿主端口判定为 61213` | 端口探测成功 |
| `SnowLuma 已在运行（3001），保持不动` | 检测到已有实例，未重复启动 |
| `已启动桥接 pid=... DSH_BASE_URL=...` | 桥接由插件拉起 |
| `检测到 3100 已被占用，按「外部实例」认领` | 桥接是别人（脚本/旧实例）启动的，插件不接管 |
| `桥接报告「已有实例在运行」，转为认领外部实例` | 单实例锁冲突，已优雅退让 |
| `检测到插件已被停用（移出 bundles）：停止...` | 开关联动生效 |

端口自查：

```powershell
foreach ($p in 3001,3100) { "$p : " + (Test-NetConnection 127.0.0.1 -Port $p -InformationLevel Quiet) }
```

## 已知限制

1. **关掉 DSH 桌面版 = 机器人下线**。这是“宿主托管”的固有代价；想常驻请改用 `dsh web` 作为宿主。
2. 不托管 **DSH 自身**（插件不可能托管宿主），也不托管 qq-bridge 提供的 3 个 MCP server（那由 profile 的 `cordis.patch.yml` 管理）。
3. SnowLuma 是第三方带原生组件的客户端，本插件只做**本地启动/停止**，不分发、不修改它；使用时请遵守其 EULA。
4. 宿主端口探测有一层兜底依赖 `process._getActiveHandles()`（Node 已标记废弃，但目前可用）；若未来失效，可在配置里固定 `hostPort`。

## 目录结构

```
qqbot-supervisor/
├── package.json         # 包元数据 + dsh.bundle 声明
├── cordis.patch.yml     # bundle patch：往配置树插入插件行
├── lib/
│   └── index.mjs        # 插件全部逻辑（单入口）
├── README.md
└── LICENSE
```

为什么是单文件入口：本插件只有宿主半侧、无构建步骤，逻辑 500 余行、按注释分节
（配置 → 工具探测 → 进程托管 → 工具定义 → apply）。这与生态里 `qq-mode-console`
等纯 host 插件的组织方式一致；若将来逻辑继续膨胀，可再按
`util / supervisor / entry` 拆分成 `src/` 并加构建。

## 开发

```powershell
# 在 DSH 宿主里调试：改完 lib/index.mjs 后重启宿主，或改 profile 的 patch 触发重载
Get-Content '<bridgeDir>\state\launcher\plugin.log' -Tail -Wait

# 发布前
npm pack --dry-run      # 检查打包内容（files 白名单）
```

## License

MIT

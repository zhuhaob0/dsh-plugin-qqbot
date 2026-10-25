# DeepSeek Harness × QQ 机器人 · 完整部署与配置指南

> 覆盖：Node 环境 → 下载 qq-bridge / SnowLuma → SnowLuma 登录与 OneBot 配置 → qq-bridge 配置 →
> DSH 端 preset/MCP 安装 → 启动与验收 → （选做）qqbot-supervisor 插件 → 排错与回滚

---

## 0. 架构与端口约定

```
            QQ 客户端
                │
        ┌───────▼────────┐
        │   SnowLuma     │  OneBot v11 实现
        │  HTTP :3000    │  ← qq-bridge 用（发消息、查状态）
        │  WS   :3001    │  ← qq-bridge 用（收消息）
        │  WebUI:5099    │  ← 你用来登录 QQ / 看配置
        └───────┬────────┘
                │ OneBot HTTP/WS
        ┌───────▼────────┐
        │   qq-bridge    │  控制台 :3100
        │  （Node 进程） │  ← 把 QQ 消息变成 DSH agent 的输入
        └───────┬────────┘
                │ HTTP（cookie 鉴权 / 斜杠 RPC / remote.mux 事件流）
        ┌───────▼────────┐
        │ DeepSeek       │  桌面版：随机端口
        │ Harness（宿主）│  dsh web：固定 3080
        │  + qq-chat-v2  │  + 3 个 MCP server（qq-bridge 提供）
        └────────────────┘
```

**端口一览**

| 端口 | 归属 | 用途 |
|---|---|---|
| 3000 | SnowLuma | OneBot HTTP API |
| 3001 | SnowLuma | OneBot WebSocket（**token 与 3000 不同**） |
| 5099 | SnowLuma | WebUI（被占用时自动退到 5100） |
| 3100 | qq-bridge | 本地控制台（模式 / 人格 / 令牌看板） |
| 3080 | `dsh web` | DSH Web 宿主默认端口（桌面版为随机端口） |

**推荐目录布局**

```
D:\Software\QQBot\
├── qq-bridge\              # 本指南的桥接工程
└── SnowLuma-v2.1.1\        # SnowLuma 发行包
```

---

## 1. 检查并准备 Node 环境

**要求**：Node **≥ 22.13**（qq-bridge 的 `engines` 下限），且 `npm` 可用。

```powershell
node -v      # 需 ≥ v22.13.0
npm -v
```

没有或版本过低时，二选一：

- 官网装 LTS（装完**重启终端/电脑**让 PATH 生效）
- 便携版（不写注册表）：`tools\install-node.ps1 -Dest <目录>`，该脚本会依次尝试
  npmmirror → 清华 TUNA → nodejs.org，固定版本下载。

**建议同时装 ffmpeg**（非必需，但影响两个功能）：

| 用途 | 不装的后果 |
|---|---|
| 语音时长探测 / 音量调整 | 语音库显示 `seconds: null`，无法调音量 |
| 图片压缩（>1MB 的图） | 只能按原图交给模型，可能被拒 |

```powershell
winget install --id Gyan.FFmpeg -e
# 或手动解压到 D:\dev_tools\ffmpeg，并把 bin 加入 PATH；
# 也可在 config.json 里指定 socialV2.voice.ffmpegPath
```

---

## 2. 下载 qq-bridge 与 SnowLuma

| 组件 | 来源 | 版本参考 |
|---|---|---|
| qq-bridge | <https://github.com/Derpyu520/qq-bridge> | v0.2.1-r1（main 分支即此版本） |
| SnowLuma | <https://github.com/SnowLuma/SnowLuma> | v2.1.1（`release.json` 可查） |

```powershell
# qq-bridge
git clone https://github.com/Derpyu520/qq-bridge.git D:\Software\QQBot\qq-bridge
cd D:\Software\QQBot\qq-bridge
npm install          # 会执行 postinstall：修补 @snowluma/sdk 的 ESM 打包问题

# SnowLuma：从 Releases 下载 SnowLuma-v<版本>-win-x64.zip，解压到
# D:\Software\QQBot\SnowLuma-v2.1.1（自带 node.exe，无需额外安装）
```

**注意事项**

- 优先用官方 GitHub；第三方加速代理（如 `gh-proxy.com`）能换速度，但也引入供应链信任点。
- qq-bridge 的 `npm install` 会执行仓库内 `postinstall` 脚本，请确认来源可信。
- SnowLuma 解压后**不要改名移动**，路径写进桥接配置即可。

---

## 3. SnowLuma：登录 QQ + 开启 OneBot + 取 token

1. 双击 `SnowLuma-v2.1.1\launcher.bat`（或用自带 `node.exe index.mjs` 启动，可隐藏窗口）。
2. 浏览器打开 <http://127.0.0.1:5099> → 首次引导：同意条款 → 设置密码 → 接入 QQ → 手机扫码登录。
3. 在 WebUI 里开启 **OneBot HTTP 服务端（3000）** 与 **WebSocket 服务端（3001）**。
4. 分别记录两处 `accessToken`。

> ⚠️ **最容易踩的坑：HTTP 与 WS 是两个不同的 token。**
> 桥接的 `snowluma.accessToken` 只用于 HTTP；WS 的 token 由桥接在启动时
> 从 `<SnowLuma>/config/onebot_<QQ号>.json` 的 `wsServers[].accessToken` **自动发现**，
> 前提是配置了 `snowluma.homeDir`。否则日志会一直 `SnowLuma 连接断开（code=1006）`。

**验收**（此时不需要桥接）：

```powershell
Test-NetConnection 127.0.0.1 -Port 3001   # True
Test-NetConnection 127.0.0.1 -Port 5099   # True
```

若 5099 打不开，先查是否**重复启动了 SnowLuma**（第二实例会退到 5100，且抢不到 3000/3001 而无实际作用）。

---

## 4. 配置 qq-bridge（`config.json`）

从 `config.example.json` 复制一份，然后修改。**必填/关键项**：

| 字段 | 示例 | 说明 |
|---|---|---|
| `ownerQQ` | `123456789` | 管理员 QQ。审批、管理命令、closed-agent 模式都依赖它 |
| `allow.private` | `[你的QQ, 对方QQ]` | 私聊白名单；**留空 + `allowAllWhenEmpty:false` = 谁都不理** |
| `allow.groups` | `[群号]` | 群白名单；留空并开 `allowAllWhenEmpty:true` 则所有群放行 |
| `allowAllWhenEmpty` | `false` | 建议保持 false，显式列白名单 |
| `snowluma.httpUrl` | `http://127.0.0.1:3000` | OneBot HTTP 端口 |
| `snowluma.wsUrl` | `ws://127.0.0.1:3001` | OneBot WS 端口 |
| `snowluma.accessToken` | `<HTTP token>` | **只填 HTTP 的 token** |
| `snowluma.homeDir` | `D:\Software\QQBot\SnowLuma-v2.1.1` | 用于自动发现 WS token 与端点，**强烈建议填** |
| `dsh.baseUrl` | `http://127.0.0.1:3080` | DSH 宿主地址；桌面版端口随机，见第 5 步的替代方案 |
| `agentPreset` | `qq-chat` | 群聊/私聊默认 preset（需 DSH 端已安装） |
| `socialV2.agentPreset` | `qq-chat-v2` | reserved2 模式用的 preset |
| `consolePort` | `3100` | 控制台端口 |
| `dsh.reasoningEffort` | `high` / `max` | QQ 闲聊建议 `high`（更快更省） |

**关于 `dsh.baseUrl` 与随机端口**

- 用 `dsh web --port 3080`：端口固定，直接写 3080。
- 用桌面版：端口每次随机。**不要手改配置**，改用环境变量注入：

```powershell
$env:DSH_BASE_URL = "http://127.0.0.1:<当前端口>"
node src/bridge.js
```

这需要第 10 节的源码补丁（已打）。

**建议同时在 `config.json` 里开语音（可选）**

```json
"socialV2": {
  "voice": { "enabled": true, "dir": "audio", "ffmpegPath": "D:\\dev_tools\\ffmpeg\\bin\\ffmpeg.exe" },
  "tools":  { "sendVoice": true }
}
```

并把准备好的音频（mp3/wav/ogg/m4a 等，≤300 秒、≤20MB）放进 `qq-bridge\audio\`。

---

## 5. 准备 DeepSeek Harness（含**必做**的 DSH 端安装）

### 5.1 选宿主

| 方式 | 端口 | 适用 |
|---|---|---|
| `dsh web --port 3080` | 固定 | 想长期稳定、不想追端口 |
| DSH 桌面版 | 随机（每次变） | 已经在用桌面版，配合 `DSH_BASE_URL` 注入 |

> 同一批会话文件只能由一个宿主写。**不要同时开桌面版和 web 版**，否则会出现
> `session/writer-held: ... already owned by an active write handle`。

### 5.2 确认模型凭据

DSH 里能正常对话（模型可用）即可。桥接不直接持有 API Key，它通过 `~/.dsh` 的凭据与签名密钥鉴权。

### 5.3 安装 DSH 端 preset + MCP（**这一步最容易漏，漏了 QQ 上完全没反应**）

```powershell
cd D:\Software\QQBot\qq-bridge
node scripts/setup-dsh.mjs desktop    # 桌面版；若用 web 宿主则写 web
```

它会：

1. 把 `qq-chat` / `qq-chat-v2` 两个 agent preset 以 bundle 形式注册到 profile
2. 在 profile 的 `cordis.patch.yml` 里挂 3 个 MCP server：
   `mcp-snowluma` / `mcp-snowluma-host` / `mcp-web-search-safe`（路径写绝对路径）
3. 在 profile `package.json` 的 `dsh.profile.bundles` 里加上 `qq-agent-presets` / `qq-mode-console`

**装完必须重启 DSH**（preset 与 MCP 只在宿主启动时加载）。

验收：重启后 DSH 会话里能看到 `mcp__snowluma__*` 系列工具。
如果没有，桥接建会话时会报：

```
preset "qq-chat-v2" 不在 DSH 可用清单（standard, ptc, minimal, cordis）中
```

### 5.4 记录宿主端口

桌面版：从 GUI 地址栏（`http://127.0.0.1:xxxxx`）或进程命令行拿到端口；
web 版：就是 `--port` 指定的 3080。

---

## 6. 启动 qq-bridge 并验收

```powershell
cd D:\Software\QQBot\qq-bridge
start.bat        # 守护模式：崩溃 5 秒后自动拉起（窗口别关）
# 或前台：npm start
```

**成功日志（三条都要有）**

```
SnowLuma 已连接：ws://127.0.0.1:3001
机器人昵称: <你的昵称>
DSH 已就绪（模式: reserved2）
```

> 首次连接 WS 几乎必然失败一次（`code=1006`），随后自动重连成功，属正常现象。

**控制台**：<http://127.0.0.1:3100>

- 访问令牌：`state\console-token`（`config.json` 的 `consoleToken` 为空时自动生成）
- 可切换运行模式：`chat` / `closed-agent` / `reserved` / `reserved2`
- 可调「DSH 思考强度」、人格/角色、白名单、令牌与花费看板

**端到端验收**：在 QQ 里给它发一条私聊，应收到回复；同时 `state\sessions.json` 里会出现该会话的映射。

---

## 7.（选做）安装 `qqbot-supervisor` 插件

作用：把 SnowLuma 与 qq-bridge 交给 DSH 托管，**打开 DSH 即自动上线**，插件开关可一键起停两个进程。

```powershell
dsh plugin --profile desktop add E:\Code\dsh-plugin-qqbot
# 发布到 npm 后：dsh plugin --profile web add qqbot-supervisor
```

重启 DSH 后，在插件管理页配置：

| 配置项 | 说明 |
|---|---|
| `enabled` | 总开关（等价于插件启停） |
| `manageSnowLuma` | 是否托管 SnowLuma |
| `bridgeDir` | qq-bridge 目录（**必须改成实际路径**） |
| `snowLumaDir` | SnowLuma 目录（**必须改成实际路径**） |
| `consolePort` / `snowLumaPort` | 3100 / 3001 |

插件能力：

- 启动顺序：探测宿主端口 → 起 SnowLuma（等 3001 就绪）→ 起 qq-bridge（注入 `DSH_BASE_URL`）
- 30 秒看门狗：任一进程掉线自动重启
- 注册工具：`qqbot_status` / `qqbot_restart` / `qqbot_logs`
- 插件开关联动：轮询 profile `bundles`，被移除即 `taskkill` 两个进程，被加回即重新拉起
- 退出清理：DSH 退出时连带杀掉子进程，不留孤儿

> **不要和 `start.bat` 同时用**：二选一。插件托管时 `start.bat` 会让桥接因单实例锁退出。

---

## 7.5（可选）接入手机操控 —— 仅 owner 私聊可用

让机器人「看见」并操作一台安卓手机：截图、UI dump、点按、滑动、输入、打开 App、跑宏。

### 7.5.1 准备

```powershell
# 1) adb（platform-tools）
Invoke-WebRequest 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip' -OutFile "$env:TEMP\pt.zip"
Expand-Archive "$env:TEMP\pt.zip" -DestinationPath 'D:\dev_tools\'    # → D:\dev_tools\platform-tools\adb.exe

# 2) phone-mcp（MCP server，封装 34 个手机工具）
cd <phone-mcp 目录>          # 例如 ai-companion-kit\packages\phone-mcp
npm install

# 3) 手机：设置 → 开发者选项 → 无线调试（或 USB 调试），授权本机
adb devices                   # 状态应为 device，不是 unauthorized
```

### 7.5.2 挂进 DSH（profile 的 `cordis.patch.yml`）

```yaml
- insert:
    - id: mcp-phone
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: phone
        transport: stdio
        command: 'D:\dev_tools\Nodejs\node.exe'
        args:
          - '<phone-mcp 目录>\src\phone-mcp.js'
        env:
          PHONE_ADB: 'D:\dev_tools\platform-tools\adb.exe'
        toolCallTimeoutMs: 120000
```

### 7.5.3 打开 QQ 侧通道 + owner 闸门（两处源码，见第 10 节）

1. `qq-tool-restrict.mjs` 的 `SAFE_PREFIXES` 加入 `'mcp__phone__'`（放行前缀，否则手机工具在 QQ 会话里一律被拒）
2. 提示词加「管理员私聊例外」（`dsh/agent-presets/qq-chat-v2/agent.cordis.yml`，见 10.4）
3. **owner 身份闸门**由 `qqbot-supervisor` 插件实现（agent 级 `tools.guard`）

> ⚠️ 只做 1+2 等于**对白名单里所有人开放手机**——第 3 步是必须的。

**为什么身份闸门必须在插件里**：预设里的 guard 拿到的 `exec` 只有 `{ name }`，
不含会话信息（实测日志 `[phone-guard] exec={name}`），无法判断调用方是谁；
只有注册在 `agent.ctx` 上的 guard 才能拿到 `agent.id` 去反查会话身份。
因此 `qq-tool-restrict.mjs` 里的 `phoneToolDenial()` 只作为补充：仅当上下文确实带会话 ID 时才校验，
否则放行（避免误伤 owner），由插件兜底。

### 7.5.4 权限矩阵

| 来源 | 手机工具 |
|---|---|
| `private:<ownerQQ>` | ✅ |
| 其他 QQ 的私聊 | ❌ |
| 任何群聊 | ❌ |
| DSH 桌面会话 | ✅ |

判据是 `ownerQQ`（`config.json`），与 `allow.private` 里列了谁无关。

### 7.5.5 验证

让 owner 在私聊里说「打开微信看看有没有新消息」，然后看插件日志：

```
手机工具调用: name=mcp__phone__phone_open_app sid=session-… key=private:2621072338 owner=2621072338
```

`key` 对得上即身份识别正常；`key=-` 说明会话 ID 没解析到，需要检查 `state/sessions.json`。

离线单元验证（不需要手机）也可做：用真实的两个会话 ID 调 guard，owner 放行、群聊拒绝。

### 7.5.6 注意事项

- **`setup-dsh.mjs` 可能覆盖 preset 提示词**：重跑后要检查第 10.4 节的修改是否还在
- **敏感操作一律人工确认**：支付、密码、验证码、转账、退款不要交给模型
- **adb 权限极大**：建议用备用机/独立账号；`phone_shell` 等于手机上的 shell
- **`phone-mcp` v1.0.0 的 QQ 空间工具开箱即坏**（`loadSnowlumaToken` / `resolveImage` 均未定义），
  需按 10.5、10.6 打补丁：前者让 `qzone_*` 能调通 SnowLuma，后者让配图可用
  （纯文字正常、带图必崩是典型症状）
- 手机工具只在 owner 私聊与桌面会话出现，群里连试都不该试（提示词 + 执行层双层拦截）
- **已知残余风险（当前接受）**：身份闸门依赖 `qqbot-supervisor` 插件。若插件被停用、而桥接/SnowLuma
  仍在外部运行（`external` 认领状态不会被 dispose 杀掉），预设里的 guard 因拿不到会话上下文而无法校验身份，
  此时白名单内的 QQ 会话都能调用手机工具。缓解办法：保持插件常开；或接入前先确认桥接已停。
## 8. 验收清单

| # | 检查项 | 期望 |
|---|---|---|
| 1 | `node -v` | ≥ 22.13 |
| 2 | 3000 / 3001 监听 | 都在 |
| 3 | 5099 可打开 | HTTP 200 |
| 4 | 3100 可打开 | 控制台页面 |
| 5 | 桥接日志 | `SnowLuma 已连接` + `DSH 已就绪` |
| 6 | `state\sessions.json` | 发过消息后出现映射 |
| 7 | DSH 会话工具表 | 含 `mcp__snowluma__*` |
| 8 | QQ 私聊 | 能收到回复 |
| 9 | 控制台 | 能切模式、看到 token 用量 |
| 10 |（插件）`qqbot_status` | `state: ready`，含 snowluma 状态 |
| 11 |（手机）owner 私聊让它开 App | 能打开，日志有 `key=private:<ownerQQ>` |
| 12 |（手机）群里让它开 App | 拒绝（提示词层先拦，执行层 guard 兜底） |
| 13 |（手机）看自己的 QQ 空间 | 能读到说说列表（需 10.5 补丁） |
| 14 |（手机）发带图的说说 | 图片随说说上传成功（需 10.6 补丁） |

---

## 9. 常见故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| QQ 上完全没反应 | 白名单为空 + `allowAllWhenEmpty=false` | 填 `allow.private` / `allow.groups` |
| 同上 | 没跑 `setup-dsh.mjs` 或装完没重启 DSH | 补跑 + 重启 |
| 日志刷 `SnowLuma 连接断开（code=1006）` | WS token 没发现 / 端点错 | 配 `snowluma.homeDir`；确认 3001 有监听 |
| `连不上 OneBot HTTP API（http://127.0.0.1:3000）` | SnowLuma 没起 / 端口或 token 错 | 先起 SnowLuma，核对 HTTP 端口与 token |
| `session/writer-held: ... active write handle` | 两个 DSH 宿主同时写会话 | 停掉一个宿主；必要时清 `state\sessions.json`（会重置该 QQ 会话上下文） |
| `preset "qq-chat-v2" 不在 DSH 可用清单` | DSH 侧 bundle 没加载 | 重跑 `setup-dsh.mjs` 并重启 DSH |
| 5099 打不开 / 出现 5100 | 起了两个 SnowLuma，第二个抢不到端口 | 杀掉多余实例，保留占 3000/3001 的那个 |
| 群友发的图“太大，看不了” | 没装 ffmpeg | 装 ffmpeg 并配 `ffmpegPath`/`FFMPEG_PATH` |
| 语音发不出去 | 两个开关没开 / 语音库为空 | 开 `voice.enabled` 与 `tools.sendVoice`，音频放进 `audio\` |
| 插件开关拨了但进程还在 | host-only 插件不会热卸载 | 使用插件自带的 bundles 轮询版本；或重启 DSH |

---

## 10. 源码修改清单（共 6 处）

### 10.1 `src/bridge.js` — 支持 `DSH_BASE_URL` 环境变量

**改动**（`loadConfig()` 内，`dsh` 段末尾，+3 行）：

```js
...(file.dsh ?? {}),
// 供外部托管者注入真实端口（插件/服务管理器），优先于 config.json，避免每次改配置
...(process.env.DSH_BASE_URL ? { baseUrl: String(process.env.DSH_BASE_URL) } : {})
```

**原因**：DSH 桌面版每次启动端口随机（实测 59608 → 60848 → 57392 → …）。
若不改源码，只能每次启动后改 `config.json` 再重启桥接。
加上环境变量后，托管方（插件/脚本）在 spawn 时注入即可，**配置文件永久不用改**，
优先级：默认值 < `config.json` < `DSH_BASE_URL`。

**回滚**：删除这两行，或恢复 `src\bridge.js.bak-*`。

### 10.2 `plugins/qq-agent-presets/qq-tool-restrict.mjs` — 修 restrict 的误报与重试窗口

**改动**（+55 / −33 行）：

1. 区分「工具名不存在」与「真正的 restrict 失败」：只有后者报警。
   原先 82 个名单里 78 个在当时并不存在，每次都打印 `restrict 失败 78/82`，
   加整份 known tools 清单（单行 2KB+），纯噪音。
2. 把「3 秒后重试一次」改成**有界重试窗口（20 轮 × 3 秒 = 60 秒）**：
   实测 `load_workspace_dependencies` 会在 apply 之后才注册进全局层，单次重试会漏。
3. 诊断日志改为每次一条摘要（`隐藏 N/82（首次 4，重试补藏 1，未注册 77）`）。

**原因**：该守卫负责把本地执行/文件工具从 QQ 会话的工具表里隐藏（安全边界）。
误报会掩盖真实问题，重试窗口不足会让晚注册的危险工具漏网（虽然执行期 `tools.guard`
仍会拦截，但 schema 里会暴露）。

**回滚**：恢复 `qq-tool-restrict.mjs.bak-*`。

> 其余文件未改动；`config.json` / `state/*` 属于运行数据，不属于源码。
> SnowLuma 目录**完全未修改**。

---

### 10.3 `plugins/qq-agent-presets/qq-tool-restrict.mjs` — 放行手机前缀 + owner 闸门

**改动**：

1. `SAFE_PREFIXES` 增加 `'mcp__phone__'`（否则手机工具在 QQ 会话里一律被白名单拒绝）
2. 新增 `loadPhoneIdentity()` / `safeGet()` / `resolveSessionId()` / `phoneToolDenial()`，
   并把已有 `ctx.tools.guard()` 改成：白名单通过后，手机工具再过一道身份校验

**已知能力边界（实测）**：该 guard 的 `exec` 只带 `{ name }`，拿不到会话 ID，
所以这里的身份校验**只在上下文恰好带 `session.id` 时才生效**；拿不到时放行并写诊断
（`state/tool-restrict.log` 的 `[phone-guard] exec={…}`），由插件的 agent 级 guard 兜底。
`ctx` 是 cordis 服务代理，读取未 `inject` 的属性会抛错，故所有 ctx 访问都走 `safeGet()`。

**原因**：手机工具是「能操作实机」的高危能力，前缀一放行就等于对白名单里所有人开放。
把闸门放在这个守卫里（而不是插件里）的好处是：它随 QQ 会话一起加载，
**桥接进程活着就一定生效**，不依赖 `qqbot-supervisor` 是否在运行。

**fail-closed**：`sessions.json` 里查不到会话 ID、或 `config.json` 没配 `ownerQQ`，一律拒绝。

**回滚**：恢复 `qq-tool-restrict.mjs.bak-owner`（或删掉 `phoneToolDenial` 调用）。

### 10.4 `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` — 提示词加「管理员私聊例外」

**改动**：在安全规则第 1 条「你没有本地工具……工具不存在就是不存在」之后补一段例外：

> 若工具表里出现 mcp__phone__* 系列，说明管理员已在私聊会话开放手机操作，可照指令使用；
> 群聊或其他会话调用会被拒绝，被拒绝时如实说明当前会话没有权限，不要反复重试。
> 手机操作禁止用于支付、密码、验证码、转账、退款等敏感环节，做到提交或付款前必须停下等管理员确认。

**原因**：只放开白名单不够 —— 模型读到「你没有本地工具」就会直接回答“我伸不出手”，
哪怕工具已经在工具表里。实测现象：工具可见、会话里有 33 个 `mcp__phone__*`，模型仍拒绝。

> ⚠️ **必须改权威源，不要直接改生成物**。
> `plugins/qq-agent-presets/presets/*.patch.yml` 是 `build-agent-preset-patches.mjs`
> 从上面的 `agent.cordis.yml` **生成**的，直接改会在下一次生成时被覆盖（实测已踩过）。
>
> 正确流程：改权威源 → `node scripts/build-agent-preset-patches.mjs` → 用 `--check` 确认一致。
> 该命令只在**手动**执行 `node scripts/setup-dsh.mjs <profile>` 或单独跑 build 时触发，
> DSH 自身不会自动重新生成。

**回滚**：恢复 `qq-chat-v2.patch.yml.bak-phone`。

> ⚠️ `node scripts/setup-dsh.mjs <profile>` 会重新生成/覆盖 preset，重跑后需检查 10.3 与 10.4 是否还在。
### 10.5 `<phone-mcp>/src/phone-mcp.js` — 补 `loadSnowlumaToken` / `SNOWLUMA_HTTP`（第三方包缺陷）

**现象**：QQ 空间相关工具（`qzone_post` / `qzone_my_posts` / `qzone_like` / `qzone_comment` / `qzone_feeds`）
全部失败，工具返回：

```
Error: 看说说失败：loadSnowlumaToken is not defined
```

**根因**：`phone-mcp` v1.0.0 里 `snowluma(action, payload)` 使用了两个符号，
但包内既没有定义、也没有从 `ncm.js` 导出：

```js
async function snowluma(action, payload) {
  const token = loadSnowlumaToken();            // 未定义
  const res = await fetch(SNOWLUMA_HTTP + '/' + action, …)   // 未定义
}
```

所以与 token 是否正确、SnowLuma 是否在线都无关——直接 ReferenceError。

**修复**（在同文件「可选配置」段上方新增）：

```js
const SNOWLUMA_HTTP = process.env.PHONE_SNOWLUMA_HTTP || 'http://127.0.0.1:3000'

function loadSnowlumaToken() {
  if (process.env.PHONE_SNOWLUMA_TOKEN) return process.env.PHONE_SNOWLUMA_TOKEN
  const cfg = process.env.PHONE_BRIDGE_CONFIG || '<默认 bridge config.json>'
  try { return String(JSON.parse(fs.readFileSync(cfg, 'utf8'))?.snowluma?.accessToken ?? '') }
  catch { return '' }
}
```

**配套配置**（profile 的 `cordis.patch.yml`，`mcp-phone` 行的 `env`）：

```yaml
env:
  PHONE_ADB: 'D:\dev_tools\platform-tools\adb.exe'
  PHONE_SNOWLUMA_HTTP: 'http://127.0.0.1:3000'
  PHONE_BRIDGE_CONFIG: 'D:\Software\QQBot\qq-bridge\config.json'
```

**验证**：

```powershell
# 直接打 SnowLuma 扩展 action（应 200 + data）
POST http://127.0.0.1:3000/get_qzone_msg_list  {"num":2}
Authorization: Bearer <config.json 的 snowluma.accessToken>
```

实测返回 `{"status":"ok","data":{"total":1,"msglist":[…]}}`；修复后工具读取恢复正常。

**回滚**：恢复 `phone-mcp.js.bak-qzone`。

> ⚠️ 这是**第三方包**的缺陷修复：升级 `ai-companion-kit` / `phone-mcp` 后补丁会丢失，需重新应用。
> 另外注意 `snowluma.accessToken` 是 OneBot **HTTP** 令牌（不是 WS 令牌）。
### 10.6 `<phone-mcp>/src/phone-mcp.js` — 补 `resolveImage`（第三方包缺陷，带图必崩）

**现象**：发说说带配图时失败（纯文字正常）。同文件里 `video_frames` 传本地视频也一样报错：

```
Error: ReferenceError: resolveImage is not defined
```

**根因**：`qzone_post`（第 ~1075 行）与 `video_frames`（第 ~886 行）都调用 `resolveImage(...)`，
但 v1.0.0 包里没有这个函数的定义——与 10.5 是同一类缺陷（引用了未实现的辅助函数）。

**SnowLuma 侧要求**（读 `index.mjs` 的 action 定义确认）：`send_qzone_msg.images`
接受 `file://`、`http://`、`base64://` 三种形式并自动上传；**裸 Windows 路径不被接受**。

**修复**：

```js
import { pathToFileURL } from 'node:url'

function resolveImage(input) {
  const raw = String(input ?? '').trim()
  if (!raw) return { error: '路径为空' }
  if (/^(https?:\/\/|base64:\/\/|file:\/\/)/i.test(raw)) return { file: raw, url: raw }
  const cands = path.isAbsolute(raw) ? [raw] : [path.join(SHOT_DIR, raw), …]
  for (const c of cands) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) {
      const abs = path.resolve(c)
      return { file: abs, url: pathToFileURL(abs).href }   // file 给 ffmpeg，url 给 SnowLuma
    }
  }
  return { error: '文件不存在：' + cands[0] }
}
```

并把 `qzone_post` 里的 `files.push(r.file)` 改为 `files.push(r.url || r.file)`。

**为什么返回两个字段**：`video_frames` 把结果直接喂给 ffmpeg（需要文件系统路径），
而 `send_qzone_msg` 需要 `file://` URL —— 两种消费者要求不同，所以同时给 `file` 和 `url`。

**验证**：

```powershell
# file:// URL 形如（Windows 三斜杠 + 正斜杠）
file:///C:/Users/<you>/AppData/Local/Temp/phone-mcp-shots/shot-xxx.png
```

修复后：先 `phone_screenshot` 截图，再 `qzone_post(content, images=["shot-xxx.png"])`
（文件名相对 `PHONE_SHOT_DIR` 解析），图片随说说一起上传。

**回滚**：恢复 `phone-mcp.js.bak-qzone2`。

> ⚠️ 同样是第三方包缺陷：升级 `phone-mcp` 后补丁丢失，需重新应用。
## 11. 安全与合规

- **白名单优先**：`allowAllWhenEmpty=false` + 显式列出私聊/群；`deny` 优先级更高。
- **`ownerQQ` 必须填**：否则审批、管理命令、closed-agent 全部不可用。
- **控制台令牌**：`state\console-token` 是管理凭据，勿外泄；可在控制台重置。
- **`dsh.authToken` 建议留空**：桥接用 `~/.dsh` 的持久化签名密钥离线铸造 cookie，
  填了反而可能 401。
- **SnowLuma 合规**：它是第三方专有客户端，EULA 禁止并入第三方安装包或通过自动化脚本部署。
  本指南与插件只做**本地启动已安装副本**，不修改、不分发它。
- **不要暴露到公网**：桥接控制台、SnowLuma WebUI、DSH 宿主都设计为仅监听 127.0.0.1。

---

## 12. 卸载 / 回滚

```powershell
# 1) 停服务
#    - 用插件：插件页拨关闭，或直接卸载
dsh plugin --profile desktop remove qqbot-supervisor
#    - 用 start.bat：关闭其窗口（或任务管理器结束 node.exe）

# 2) 还原 qq-bridge 源码（如打过补丁）
cd D:\Software\QQBot\qq-bridge
Copy-Item src\bridge.js.bak-* src\bridge.js -Force
Copy-Item plugins\qq-agent-presets\qq-tool-restrict.mjs.bak-* plugins\qq-agent-presets\qq-tool-restrict.mjs -Force

# 3) 从 DSH profile 移除 MCP / preset（若不再使用桥接）
#    编辑 ~/.dsh/profiles/<profile>/cordis.patch.yml，删除 "=== qq-bridge MCP ===" 区块
#    并从 package.json 的 dsh.profile.bundles 移除 qq-agent-presets / qq-mode-console
```

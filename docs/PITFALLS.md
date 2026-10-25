# 排错手册（按症状索引）

> 这份文档记录本项目实际踩过的坑，按「你看到的现象」组织。
> 每条都给出：症状 → 原因 → 处理。涉及源码修改的，对应 [DEPLOYMENT.md](DEPLOYMENT.md) 第 10 节的编号。

---

## 快速索引

| 你看到的 | 跳到 |
|---|---|
| 整个 DSH 用不了、所有请求都失败 | [A1](#a1-所有请求都报-invalid-schema-for-function) |
| 插件装上了但工具不出现 | [A2](#a2-工具注册了但会话里看不到) |
| 新建会话报 `xxx is not defined` | [A3](#a3-新建会话报-referenceerror) |
| 改插件代码后报 `cannot get property without inject` | [A4](#a4-cannot-get-property-without-inject) |
| 插件开关拨了但进程还在跑 | [A5](#a5-插件开关拨了没反应) |
| 改的 preset 提示词过一阵自己变回去 | [A6](#a6-改了-preset-却自己回滚) |
| 桥接连不上 SnowLuma（1006） | [B1](#b1-snowluma-连接断开-code1006) |
| 桥接说会话被别的进程占用 | [B2](#b2-sessionwriter-held) |
| 桥接说 preset 不在可用清单 | [B3](#b3-preset-不在-dsh-可用清单) |
| 发了消息机器人完全没反应 | [B4](#b4-消息被完全忽略) |
| 机器人半天不回、像在发呆 | [B5](#b5-机器人半天不回) |
| SnowLuma WebUI 打不开 / 出现 5100 | [C1](#c1-snowluma-webui-打不开出现-5100) |
| 空间工具全报错 `loadSnowlumaToken` | [D1](#d1-空间工具全报错) |
| 发说说带图必崩 | [D2](#d2-发说说带图必崩) |
| 手机工具提示未授权 | [D3](#d3-adb-设备-unauthorized) |
| 微信界面 dump 出 0 个元素 | [D4](#d4-phone_dump-返回-0-个元素) |
| 中文全变成 `????` 或方块 | [E1](#e1-中文乱码) |
| 语音转出来是乱码 | [E2](#e2-语音转写结果全是乱码) |
| 语音发不出 / 时长显示 null | [E3](#e3-语音相关异常) |
| 别人能操作我的手机 | [F1](#f1-权限边界) |

---

## A. DSH 插件

### A1. 所有请求都报 `Invalid schema for function`

**症状**：装上某个插件后，整个 DSH 不可用，所有对话都失败：

```
Invalid schema for function 'xxx': schema must be a JSON Schema of 'type: "object"', got 'type: null'
```

**原因**：插件把「字段表 DSL」直接传给了 `ctx.tools.register()`。宿主不会替你归一化，
它要求 `parameters` 是**完整 JSON Schema**。错误的 schema 会毒化**所有**请求（不只是那个工具）。

**处理**：

```js
// ❌ 错：字段表
parameters: { name: { type: 'string', required: true } }

// ✅ 对：完整 JSON Schema
parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
```

**教训**：改插件后先在临时宿主验证（`dsh --profile web --patch <overlay.yml> --port 3099`），
别直接装进在用的 profile。

---

### A2. 工具注册了但会话里看不到

**原因**：注册在**插件自己的** `ctx` 上，只有注册到 `agent.ctx` 才会出现在会话工具表。

**处理**：

```js
ctx.on('agent/created', (payload) => {
  const agent = payload?.agent ?? payload      // payload 形如 { agent, source, signal }
  agent.ctx.effect(() => agent.ctx.tools.register(def))
})
```

注意 `agent/created` 的 payload 是 **对象**（含 `agent` 字段），不是 agent 本身——
直接 `payload.ctx` 会得到 `Cannot read properties of undefined`。

---

### A3. 新建会话报 `ReferenceError`

**症状**：`gateway/internal failed to create session: ReferenceError: xxx is not defined`

**原因**：调用了不存在的函数。这在本项目里出现过三次，
其中两次是**第三方包**的缺陷（见 D1、D2），一次是自己插入代码时锚点没匹配、`Replace` 静默失败。

**处理**：

```powershell
# 改完代码先自查：调用的函数是否都有定义
node --check <file>          # 只能查语法，查不出「调用未定义函数」
Select-String -Path <file> -Pattern 'function xxx|const xxx ='
```

**教训**：`node --check` 通过 ≠ 能跑。插入代码后必须用 grep 确认「调用处」和「定义处」都在。

---

### A4. `cannot get property "xxx" without inject`

**原因**：cordis 的 `ctx` 是**服务代理**。没在 `inject` 里声明的服务，读取时直接抛错：

```
Error: cannot get property "session" without inject
```

**处理**：要么在 `export const inject = [...]` 里声明，要么用安全访问：

```js
function safeGet(obj, key) {
  try { return obj == null ? undefined : obj[key] } catch { return undefined }
}
```

本项目 `qq-tool-restrict.mjs` 里就是后者（DEPLOYMENT 10.3）。

---

### A5. 插件开关拨了没反应

**原因**：DSH 的插件开关本质是改 profile 的 `dsh.profile.bundles` 列表。
**只有宿主半侧**的 bundle 会被判定为 `restart-required`——DSH 只改列表，**不卸载运行中的实例**，
所以进程照旧跑。只有带浏览器半侧的插件（如 `dsh-pet`）才走 HMR 实时生效。

**处理**（本项目采用）：插件自己每 2 秒读一次 `package.json` 的 bundles：

```js
const now = isBundleEnabled()
if (now !== last) now ? sup.revive() + sup.ensure() : sup.dispose()
```

见 README「开关机制」一节。

---

### A6. 改了 preset 却自己回滚

**症状**：改了 `plugins/qq-agent-presets/presets/*.patch.yml`，跑一次 build 或 setup 后改动没了。

**原因**：那个文件是**生成物**，权威源在 `dsh/agent-presets/<preset>/agent.cordis.yml`。

**处理**：

```powershell
# 改权威源，然后重新生成
node scripts/build-agent-preset-patches.mjs
node scripts/build-agent-preset-patches.mjs --check   # 确认一致
```

见 DEPLOYMENT 10.4。

---

## B. qq-bridge

### B1. SnowLuma 连接断开 `code=1006`

**原因**：WebSocket 的 `accessToken` 不对。**HTTP（3000）和 WS（3001）是两个不同的 token**，
桥接的 `snowluma.accessToken` 只用于 HTTP；WS 的 token 需要桥接从
`<SnowLuma>/config/onebot_<QQ号>.json` 自动发现。

**处理**：在 `config.json` 里配 `snowluma.homeDir`（指向 SnowLuma 目录），重启桥接。
首次连接失败一次是正常的，会自动重连。

---

### B2. `session/writer-held`

**症状**：`session/writer-held: ... already owned by an active write handle`

**原因**：同一个会话文件被**两个 DSH 宿主**同时写（比如桌面版和 `dsh web` 都开着）。

**处理**：停掉多余的那个宿主；必要时清 `state/sessions.json`（**会丢失该 QQ 会话的上下文**）。

---

### B3. `preset ... 不在 DSH 可用清单`

**原因**：DSH 端没装 preset + MCP，或者装了但没重启。

**处理**：

```powershell
cd <qq-bridge>
node scripts/setup-dsh.mjs desktop    # 或 web
# 然后必须重启 DSH
```

---

### B4. 消息被完全忽略

**症状**：QQ 上发了消息没反应，桥接日志：

```
忽略未授权会话 private:123456（当前模式 reserved2，来自 123456）
```

**原因**：该 QQ 不在 `allow.private` / `allow.groups` 里（改配置后必须重启桥接才生效）。

**注意**：被忽略的消息**不会补发**，机器人从未看到它们。

---

### B5. 机器人半天不回

**原因**（按概率排序）：

1. **新会话首次回复**要建 workspace + session + 加载 preset + 枚举 MCP 工具，约 30~60 秒
2. `reserved2` 模式下它回复后会 `qq_wait_for_messages` 等下文，新消息只能**排队**：

```
[reserved2] 会话繁忙，暂存唤醒原因 private:xxx（原因=pendingWakeKey）
```

3. 模型在长时间思考（单轮可能几分钟）

**处理**：想更"有问必答"，把模式从 `reserved2` 改成 `chat`/`reserved`；
或缩短 preset 里"回复后等待"的时长。

---

## C. SnowLuma

### C1. SnowLuma WebUI 打不开 / 出现 5100

**原因**：**跑了两个 SnowLuma 实例**。第二个抢不到 5099，退到 5100，同时也抢不到 3000/3001，
是个无法工作的空壳。

**处理**：

```powershell
# 看谁占着端口
foreach ($p in 3000,3001,5099,5100) {
  $o = (Get-NetTCPConnection -LocalPort $p -State Listen -EA SilentlyContinue | Select-Object -First 1).OwningProcess
  "$p : $o"
}
# 保留占着 3000/3001 的那棵树，杀掉另一个
```

**预防**：插件启动 SnowLuma 前会先按命令行查一遍进程（`qqbot-supervisor` 已做），
避免端口检测的竞态导致重复启动。

---

## D. 手机 MCP（phone-mcp）

### D1. 空间工具全报错

**症状**：

```
Error: 看说说失败：loadSnowlumaToken is not defined
```

**原因**：`phone-mcp` v1.0.0 里 `snowluma()` 用了 `loadSnowlumaToken()` 和 `SNOWLUMA_HTTP`，
但**包里没有定义**（第三方包缺陷）。

**处理**：见 DEPLOYMENT 10.5（补两个定义，从 bridge 的 config.json 读 token）。

---

### D2. 发说说带图必崩

**症状**：纯文字正常，一加图就失败，`resolveImage is not defined`。

**原因**：同一个包的另一个未定义函数；而且 SnowLuma 只接受
**`file://` / `http://` / `base64://`**，裸 Windows 路径不行。

**处理**：见 DEPLOYMENT 10.6（补 `resolveImage`，本地路径转 `file://`）。

---

### D3. adb 设备 unauthorized

**症状**：`phone_status` 显示 `641c3558 unauthorized`。

**处理**：手机解锁 → 屏幕上点「允许 USB 调试」→ 再查一次。
没有弹窗就在「开发者选项」里撤销 USB 调试授权后重新插拔。

---

### D4. `phone_dump` 返回 0 个元素

**原因**：微信这类 App 是自绘界面，不暴露无障碍节点。

**处理**：改用 `phone_screenshot` + 视觉理解。两者互补：
有结构化节点时用 dump（能按文字点），否则用截图。

---

## E. 编码与环境

### E1. 中文乱码

三个常见来源：

| 场景 | 原因 | 处理 |
|---|---|---|
| `.bat` 里中文乱码 | 文件是 UTF-8 存的，cmd 按 GBK 读 | 存成 **GBK + CRLF** |
| Python 输出乱码 | Windows 下 stdout 默认 GBK | `python -X utf8` + `PYTHONIOENCODING=utf-8` |
| 控制台显示乱码但数据正确 | PowerShell 解码方式 | 用 `-Encoding UTF8` 读文件，或 `[Console]::OutputEncoding` |

### E2. 语音转写结果全是乱码

**原因**：Node 按 UTF-8 读 Python 的 GBK 输出。

**处理**：见 DEPLOYMENT 10.8 的"两个必须注意的坑"——`-X utf8` + `PYTHONIOENCODING`。

---

### E3. 语音相关异常

| 现象 | 原因 | 处理 |
|---|---|---|
| 语音时长显示 `null` | 没装 ffmpeg | 装 ffmpeg，或配 `socialV2.voice.ffmpegPath` |
| 发语音报"功能已关闭" | 两个开关没开 | `socialV2.voice.enabled` + `socialV2.tools.sendVoice` |
| 语音库为空 | `audio/` 目录没文件 | 放 mp3/wav 等音频进去 |
| 收到语音只显示 `[语音]` | 本地 ASR 没装/没开 | 见 DEPLOYMENT 10.8 |

---

## F. 权限

### F1. 权限边界

当前设计（详见 README「手机操作（owner-only）」与 DEPLOYMENT 7.5.4）：

| 来源 | 手机 / 网易云 / QQ 空间 | 聊天 + 搜索 |
|---|---|---|
| `private:<ownerQQ>` | ✅ | ✅ |
| 白名单内其他 QQ 私聊 | ❌ | ✅ |
| 任何群聊 | ❌ | ✅ |
| DSH 桌面会话 | ✅ | ✅ |

**判据是 `ownerQQ`，不是 `allow.private`** ——往私聊白名单加人不会让他们获得手机权限。

**三层防线**：提示词规则（软拒绝）→ `qq-tool-restrict` 白名单 → 插件 agent 级 guard。
其中身份校验只能由 **agent 级 guard** 完成（预设里的 guard 拿到的 `exec` 只有 `{ name }`）。

**已知残余风险**：身份闸门依赖 `qqbot-supervisor` 插件。若插件被停用、而桥接仍在外部运行
（`external` 认领状态不会被 dispose 杀掉），预设侧无法校验身份，此时白名单内的 QQ 会话
都能调用手机工具。缓解：保持插件常开。

---

## G. 一句话总结的教训

1. **改代码后必须 grep 确认插入生效**，`node --check` 查不出"调用未定义函数"
2. **第三方包不能假设完整**——本项目遇到 2 个包共 3 个未定义函数
3. **安全边界要能 fail-closed，但先确认数据拿得到**，否则会误伤 owner
4. **生成物不要直接改**，改权威源再生成
5. **Windows 上编码是高频坑**：bat 用 GBK、python 强制 UTF-8
6. **DSH 的插件开关是"改列表"而不是"卸载"**，host-only 插件必须自己感知

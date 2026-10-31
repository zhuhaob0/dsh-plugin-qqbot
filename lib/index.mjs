// qqbot-supervisor —— DSH 插件（骨架版 v2）
//
// 职责：托管 qq-bridge 这个**外部进程**——启动、探活、崩溃重启、退出清理，
//       并把状态暴露成工具。它不重写桥接逻辑，桥接仍是独立 node 进程。
//
// 关键点：宿主端口通过 DSH_BASE_URL 环境变量注入给子进程（已实测 qq-bridge 支持），
//        因此**永远不需要改 config.json**，也就不存在“配置停在旧端口”的问题。
//
// 工具契约（从宿主 asar 里确认过）：
//   ctx.tools.register({
//     name, description,
//     parameters: { <字段>: { type, required?, description } },   // 字段表，不是 JSON Schema
//     output: { schema: <JSON Schema>, render: (args, value) => [{ type:'text', text }] },
//     execute: async (args, exec) => value,
//   })

import { spawn, execFile } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import Schema from '@deepseek-ai/schemastery'

export const name = 'qqbot-supervisor'
export const inject = ['tools']
/** 插件页可编辑的配置：enabled 就是「启用」开关，改动会触发 cordis 重新 apply */
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('启用后自动拉起 SnowLuma 与 qq-bridge；取消勾选会立即停掉这两个进程'),
  manageSnowLuma: Schema.boolean().default(true).description('是否托管 SnowLuma（关闭则只托管 qq-bridge）'),
  bridgeDir: Schema.string().default('E:\\Code\\qqbridge-v2').description('桥接所在目录'),
  bridgeScript: Schema.string().default('src/index.js').description('桥接入口脚本（相对 bridgeDir）'),
  bridgeArgs: Schema.array(Schema.string()).default(['--config', 'config.json']).description('桥接启动参数'),
  logFile: Schema.string().default('state/v2.out.log').description('桥接日志文件（相对 bridgeDir）'),
  snowLumaDir: Schema.string().default('D:\\Software\\QQBot\\SnowLuma-v2.1.1').description('SnowLuma 所在目录'),
  consolePort: Schema.natural().default(3100).description('桥接控制台端口'),
  snowLumaPort: Schema.natural().default(3001).description('SnowLuma OneBot WS 端口'),
})

const DEFAULTS = {
  bridgeDir: 'E:\\Code\\qqbridge-v2',
  bridgeScript: 'src/index.js',
  bridgeArgs: ['--config', 'config.json'],
  logFile: 'state/v2.out.log',
  consolePort: 3100,
  hostPort: 0,            // >0 时强制使用这个端口
  autoStart: true,
  enabled: true,        // 插件页的「启用」开关：(取消勾选) 会停掉 SnowLuma 与桥接
  // SnowLuma 托管：开桌面版即自动拉起它（EULA 上属于本地启动已安装副本，由你自行决定）
  manageSnowLuma: true,
  snowLumaDir: 'D:\\Software\\QQBot\\SnowLuma-v2.1.1',
  snowLumaNode: '',
  snowLumaPort: 3001,
  nodePath: '',           // 空 = 用 PATH 里的 node
  restartBaseMs: 2000,
  restartMaxMs: 120000,
  maxRestarts: 10,
  logTailLines: 200,
}

let LOG_FILE = null
function log(msg) {
  const line = `[qqbot-supervisor] ${msg}`
  console.error(line)   // dsh web 时会进 stderr；桌面版看不到，所以另外落文件
  try {
    if (!LOG_FILE) {
      LOG_FILE = path.join(DEFAULTS.bridgeDir, 'state', 'launcher', 'plugin.log')
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    }
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.1')
    }
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch { /* 日志失败不影响主流程 */ }
}

/** 读 profile 的 package.json，判断本插件是否还在 bundles 里（DSH 的插件开关就是改这个列表） */
function isBundleEnabled() {
  try {
    const dir = process.env.DSH_PROFILE_DIR
      || (process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh')) + '/profiles/desktop'
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    const bundles = pkg?.dsh?.profile?.bundles
    if (!Array.isArray(bundles)) return true   // 读不到就当作启用，避免误杀
    return bundles.includes('qqbot-supervisor')
  } catch {
    return true
  }
}
function portOpen(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port })
    let done = false
    const fin = (v) => { if (!done) { done = true; sock.destroy(); resolve(v) } }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => fin(true))
    sock.once('timeout', () => fin(false))
    sock.once('error', () => fin(false))
  })
}

/** 候选宿主端口（按可信度排序）：显式配置 → 启动参数 → 本进程监听句柄 → DSH_WEB_URL → 3080 */
function candidatePorts(config) {
  const out = []
  const push = (p) => {
    const n = Number(p)
    if (Number.isFinite(n) && n > 0 && n < 65536 && !out.includes(n)) out.push(n)
  }

  if (config.hostPort > 0) push(config.hostPort)

  const i = process.argv.indexOf('--port')
  if (i > 0) push(process.argv[i + 1])

  // 本进程自己的 listening server（桌面版随机端口时靠这个）
  try {
    for (const h of process._getActiveHandles?.() ?? []) {
      try {
        const addr = h?.address?.()
        if (addr && typeof addr === 'object' && addr.port) push(addr.port)
      } catch { /* 不是 server */ }
    }
  } catch { /* 忽略 */ }

  const m = /:(\d+)/.exec(process.env.DSH_WEB_URL || '')
  if (m) push(m[1])

  push(3080)
  return out
}

class Supervisor {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = { ...DEFAULTS, ...(config || {}) }
    this.child = null
    this.state = 'stopped'      // stopped | starting | ready | external | failed
    this.pid = null
    this.startedAt = null
    this.restarts = 0
    this.lastExit = null
    this.lastError = null
    this.disposed = false
    this.restartTimer = null
    this.logs = []
    this.hostPort = 0
    this.snow = null
    this.snowState = 'stopped'
    this.snowPid = null
  }

  get baseUrl() { return `http://127.0.0.1:${this.hostPort}` }

  pushLog(line) {
    this.logs.push(line)
    const max = Math.max(20, Number(this.config.logTailLines) || 200)
    if (this.logs.length > max) this.logs.splice(0, this.logs.length - max)
  }

  snapshot(extra = {}) {
    return {
      state: this.state,
      host: this.hostPort ? this.baseUrl : null,
      pid: this.pid,
      startedAt: this.startedAt,
      restarts: this.restarts,
      lastExit: this.lastExit,
      lastError: this.lastError,
      bridgeDir: this.config.bridgeDir,
      consolePort: Number(this.config.consolePort),
      snowluma: { state: this.snowState, pid: this.snowPid, port: Number(this.config.snowLumaPort) },
      ...extra,
    }
  }

  /** 选一个真正在监听的宿主端口 */
  async detectHostPort() {
    const ports = candidatePorts(this.config)
    for (const p of ports) {
      if (await portOpen(p)) {
        this.hostPort = p
        log(`宿主端口判定为 ${p}（候选顺序 ${ports.join(', ')}）`)
        return p
      }
    }
    this.hostPort = ports[0] ?? 3080
    log(`没有候选端口在监听，回退 ${this.hostPort}`)
    return this.hostPort
  }

  async waitPort(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await portOpen(port)) return true
      await new Promise((r) => { const t = setTimeout(r, 800); t.unref?.() })
    }
    return false
  }

  /** 确保 SnowLuma 在跑（没跑就拉起；已在跑就保持不动） */
  async ensureSnowLuma() {
    if (!this.config.manageSnowLuma) return
    if (this.disposed) return
    if (await portOpen(Number(this.config.snowLumaPort))) {
      if (this.snowState !== 'external') log(`SnowLuma 已在运行（${this.config.snowLumaPort}），保持不动`)
      this.snowState = 'external'
      return
    }
    return this.startSnowLuma()
  }

  /** 是否已有 SnowLuma 进程在跑（按命令行匹配，不看端口——它可能正在初始化） */
  snowLumaProcessExists() {
    return new Promise((resolve) => {
      const q = 'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Where-Object { $_.CommandLine -match \'SnowLuma.*index\\.mjs\' } | Select-Object -First 1 -ExpandProperty ProcessId'
      try {
        execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', q], { timeout: 8000, windowsHide: true }, (err, stdout) => {
          if (err) return resolve(false)
          resolve(/^\s*\d+/m.test(String(stdout || '')))
        })
      } catch { resolve(false) }
    })
  }

  async startSnowLuma() {
    if (this.disposed) return
    if (this.snow) return
    const dir = String(this.config.snowLumaDir || '')
    const nodeExe = this.config.snowLumaNode || path.join(dir, 'node.exe')
    if (!dir || !fs.existsSync(nodeExe)) {
      this.snowState = 'failed'
      log(`找不到 SnowLuma 运行时：${nodeExe}`)
      return
    }
    // 端口还没起来不代表没有实例（它可能正在登录/初始化），
    // 所以再查一遍命令行，避免拉起第二份抢不到端口的空壳。
    if (await this.snowLumaProcessExists()) {
      this.snowState = 'external'
      log('检测到已有 SnowLuma 进程（命令行匹配），不重复启动')
      return
    }
    this.snowState = 'starting'
    try {
      const child = spawn(nodeExe, ['index.mjs'], { cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      this.snow = child
      this.snowPid = child.pid
      const relay = (buf) => {
        for (const line of String(buf).split(/\r?\n/)) {
          if (line.trim()) log(`[snowluma] ${line.trim()}`)
        }
      }
      child.stdout?.on('data', relay)
      child.stderr?.on('data', relay)
      child.once('error', (e) => { this.snowState = 'failed'; log(`SnowLuma spawn 失败：${e?.message ?? e}`) })
      child.once('exit', (code, signal) => {
        this.snow = null
        this.snowPid = null
        if (this.disposed) { this.snowState = 'stopped'; return }
        this.snowState = 'failed'
        log(`SnowLuma 退出 code=${code} signal=${signal}`)
      })
      log(`已启动 SnowLuma pid=${child.pid}`)
      const ok = await this.waitPort(Number(this.config.snowLumaPort), 90000)
      this.snowState = ok ? 'ready' : 'starting'
      if (ok) log(`SnowLuma 就绪（${this.config.snowLumaPort}）`)
    } catch (e) {
      this.snowState = 'failed'
      log(`启动 SnowLuma 失败：${e?.message ?? e}`)
    }
  }

  stopSnowLuma() {
    const pid = this.snow?.pid ?? this.snowPid
    this.snow = null
    this.snowPid = null
    if (!pid) return
    try {
      if (process.platform === 'win32') execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {})
      else this.snow?.kill?.('SIGTERM')
    } catch { /* 忽略 */ }
    this.snowState = 'stopped'
    log(`已停止 SnowLuma pid=${pid}`)
  }
  async ensure() {
    if (this.disposed) return this.snapshot()
    if (!this.hostPort) await this.detectHostPort()

    await this.ensureSnowLuma()

    if (await portOpen(Number(this.config.consolePort))) {
      this.state = 'external'
      log(`检测到 ${this.config.consolePort} 已被占用，按「外部实例」认领，不重复启动`)
      return this.snapshot()
    }
    return this.start()
  }

  async start() {
    if (this.disposed) return this.snapshot()
    if (this.child) return this.snapshot()

    // 竞态保护：外部（脚本/start.bat）可能刚好抢先绑定，这里再确认一次
    if (await portOpen(Number(this.config.consolePort))) {
      this.state = 'external'
      log(`启动前发现 ${this.config.consolePort} 已被占用，转为认领外部实例`)
      return this.snapshot()
    }

    const nodeExe = this.config.nodePath || 'node'
    const env = { ...process.env, DSH_BASE_URL: this.baseUrl }

    this.state = 'starting'
    try {
      const child = spawn(nodeExe, [this.config.bridgeScript ?? 'src/index.js', ...(this.config.bridgeArgs ?? [])], {
        cwd: this.config.bridgeDir,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      this.child = child
      this.pid = child.pid
      this.startedAt = new Date().toISOString()

      const onLine = (buf) => {
        for (const line of String(buf).split(/\r?\n/)) {
          if (!line.trim()) continue
          this.pushLog(line)
          if (/DSH 已就绪|DSH 不可用|invalid JSON|writer-held|已有实例在运行|Error:|"level":"error"/.test(line)) {
            this.lastError = line.trim()
          }
        }
      }
      child.stdout?.on('data', onLine)
      child.stderr?.on('data', onLine)

      child.once('error', (err) => {
        this.lastError = `spawn 失败：${err?.message ?? err}`
        this.state = 'failed'
        log(this.lastError)
      })

      child.once('exit', (code, signal) => {
        const wasDisposed = this.disposed
        this.lastExit = { code, signal, at: new Date().toISOString() }
        this.child = null
        this.pid = null
        if (wasDisposed) { this.state = 'stopped'; return }
        // 单实例锁：说明另一个实例（脚本/start.bat）已经在跑，认领它而不是死循环重启
        if (code === 2 || /已有实例在运行/.test(this.lastError || '')) {
          this.state = 'external'
          log('桥接报告「已有实例在运行」，转为认领外部实例，不再重启')
          return
        }
        log(`桥接退出 code=${code} signal=${signal}，准备重启`)
        this.scheduleRestart()
      })

      log(`已启动桥接 pid=${child.pid}，DSH_BASE_URL=${this.baseUrl}`)
      this.state = 'ready'
      return this.snapshot()
    } catch (error) {
      this.state = 'failed'
      this.lastError = `启动桥接失败：${error?.message ?? error}`
      log(this.lastError)
      return this.snapshot()
    }
  }

  scheduleRestart() {
    if (this.disposed) return
    if (this.restarts >= this.config.maxRestarts) {
      this.state = 'failed'
      this.lastError = `连续重启 ${this.restarts} 次仍失败，停止重试`
      log(this.lastError)
      return
    }
    const delay = Math.min(
      this.config.restartBaseMs * Math.pow(2, this.restarts),
      this.config.restartMaxMs,
    )
    this.restarts += 1
    this.state = 'starting'
    log(`${delay}ms 后第 ${this.restarts} 次重启`)
    this.restartTimer = setTimeout(() => { this.restartTimer = null; this.start() }, delay)
    this.restartTimer.unref?.()
  }

  /** 看门狗：定期检查，掉线就补拉起（SnowLuma 只在启动时检查是不够的） */
  async watch() {
    if (this.disposed) return
    if (this.config.manageSnowLuma && this.snowState !== 'ready' && this.snowState !== 'external') {
      if (!(await portOpen(Number(this.config.snowLumaPort)))) {
        log('看门狗：SnowLuma 不在线，尝试拉起')
        await this.ensureSnowLuma()
      } else {
        this.snowState = 'external'
      }
    }
    if (!this.child && this.state !== 'external' && this.state !== 'starting') {
      if (!(await portOpen(Number(this.config.consolePort)))) {
        log('看门狗：桥接不在线，尝试拉起')
        await this.ensure()
      }
    }
  }
  /** 被「插件开关」关掉后再打开时复位，允许重新启动 */
  revive() {
    this.disposed = false
    this.state = 'stopped'
    this.restarts = 0
  }
  async restart() {
    await this.stop()
    this.restarts = 0
    if (!this.hostPort) await this.detectHostPort()
    return this.start()
  }

  async stop() {
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null }
    const child = this.child
    this.child = null
    const pid = child?.pid ?? this.pid
    this.pid = null
    this.state = 'stopped'
    if (!pid) return
    try {
      if (process.platform === 'win32') {
        await new Promise((r) => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => r()))
      } else {
        child?.kill('SIGTERM')
      }
    } catch { /* 忽略 */ }
    log(`已停止桥接 pid=${pid}`)
  }

  dispose() {
    this.disposed = true
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null }
    const pid = this.child?.pid ?? this.pid
    if (pid) {
      try {
        if (process.platform === 'win32') {
          execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {})
        } else {
          this.child?.kill('SIGTERM')
        }
      } catch { /* 忽略 */ }
    }
    this.child = null
    this.pid = null
    this.state = 'stopped'
    try { this.stopSnowLuma() } catch { /* 忽略 */ }
  }
}

/**
 * 统一包装成宿主要求的工具定义。
 * 关键：parameters 必须是**完整 JSON Schema**（type: 'object'），
 * 插件 ctx 里的 tools.register 不会做 DSL 归一化（那是 defineTool 的职责）。
 * 传字段表 DSL 会让顶层 type 变成 null，进而让**所有**请求被 provider 拒绝。
 */
function toolDef(name, description, properties, required, run) {
  const parameters = {
    type: 'object',
    properties: properties ?? {},
    ...(Array.isArray(required) && required.length ? { required } : {}),
  }
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async (args, exec) => run(args || {}, exec),
  }
}

export function apply(ctx, config) {
  const sup = new Supervisor(ctx, config)
  log('收到配置: enabled=' + String(sup.config.enabled) + ' manageSnowLuma=' + String(sup.config.manageSnowLuma) + ' autoStart=' + String(sup.config.autoStart))
  const bundleOn = isBundleEnabled()
  const startNow = sup.config.enabled !== false && bundleOn
  if (!startNow) { log('当前为停用状态（enabled=false 或插件开关关闭）：不自动启动，仅保留开关监听'); try { sup.dispose() } catch { /* 忽略 */ } }
  log(`插件已加载（等待探活）bridgeDir=${sup.config.bridgeDir} autoStart=${sup.config.autoStart} bundleOn=${bundleOn}`)

  const tools = []
  tools.push(toolDef(
    'qqbot_status',
    '查看 qq-bridge 的托管状态：进程、PID、重启次数、宿主地址、最近错误与日志尾部。',
    { logLines: { type: 'number', description: '附带最近多少行日志，默认 20，最多 200' } }, [],
    async (args) => {
      const n = Math.max(0, Math.min(200, Number(args.logLines ?? 20)))
      return JSON.stringify(sup.snapshot({ logs: n ? sup.logs.slice(-n) : [] }), null, 2)
    },
  ))

  tools.push(toolDef(
    'qqbot_restart',
    '重启 qq-bridge 进程（先杀进程树，再以当前宿主端口重新拉起）。',
    {}, [],
    async () => JSON.stringify(await sup.restart(), null, 2),
  ))

  tools.push(toolDef(
    'qqbot_logs',
    '读取桥接日志文件的尾部若干行（v2 默认 state/v2.out.log）。',
    { lines: { type: 'number', description: '行数，默认 50，最多 500' } }, [],
    async (args) => {
      const n = Math.max(1, Math.min(500, Number(args.lines ?? 50)))
      const file = path.join(sup.config.bridgeDir, sup.config.logFile ?? 'state/v2.out.log')
      try {
        const all = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
        return all.slice(-n).join('\n')
      } catch (e) {
        return `读取日志失败：${e?.message ?? e}`
      }
    },
  ))

  // 工具必须注册到每个 agent 的 ctx 上（宿主文档：agent/created 里拿 agent.ctx，
  // 用 agent.ctx.effect() 包一层，agent 销毁时自动移除）。注册在插件自己的 ctx 上
  // 不会出现在任何会话的工具表里——这是踩过的坑。
  // ── 手机工具的 owner 校验 ────────────────────────────────────────────────
// 桥接的 state/sessions.json 提供 QQ号 <-> DSH 会话ID 映射，ownerQQ 在 config.json。
// 规则：只有 private:<ownerQQ> 会话可调用 mcp__phone__*；其它 QQ 会话一律拒绝；
//       非 QQ 会话（桌面）不受限制。
let identityCache = { at: -1, ownerQQ: '', bySession: new Map() }

function loadBridgeIdentity(bridgeDir) {
  const cfgPath = path.join(bridgeDir, 'config.json')
  const sesPath = path.join(bridgeDir, 'state', 'sessions.json')
  let stamp = 0
  try { stamp = fs.statSync(cfgPath).mtimeMs } catch {}
  try { stamp = Math.max(stamp, fs.statSync(sesPath).mtimeMs) } catch {}
  if (stamp === identityCache.at) return identityCache
  const out = { at: stamp, ownerQQ: '', bySession: new Map(), allowedPrivate: new Set() }
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    out.ownerQQ = String(cfg.ownerQQ ?? '')
    const list = cfg.allow?.private ?? cfg.allow?.privates ?? []
    for (const item of list) {
      const n = String(item).trim()
      if (/^\d+$/.test(n)) out.allowedPrivate.add(n.replace(/^0+(?=\d)/, ''))
    }
  } catch {}
  try {
    const map = JSON.parse(fs.readFileSync(sesPath, 'utf8')).sessions ?? {}
    for (const key of Object.keys(map)) {
      const sid = map[key]
      if (typeof sid === 'string') out.bySession.set(sid, key)
    }
  } catch {}
  identityCache = out
  return out
}

const QZONE_SOCIAL_TOOLS = new Set([
  'mcp__phone__qzone_feeds',
  'mcp__phone__qzone_like',
  'mcp__phone__qzone_recent_like',
  'mcp__phone__qzone_my_posts',
  'mcp__phone__qzone_user_posts',
  'mcp__phone__qzone_comment',
])

function phoneGuard(bridgeDir, agent) {
  return (exec) => {
    const toolName = String(exec && exec.name ? exec.name : '')
    if (toolName.indexOf('mcp__phone__') !== 0) return
    let id
    try { id = loadBridgeIdentity(bridgeDir) } catch { return '手机工具校验失败，已拒绝' }
    const sessionId = String((exec && exec.session && exec.session.id) || (exec && exec.sessionId) || (agent && agent.id) || '')
    const key = id.bySession.get(sessionId)
    try { log('手机工具调用: name=' + toolName + ' sid=' + sessionId + ' key=' + (key || '-') + ' owner=' + (id.ownerQQ || '-')) } catch {}
    if (!key) return
    if (id.ownerQQ && key === ('private:' + id.ownerQQ)) return
    // 白名单私聊：仅放行「看空间 / 点赞」这类社交工具，不放开手机控制
    if (QZONE_SOCIAL_TOOLS.has(toolName)) {
      const m = /^private:(\d+)$/.exec(key)
      if (m && id.allowedPrivate.has(m[1])) return
    }
    return '手机操作仅限 owner 的 QQ 私聊；当前会话 ' + key + ' 无权调用'
  }
}
const handledAgents = new WeakSet()
  const ensureTools = (agent) => {
    if (!agent || typeof agent !== 'object') return
    if (handledAgents.has(agent)) return
    handledAgents.add(agent)
    try {
      const register = () => {
        const disposers = []
        for (const def of tools) {
          try {
            disposers.push(agent.ctx.tools.register(def))
          } catch (e) {
            const msg = String(e?.message ?? e)
            // 热重载时旧实例的注册还挂在同一个 agent 上，重复注册会抛错；
            // 工具本身可用，视为成功，等 agent 销毁时自然清理。
            if (/already registered/i.test(msg)) disposers.push(() => {})
            else log(`工具 ${def.name} 注册失败：${msg}`)
          }
        }
        log(`已为 agent 注册 ${disposers.length} 个工具`)
        // 手机工具的 owner 校验（挂在同一个 agent ctx 上，agent 销毁时一起撤）
        try {
          const gd = agent.ctx.tools.guard(phoneGuard(sup.config.bridgeDir, agent))
          if (typeof gd === 'function') disposers.push(gd)
          log('手机工具 owner 校验已挂载')
        } catch (e) {
          log('手机工具 owner 校验挂载失败：' + (e?.message ?? e))
        }
        return () => { for (const d of disposers) { try { d?.() } catch { /* 忽略 */ } } }
      }
      if (typeof agent.ctx?.effect === 'function') agent.ctx.effect(register)
      else register()
    } catch (e) {
      log(`agent 工具注册异常：${e?.message ?? e}`)
    }
  }
  ctx.on('agent/created', (p) => ensureTools(p?.agent ?? p))
  // 兜底：热重载/会话恢复时 agent 已存在，不会重放 created；status 每轮都会触发
  ctx.on('agent/status', (p) => ensureTools(p?.agent ?? p))
  let watchdog = null
  if (sup.config.autoStart && startNow) {
    setTimeout(() => { sup.ensure().catch((e) => log(`自动启动失败：${e?.message ?? e}`)) }, 0).unref?.()
    watchdog = setInterval(() => { sup.watch().catch((e) => log(`看门狗异常：${e?.message ?? e}`)) }, 30000)
    watchdog.unref?.()
  }

  // 插件开关联动：DSH 的启用/停用只改 bundles 列表（host-only bundle 不热卸载），
  // 这里自己盯住那个列表，被移除就停掉进程，被加回就重新拉起。
  let bundleTimer = null
  let lastEnabled = isBundleEnabled()
  bundleTimer = setInterval(() => {
    try {
      const now = isBundleEnabled()
      if (now === lastEnabled) return
      lastEnabled = now
      if (!now) {
        log('检测到插件已被停用（移出 bundles）：停止 SnowLuma 与桥接')
        if (watchdog) { clearInterval(watchdog); watchdog = null }
        sup.dispose()
      } else {
        log('检测到插件已重新启用（回到 bundles）：重新拉起服务')
        sup.revive()
        sup.ensure().catch((e) => log('重新启用失败：' + (e?.message ?? e)))
        if (!watchdog) watchdog = setInterval(() => { sup.watch().catch(() => {}) }, 30000)
        watchdog.unref?.()
      }
    } catch (e) { log('开关轮询异常：' + (e?.message ?? e)) }
  }, 2000)
  bundleTimer.unref?.()

  ctx.on?.('dispose', () => {
    if (watchdog) clearInterval(watchdog)
    if (bundleTimer) clearInterval(bundleTimer)
    sup.dispose()
  })

  return { supervisor: sup }
}

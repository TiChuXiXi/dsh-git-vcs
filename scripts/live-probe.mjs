/**
 * 真机联调探针（live-probe）—— **诊断工具，不是自检**。
 *
 * 在**隔离的 DSH_HOME** 里用完整 web 组合（base + web-app + 本插件）起一个真实实例，再用
 * headless Chrome 打开真实页面（带启动 token 的 URL），打印三件事供人工判读：
 *   1. 启动日志里本插件的行（host 半区激活 / RPC 通道已注册）；
 *   2. 前端是否挂载（标题 + 可见文本概览）；
 *   3. 页面里与「版本管理」相关的可交互元素（右侧栏 tab 入口）。
 *
 * 为什么它不判红：真机上「进到会话界面 → 展开右侧栏 → 点开版本管理」这条链路依赖首启流程与
 * 右侧栏 DOM 的细节，做成硬断言会长期假红（首启弹层没点掉时，页面上根本没有 tab 入口）。
 * 装配层的问题（例如 DSH 0.1.7 把「当前会话」从 `SessionListState.current` 换成标准 prop
 * `sessionId`）用这里的输出人工看一眼最快；硬断言交给 render-probe / dom-probe（夹具）与
 * web-rpc-probe（免认证的 RPC 通路）。
 *
 * 用法：node scripts/live-probe.mjs [--keep]
 *   --keep  保留隔离 DSH_HOME 与日志（排查用）
 * 依赖：本机有 Chrome/Edge；端口 3211（DSH）与 9339（CDP）没被占用。
 * 注意：沙箱禁止命名管道时 Chrome 会 FATAL，需在放宽权限（danger-full-access）或沙箱外运行。
 */
import { cpSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'))
const PORT = Number(process.env.LIVE_PROBE_PORT ?? 3211)
const CDP_PORT = Number(process.env.LIVE_PROBE_CDP ?? 9339)
const KEEP = process.argv.includes('--keep')

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const browser = BROWSERS.find((path) => path !== '' && existsSync(path))
if (browser === undefined) {
  console.log('跳过：本机没找到 Chrome/Edge（真机联调探针需要浏览器）')
  process.exit(0)
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/* ---------------------------------------------------------------- 隔离实例 */

const home = join(tmpdir(), `dsh-live-${process.pid}-${Date.now()}`)
const profileDir = join(home, 'profiles', 'live')
mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
  name: 'dsh-profile-live',
  private: true,
  dependencies: { 'dsh-git-vcs': `link:${ROOT.replace(/\\/g, '/')}` },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-git-vcs'] } },
}, null, 2)}\n`)
// 跨盘符的 link: 会生成坏 junction（见 README「跨盘符安装坑」），这里直接复制一份真实产物。
cpSync(ROOT, join(profileDir, 'node_modules', 'dsh-git-vcs'), {
  recursive: true,
  filter: (src) => {
    const rel = relative(ROOT, src).replace(/\\/g, '/')
    if (rel === '') return true
    const segments = rel.split('/')
    if (segments.includes('node_modules')) return false
    return !(segments[0] === '.git' || segments[0] === '.opencode' || segments[0] === '.npm-cache' || segments[0] === '.idea')
  },
})

const logPath = join(home, 'boot.log')
const fd = openSync(logPath, 'w')
const server = spawn('dsh', ['--profile', 'live', '--port', String(PORT), '--no-open'], {
  env: { ...process.env, DSH_HOME: home, DSH_WEB_PORT: String(PORT) },
  // 会话工作目录 = 本仓库（它是 git 仓库，面板打开后应当自动认出来）
  cwd: ROOT,
  stdio: ['ignore', fd, fd],
  shell: process.platform === 'win32',
})

let chrome = null
const finish = (code) => {
  try { server.kill('SIGKILL') } catch { /* 已经退出 */ }
  if (chrome !== null) { try { chrome.kill('SIGKILL') } catch { /* 已经退出 */ } }
  try { closeSync(fd) } catch { /* 已经关掉 */ }
  console.log(`\n隔离 DSH_HOME：${home}${KEEP ? '（保留）' : '（即将删除）'}`)
  if (!KEEP) setTimeout(() => { try { rmSync(home, { recursive: true, force: true }) } catch { /* 被占用就留着 */ } }, 500)
  process.exit(code)
}

try {
  let url = null
  for (let i = 0; i < 60; i += 1) {
    await sleep(1000)
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/`, { method: 'GET', redirect: 'manual' })
      if (response.status !== 404) {
        const match = /dsh web:\s*(\S+)/.exec(readFileSync(logPath, 'utf8'))
        if (match !== null) { url = match[1]; break }
      }
    } catch { /* 还没起 */ }
  }
  if (url === null) {
    console.log('实例没起来（或没打印带 token 的 URL）。日志尾部：')
    console.log(readFileSync(logPath, 'utf8').split('\n').slice(-25).join('\n'))
    finish(1)
  }
  console.log(`实例已就绪：${url.replace(/token=[^&]*/, 'token=***')}`)

  chrome = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--mute-audio', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(home, 'chrome')}`, url,
  ], { stdio: 'ignore', windowsHide: true })

  let ws = null
  for (let i = 0; i < 40 && ws === null; i += 1) {
    await sleep(500)
    try {
      const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((response) => response.json())
      const target = list.find((item) => item.type === 'page' && String(item.url).includes(`127.0.0.1:${PORT}`))
      if (target !== undefined) ws = target.webSocketDebuggerUrl
    } catch { /* 还没起 */ }
  }
  if (ws === null) {
    console.log('浏览器没连上（CDP 没有页面 target）')
    finish(1)
  }

  const evaluate = (expression) => new Promise((resolve, reject) => {
    const socket = new WebSocket(ws)
    const timer = setTimeout(() => { socket.close(); resolve(undefined) }, 20000)
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== 1) return
      clearTimeout(timer)
      socket.close()
      const detail = message.result?.exceptionDetails
      if (detail !== undefined) { reject(new Error(`${detail.text} ${detail.exception?.description ?? ''}`.slice(0, 400))); return }
      resolve(message.result?.result?.value)
    }
  })

  for (let i = 0; i < 40; i += 1) {
    const ready = await evaluate(`document.body !== null && document.body.innerText.trim().length > 0`)
    if (ready === true) break
    await sleep(500)
  }
  await sleep(3000)

  console.log('\n---- 启动日志里本插件的行 ----')
  const log = readFileSync(logPath, 'utf8')
  const pluginLines = log.split('\n').filter((line) => /dsh-git-vcs|git-vcs/.test(line))
  console.log(pluginLines.length === 0 ? '（一行都没有：插件没进组合或加载失败）' : pluginLines.slice(0, 10).join('\n'))

  console.log('\n---- 页面概览 ----')
  console.log(await evaluate(`JSON.stringify({
    title: document.title,
    ready: document.readyState,
    text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 600),
  }, null, 2)`))

  console.log('\n---- 与「版本管理」相关的可交互元素 ----')
  console.log(await evaluate(`JSON.stringify([...document.querySelectorAll('button,a,[role="tab"],[role="button"],[title],[aria-label]')]
    .map((node) => ({
      tag: node.tagName,
      text: (node.textContent || '').trim().slice(0, 24),
      title: node.getAttribute('title'),
      aria: node.getAttribute('aria-label'),
    }))
    .filter((item) => item.text !== '' || item.title !== null || item.aria !== null)
    .slice(0, 50), null, 2)`))

  console.log('\n提示：真机上要看到面板，先点掉首启弹层（「继续」）进到会话界面，再展开右侧栏、')
  console.log('      从 tab 条的「+」或引导页胶囊里打开「版本管理」。')
  finish(0)
} catch (cause) {
  console.error(`live-probe 异常：${cause instanceof Error ? cause.stack : String(cause)}`)
  finish(1)
}

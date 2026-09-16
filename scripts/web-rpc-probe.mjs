/**
 * 一次性诊断：在隔离的 DSH_HOME 里用**完整 web 组合**（base + web-app + 本插件）起一个临时实例，
 * 抓插件的 host 日志，并对 /git-vcs 路由做一次免认证探测：
 *   路由存在 → 连接服务会回 401/403（未认证）；路由不存在 → 静态兜底回 405。
 * 用 --port 3199 与用户正在跑的实例隔离。
 *
 * 用法：node scripts/web-rpc-probe.mjs [插件目录]
 *   不传参数时用本仓库源码；传参数可以指向**从 npm 装下来的那份**
 *   （例如 ~/.dsh/profiles/web/node_modules/dsh-git-vcs），用来验证"别人装到的版本"能挂上。
 */
import { cpSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

const pluginDir = resolve(process.argv[2] ?? join(import.meta.dirname, '..'))
const testHome = join(tmpdir(), `dsh-probe-${process.pid}-${Date.now()}`)
const profileName = 'probe'
const profileDir = join(testHome, 'profiles', profileName)
const PORT = 3199

mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
  name: `dsh-profile-${profileName}`,
  private: true,
  dependencies: { 'dsh-git-vcs': `link:${pluginDir.replace(/\\/g, '/')}` },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-git-vcs'] } },
}, null, 2)}\n`)
cpSync(pluginDir, join(profileDir, 'node_modules', 'dsh-git-vcs'), {
  recursive: true,
  // 过滤用**相对 pluginDir 的路径**：早先按绝对路径做子串匹配，导致传入的目录只要自己
  // 位于某个 node_modules 下（比如 npm 装下来的那份）就会连根目录一起被排除、什么都不复制。
  filter: (src) => {
    const rel = relative(pluginDir, src).replace(/\\/g, '/')
    if (rel === '') return true
    const segments = rel.split('/')
    if (segments.includes('node_modules')) return false
    return !(segments[0] === '.git' || segments[0] === '.opencode' || segments[0] === '.npm-cache')
  },
})

// 可选实验：给 connection 行补 webServer（验证 “注册路由读的是 connection 自己的 ctx” 这一假设）
if (process.env.PROBE_PATCH_CONNECTION === '1') {
  writeFileSync(join(profileDir, 'cordis.patch.yml'), [
    '# probe experiment',
    '- id: connection',
    '  inject: [webRuntime, webServer]',
    '',
  ].join('\n'))
  console.log('（实验：profile 层给 connection 行补了 webServer）')
}

const logPath = join(testHome, 'boot.log')
const fd = openSync(logPath, 'w')
const child = spawn('dsh', ['--profile', profileName, '--port', String(PORT)], {
  env: { ...process.env, DSH_HOME: testHome, DSH_WEB_PORT: String(PORT) },
  cwd: testHome,
  stdio: ['ignore', fd, fd],
  shell: process.platform === 'win32',
})

console.log(`隔离 DSH_HOME：${testHome}`)
console.log(`等待 ${PORT} 端口上的应用真正服务（最多 40s）…`)
let up = false
for (let i = 0; i < 40; i += 1) {
  await new Promise((settle) => setTimeout(settle, 1000))
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/`, { method: 'GET' })
    // 应用没起来时兜底还没注册，任何路径都 404；等到非 404 才算就绪。
    if (response.status !== 404) { up = true; console.log(`第 ${i + 1}s：GET / → HTTP ${response.status}，应用已就绪`); break }
  } catch { /* 还没起 */ }
}
if (!up) console.log('应用一直没就绪（看下面日志）')

for (const [label, init] of [
  ['POST /git-vcs/repo/snapshot（未认证）', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":"client-request","rpcId":"probe","method":"repo/snapshot","payload":{}}' }],
  ['POST /api/__probe（对照：已知存在的共享通道）', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }],
]) {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}${label.includes('/api/') ? '/api/__probe' : '/git-vcs/repo/snapshot'}`, init)
    console.log(`${label} → HTTP ${response.status} ${JSON.stringify((await response.text()).slice(0, 80))}`)
  } catch (cause) {
    console.log(`${label} → 失败：${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

child.kill('SIGKILL')
await new Promise((settle) => setTimeout(settle, 500))
closeSync(fd)
const log = readFileSync(logPath, 'utf8')
console.log('---- 日志里与本插件 / 报错相关的行 ----')
const lines = log.split('\n').filter((line) => /dsh-git-vcs|git-vcs|RPC|error|Error|listen|port/i.test(line))
console.log(lines.slice(0, 40).join('\n'))
try { rmSync(testHome, { recursive: true, force: true }) } catch { /* 被占用就留着 */ }
